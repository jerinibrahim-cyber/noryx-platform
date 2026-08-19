import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { eq, auditLogs } from "@noryx/db-core";
import { chartOfAccounts, type ChartOfAccount } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateAccountDto } from "./dto/create-account.dto";

/**
 * Chart of Accounts only — Milestone 1b's entire domain scope. No journal
 * entries, posting, WIP accrual, or GL reporting here; those are later
 * milestones layered on top of this once it's reviewed.
 *
 * Every method runs inside withTenant(tenantId, ...) so the RLS session
 * variable is always set before touching chart_of_accounts — there is no
 * code path in this service that queries the table outside a tenant-scoped
 * transaction. The create/archive audit_logs write happens in the SAME
 * transaction as the chart_of_accounts write, so the two can never
 * diverge (either both commit or neither does).
 */
@Injectable()
export class AccountsService {
  async create(
    tenantId: string,
    actorUserId: string | null,
    dto: CreateAccountDto,
  ): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (dto.parentId) {
        const parent = await this.findByIdInTx(tx, dto.parentId);
        if (!parent) {
          throw new BadRequestException(
            `parentId ${dto.parentId} does not refer to an existing account in this tenant.`,
          );
        }
      }

      const existing = await tx
        .select()
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.code, dto.code))
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          `An account with code "${dto.code}" already exists.`,
        );
      }

      const [created] = await tx
        .insert(chartOfAccounts)
        .values({
          tenantId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
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
    includeInactive: boolean,
  ): Promise<ChartOfAccount[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (includeInactive) {
        return tx.select().from(chartOfAccounts);
      }
      return tx
        .select()
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.isActive, true));
    });
  }

  async findOne(tenantId: string, id: string): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const account = await this.findByIdInTx(tx, id);
      if (!account) {
        throw new NotFoundException(`No account found with id ${id}.`);
      }
      return account;
    });
  }

  async archive(
    tenantId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<ChartOfAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, id);
      if (!before) {
        throw new NotFoundException(`No account found with id ${id}.`);
      }

      const [updated] = await tx
        .update(chartOfAccounts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(chartOfAccounts.id, id))
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
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

  private async findByIdInTx(
    tx: TxClient,
    id: string,
  ): Promise<ChartOfAccount | undefined> {
    const rows = await tx
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, id))
      .limit(1);
    return rows[0];
  }
}
