import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { suppliers, chartOfAccounts, type Supplier } from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateSupplierDto } from "./dto/create-supplier.dto";
import type { UpdateSupplierDto } from "./dto/update-supplier.dto";

/**
 * Supplier master — AP-1a (docs/finance-work-item-1-ap-foundation-proposal.md
 * §5, §7). Legal-entity-scoped Finance master data, following the exact
 * conventions AccountsService already established for chart_of_accounts:
 *
 * RLS (via withTenant) enforces the tenant_id boundary. legal_entity_id
 * isolation is NOT covered by RLS (same deliberate decision documented on
 * chart_of_accounts/schema.ts) — every query here filters explicitly by
 * both tenantId AND legalEntityId. Do not drop the legalEntityId
 * predicate from any query even though RLS alone would still prevent
 * cross-tenant leakage; it would silently reintroduce cross-legal-entity
 * leakage within one tenant.
 *
 * Every method runs inside withTenant(tenantId, ...) so the RLS session
 * variable is always set before touching suppliers. Every mutation's
 * audit_logs write happens in the SAME transaction as the suppliers
 * write, so the two can never diverge.
 */
@Injectable()
export class SuppliersService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateSupplierDto,
  ): Promise<Supplier> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (dto.defaultExpenseAccountId) {
        await this.validateAccountRefOrThrow(
          tx,
          legalEntityId,
          dto.defaultExpenseAccountId,
          "defaultExpenseAccountId",
        );
      }

      const existing = await tx
        .select()
        .from(suppliers)
        .where(
          and(
            eq(suppliers.legalEntityId, legalEntityId),
            eq(suppliers.code, dto.code),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          `A supplier with code "${dto.code}" already exists in this legal entity.`,
        );
      }

      const [created] = await tx
        .insert(suppliers)
        .values({
          tenantId,
          legalEntityId,
          code: dto.code,
          name: dto.name,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          taxRegistrationNo: dto.taxRegistrationNo ?? null,
          defaultExpenseAccountId: dto.defaultExpenseAccountId ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "supplier",
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
  ): Promise<Supplier[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const scope = eq(suppliers.legalEntityId, legalEntityId);
      if (includeInactive) {
        return tx.select().from(suppliers).where(scope);
      }
      return tx
        .select()
        .from(suppliers)
        .where(and(scope, eq(suppliers.isActive, true)));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<Supplier> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const supplier = await this.findByIdInTx(tx, legalEntityId, id);
      if (!supplier) {
        throw new NotFoundException(`No supplier found with id ${id}.`);
      }
      return supplier;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<Supplier> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No supplier found with id ${id}.`);
      }

      if (dto.defaultExpenseAccountId) {
        await this.validateAccountRefOrThrow(
          tx,
          legalEntityId,
          dto.defaultExpenseAccountId,
          "defaultExpenseAccountId",
        );
      }

      const [updated] = await tx
        .update(suppliers)
        .set({
          name: dto.name ?? before.name,
          paymentTermsDays:
            dto.paymentTermsDays !== undefined
              ? dto.paymentTermsDays
              : before.paymentTermsDays,
          taxRegistrationNo:
            dto.taxRegistrationNo !== undefined
              ? dto.taxRegistrationNo
              : before.taxRegistrationNo,
          defaultExpenseAccountId:
            dto.defaultExpenseAccountId !== undefined
              ? dto.defaultExpenseAccountId
              : before.defaultExpenseAccountId,
          updatedAt: new Date(),
        })
        .where(
          and(eq(suppliers.id, id), eq(suppliers.legalEntityId, legalEntityId)),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "supplier",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  async deactivate(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<Supplier> {
    return this.setActive(
      tenantId,
      legalEntityId,
      actorUserId,
      id,
      false,
      "DEACTIVATE",
    );
  }

  async reactivate(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<Supplier> {
    return this.setActive(
      tenantId,
      legalEntityId,
      actorUserId,
      id,
      true,
      "REACTIVATE",
    );
  }

  /** Shared by deactivate()/reactivate() — idempotent, same posture as
   * AccountsService.archive() (no 409 on a no-op transition; the audit
   * trail still records the action). */
  private async setActive(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    isActive: boolean,
    action: "DEACTIVATE" | "REACTIVATE",
  ): Promise<Supplier> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No supplier found with id ${id}.`);
      }

      const [updated] = await tx
        .update(suppliers)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(eq(suppliers.id, id), eq(suppliers.legalEntityId, legalEntityId)),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action,
        entityType: "supplier",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** Looks up a supplier by id, additionally scoped to legalEntityId —
   * RLS already restricts to the caller's tenant, but a direct-by-id
   * lookup must not leak a supplier belonging to a different legal
   * entity within the same tenant, so that predicate is applied
   * explicitly here too (same reasoning as
   * AccountsService.findByIdInTx). */
  private async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<Supplier | undefined> {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(
        and(eq(suppliers.id, id), eq(suppliers.legalEntityId, legalEntityId)),
      )
      .limit(1);
    return rows[0];
  }

  /** A caller-supplied Chart of Accounts reference is never trusted as-is
   * (implementation brief's "ACCOUNT VALIDATION" section): the account
   * must exist, must be active, and must belong to the same legal entity
   * as the supplier being created/edited. RLS already scopes the lookup
   * to the caller's tenant; this adds the explicit legal-entity
   * predicate, same as every other cross-reference in this codebase. */
  private async validateAccountRefOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
    fieldName: string,
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
        `${fieldName} ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
  }
}
