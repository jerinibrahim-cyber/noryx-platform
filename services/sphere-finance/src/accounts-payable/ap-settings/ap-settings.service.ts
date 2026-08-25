import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { apSettings, chartOfAccounts, type ApSettings } from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { UpsertApSettingsDto } from "./dto/upsert-ap-settings.dto";

/**
 * AP settings — AP-1a (docs/finance-work-item-1-ap-foundation-proposal.md
 * §5, §16). One configuration row per (tenantId, legalEntityId) —
 * composite primary key, not a synthetic id — holding the AP control
 * account (and optional tax-input account) AP-1b's bill posting will
 * later debit/credit. AP-1a only creates/reads this configuration;
 * nothing here posts against it.
 *
 * Same RLS/legal-entity-predicate/withTenant conventions as
 * SuppliersService — see that file's doc comment for the reasoning,
 * unchanged here.
 */
@Injectable()
export class ApSettingsService {
  async upsert(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: UpsertApSettingsDto,
  ): Promise<ApSettings> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateControlAccountOrThrow(
        tx,
        legalEntityId,
        dto.apControlAccountId,
      );
      if (dto.taxInputAccountId) {
        await this.validateTaxAccountOrThrow(
          tx,
          legalEntityId,
          dto.taxInputAccountId,
        );
      }

      const before = await this.findByScopeInTx(tx, tenantId, legalEntityId);

      const [row] = await tx
        .insert(apSettings)
        .values({
          tenantId,
          legalEntityId,
          apControlAccountId: dto.apControlAccountId,
          taxInputAccountId: dto.taxInputAccountId ?? null,
        })
        .onConflictDoUpdate({
          target: [apSettings.tenantId, apSettings.legalEntityId],
          set: {
            apControlAccountId: dto.apControlAccountId,
            taxInputAccountId: dto.taxInputAccountId ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: before ? "UPDATE" : "CREATE",
        entityType: "ap_settings",
        entityId: legalEntityId,
        beforeState: before
          ? (before as unknown as Record<string, unknown>)
          : null,
        afterState: row as unknown as Record<string, unknown>,
      });

      return row!;
    });
  }

  async findOne(tenantId: string, legalEntityId: string): Promise<ApSettings> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const row = await this.findByScopeInTx(tx, tenantId, legalEntityId);
      if (!row) {
        throw new NotFoundException(
          "AP settings have not been configured for this legal entity.",
        );
      }
      return row;
    });
  }

  private async findByScopeInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<ApSettings | undefined> {
    const rows = await tx
      .select()
      .from(apSettings)
      .where(
        and(
          eq(apSettings.tenantId, tenantId),
          eq(apSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** ap_control_account_id must exist, be active, belong to this legal
   * entity, and — because "AP control account" is unambiguously a
   * liability by definition — be of type LIABILITY (schema.ts's doc
   * comment on apSettings). */
  private async validateControlAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: chartOfAccounts.id, type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `apControlAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
    if (rows[0]!.type !== "LIABILITY") {
      throw new BadRequestException(
        `apControlAccountId ${accountId} must reference a LIABILITY account (found ${rows[0]!.type}).`,
      );
    }
  }

  /** tax_input_account_id must exist, be active, and belong to this
   * legal entity. Deliberately no type check — see schema.ts's doc
   * comment on apSettings.taxInputAccountId for why. */
  private async validateTaxAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `taxInputAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
  }
}
