import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { customers, chartOfAccounts, type Customer } from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateCustomerDto } from "./dto/create-customer.dto";
import type { UpdateCustomerDto } from "./dto/update-customer.dto";

/**
 * Customer master — AR-1a
 * (docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §3, §5). Legal-entity-scoped Finance master data, mirroring
 * SuppliersService's conventions exactly (which themselves mirror
 * AccountsService for chart_of_accounts):
 *
 * RLS (via withTenant) enforces the tenant_id boundary. legal_entity_id
 * isolation is NOT covered by RLS (same deliberate decision documented on
 * chart_of_accounts/suppliers/schema.ts) — every query here filters
 * explicitly by both tenantId AND legalEntityId. Do not drop the
 * legalEntityId predicate from any query even though RLS alone would still
 * prevent cross-tenant leakage; it would silently reintroduce
 * cross-legal-entity leakage within one tenant.
 *
 * Every method runs inside withTenant(tenantId, ...) so the RLS session
 * variable is always set before touching customers. Every mutation's
 * audit_logs write happens in the SAME transaction as the customers
 * write, so the two can never diverge.
 */
@Injectable()
export class CustomersService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateCustomerDto,
  ): Promise<Customer> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (dto.defaultRevenueAccountId) {
        await this.validateAccountRefOrThrow(
          tx,
          legalEntityId,
          dto.defaultRevenueAccountId,
          "defaultRevenueAccountId",
        );
      }

      const existing = await tx
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.legalEntityId, legalEntityId),
            eq(customers.code, dto.code),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          `A customer with code "${dto.code}" already exists in this legal entity.`,
        );
      }

      const [created] = await tx
        .insert(customers)
        .values({
          tenantId,
          legalEntityId,
          code: dto.code,
          name: dto.name,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          taxRegistrationNo: dto.taxRegistrationNo ?? null,
          defaultRevenueAccountId: dto.defaultRevenueAccountId ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "customer",
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
  ): Promise<Customer[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const scope = eq(customers.legalEntityId, legalEntityId);
      if (includeInactive) {
        return tx.select().from(customers).where(scope);
      }
      return tx
        .select()
        .from(customers)
        .where(and(scope, eq(customers.isActive, true)));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<Customer> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const customer = await this.findByIdInTx(tx, legalEntityId, id);
      if (!customer) {
        throw new NotFoundException(`No customer found with id ${id}.`);
      }
      return customer;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No customer found with id ${id}.`);
      }

      if (dto.defaultRevenueAccountId) {
        await this.validateAccountRefOrThrow(
          tx,
          legalEntityId,
          dto.defaultRevenueAccountId,
          "defaultRevenueAccountId",
        );
      }

      const [updated] = await tx
        .update(customers)
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
          defaultRevenueAccountId:
            dto.defaultRevenueAccountId !== undefined
              ? dto.defaultRevenueAccountId
              : before.defaultRevenueAccountId,
          updatedAt: new Date(),
        })
        .where(
          and(eq(customers.id, id), eq(customers.legalEntityId, legalEntityId)),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "customer",
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
  ): Promise<Customer> {
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
  ): Promise<Customer> {
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
   * SuppliersService.setActive() (no 409 on a no-op transition; the audit
   * trail still records the action). */
  private async setActive(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    isActive: boolean,
    action: "DEACTIVATE" | "REACTIVATE",
  ): Promise<Customer> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No customer found with id ${id}.`);
      }

      const [updated] = await tx
        .update(customers)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(eq(customers.id, id), eq(customers.legalEntityId, legalEntityId)),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action,
        entityType: "customer",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** Looks up a customer by id, additionally scoped to legalEntityId —
   * RLS already restricts to the caller's tenant, but a direct-by-id
   * lookup must not leak a customer belonging to a different legal
   * entity within the same tenant, so that predicate is applied
   * explicitly here too (same reasoning as
   * SuppliersService.findByIdInTx). */
  private async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<Customer | undefined> {
    const rows = await tx
      .select()
      .from(customers)
      .where(
        and(eq(customers.id, id), eq(customers.legalEntityId, legalEntityId)),
      )
      .limit(1);
    return rows[0];
  }

  /** A caller-supplied Chart of Accounts reference is never trusted as-is
   * (same "ACCOUNT VALIDATION" posture as SuppliersService): the account
   * must exist, must be active, and must belong to the same legal entity
   * as the customer being created/edited. RLS already scopes the lookup
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
