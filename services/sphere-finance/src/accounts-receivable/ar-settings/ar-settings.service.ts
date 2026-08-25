import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { arSettings, chartOfAccounts, type ArSettings } from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { UpsertArSettingsDto } from "./dto/upsert-ar-settings.dto";

/**
 * AR settings — AR-1a
 * (docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §3, §5). One configuration row per (tenantId, legalEntityId) —
 * composite primary key, not a synthetic id — holding the AR control
 * account (and optional tax-output account) a later AR Work Item's
 * invoice/receipt posting will debit/credit. AR-1a only creates/reads
 * this configuration; nothing here posts against it.
 *
 * Same RLS/legal-entity-predicate/withTenant conventions as
 * ApSettingsService/SuppliersService — see those files' doc comments for
 * the reasoning, unchanged here.
 */
@Injectable()
export class ArSettingsService {
  async upsert(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: UpsertArSettingsDto,
  ): Promise<ArSettings> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateControlAccountOrThrow(
        tx,
        legalEntityId,
        dto.arControlAccountId,
      );
      if (dto.taxOutputAccountId) {
        await this.validateTaxAccountOrThrow(
          tx,
          legalEntityId,
          dto.taxOutputAccountId,
        );
      }

      const before = await this.findByScopeInTx(tx, tenantId, legalEntityId);

      const [row] = await tx
        .insert(arSettings)
        .values({
          tenantId,
          legalEntityId,
          arControlAccountId: dto.arControlAccountId,
          taxOutputAccountId: dto.taxOutputAccountId ?? null,
        })
        .onConflictDoUpdate({
          target: [arSettings.tenantId, arSettings.legalEntityId],
          set: {
            arControlAccountId: dto.arControlAccountId,
            taxOutputAccountId: dto.taxOutputAccountId ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: before ? "UPDATE" : "CREATE",
        entityType: "ar_settings",
        entityId: legalEntityId,
        beforeState: before
          ? (before as unknown as Record<string, unknown>)
          : null,
        afterState: row as unknown as Record<string, unknown>,
      });

      return row!;
    });
  }

  async findOne(tenantId: string, legalEntityId: string): Promise<ArSettings> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const row = await this.findByScopeInTx(tx, tenantId, legalEntityId);
      if (!row) {
        throw new NotFoundException(
          "AR settings have not been configured for this legal entity.",
        );
      }
      return row;
    });
  }

  private async findByScopeInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<ArSettings | undefined> {
    const rows = await tx
      .select()
      .from(arSettings)
      .where(
        and(
          eq(arSettings.tenantId, tenantId),
          eq(arSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** ar_control_account_id must exist, be active, belong to this legal
   * entity, and — because "AR control account" is unambiguously an asset
   * by definition — be of type ASSET (schema.ts's doc comment on
   * arSettings). */
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
        `arControlAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
    if (rows[0]!.type !== "ASSET") {
      throw new BadRequestException(
        `arControlAccountId ${accountId} must reference an ASSET account (found ${rows[0]!.type}).`,
      );
    }
  }

  /** tax_output_account_id must exist, be active, and belong to this
   * legal entity. Deliberately no type check — see schema.ts's doc
   * comment on arSettings.taxOutputAccountId for why. */
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
        `taxOutputAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
  }
}
