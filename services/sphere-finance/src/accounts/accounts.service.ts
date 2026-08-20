import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { chartOfAccounts, type ChartOfAccount } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateAccountDto } from "./dto/create-account.dto";

/**
 * Chart of Accounts, scoped by (tenantId, legalEntityId) since the 2a
 * retrofit (docs/finance-journal-engine-proposal.md §1.1/§1.2). No
 * journal entries, posting, WIP accrual, or GL reporting here; those are
 * later increments layered on top of this once it's reviewed.
 *
 * RLS (via withTenant) enforces the tenant_id boundary — that part is
 * unchanged from Milestone 1b. legal_entity_id isolation is NOT covered
 * by RLS (a deliberate decision, see schema.ts's doc comment) — every
 * query in this file therefore filters explicitly by BOTH tenantId AND
 * legalEntityId. Do not remove the legalEntityId predicate from any
 * query here even though RLS alone would still prevent cross-tenant
 * leakage; it would silently reintroduce cross-legal-entity leakage
 * within one tenant, which is exactly the gap the 2a retrofit closes.
 *
 * Every method runs inside withTenant(tenantId, ...) so the RLS session
 * variable is always set before touching chart_of_accounts. The
 * create/archive audit_logs write happens in the SAME transaction as the
 * chart_of_accounts write, so the two can never diverge (either both
 * commit or neither does).
 */
@Injectable()
export class AccountsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateAccountDto,
  ): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (dto.parentId) {
        const parent = await this.findByIdInTx(tx, legalEntityId, dto.parentId);
        if (!parent) {
          throw new BadRequestException(
            `parentId ${dto.parentId} does not refer to an existing account in this legal entity.`,
          );
        }
      }

      const existing = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.legalEntityId, legalEntityId),
            eq(chartOfAccounts.code, dto.code),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          `An account with code "${dto.code}" already exists in this legal entity.`,
        );
      }

      const [created] = await tx
        .insert(chartOfAccounts)
        .values({
          tenantId,
          legalEntityId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "chart_of_accounts",
        entityId: created!.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created!;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    includeInactive: boolean,
  ): Promise<ChartOfAccount[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const scope = eq(chartOfAccounts.legalEntityId, legalEntityId);
      if (includeInactive) {
        return tx.select().from(chartOfAccounts).where(scope);
      }
      return tx
        .select()
        .from(chartOfAccounts)
        .where(and(scope, eq(chartOfAccounts.isActive, true)));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const account = await this.findByIdInTx(tx, legalEntityId, id);
      if (!account) {
        throw new NotFoundException(`No account found with id ${id}.`);
      }
      return account;
    });
  }

  async archive(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No account found with id ${id}.`);
      }

      const [updated] = await tx
        .update(chartOfAccounts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(chartOfAccounts.id, id),
            eq(chartOfAccounts.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "ARCHIVE",
        entityType: "chart_of_accounts",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** Looks up an account by id, additionally scoped to legalEntityId —
   * RLS already restricts to the caller's tenant, but a direct-by-id
   * lookup must not leak an account belonging to a different legal
   * entity within the same tenant, so that predicate is applied
   * explicitly here too (see this file's top doc comment). */
  private async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<ChartOfAccount | undefined> {
    const rows = await tx
      .select()
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, id),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0];
  }
}
