import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, legalEntities, ne, auditLogs } from "@noryx/db-core";
import { PostgresError } from "postgres";
import {
  bankCashAccounts,
  chartOfAccounts,
  type BankCashAccount,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateBankCashAccountDto } from "./dto/create-bank-cash-account.dto";
import type { UpdateBankCashAccountDto } from "./dto/update-bank-cash-account.dto";

/**
 * Bank/Cash Account master — Banking-1a
 * (docs/finance-work-item-banking-cash-management-proposal.md §8.1,
 * §12, §20, CTO-approved). Legal-entity-scoped Finance master data,
 * following the exact conventions SuppliersService/AccountsService
 * already established:
 *
 * RLS (via withTenant) enforces the tenant_id boundary. legal_entity_id
 * isolation is NOT covered by RLS (same deliberate decision documented
 * on chart_of_accounts/schema.ts) — every query here filters explicitly
 * by both tenantId AND legalEntityId. Do not drop the legalEntityId
 * predicate from any query even though RLS alone would still prevent
 * cross-tenant leakage; it would silently reintroduce cross-legal-entity
 * leakage within one tenant.
 *
 * Every method runs inside withTenant(tenantId, ...) so the RLS session
 * variable is always set before touching bank_cash_accounts. Every
 * mutation's audit_logs write happens in the SAME transaction as the
 * bank_cash_accounts write, so the two can never diverge.
 *
 * This is master data — CREATE / READ / UPDATE / DEACTIVATE / REACTIVATE
 * only. There is no DRAFT/POSTED lifecycle and no DELETE (locked CTO
 * decision, §5/§9 of the proposal's Banking-1a scope) — a Bank/Cash
 * Account is never posted against directly by anything in Banking-1a;
 * it is purely a reference master entity.
 */
@Injectable()
export class BankCashAccountsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateBankCashAccountDto,
  ): Promise<BankCashAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateGlAccountOrThrow(
        tx,
        legalEntityId,
        dto.glAccountId,
        null,
      );

      const existingCode = await tx
        .select()
        .from(bankCashAccounts)
        .where(
          and(
            eq(bankCashAccounts.legalEntityId, legalEntityId),
            eq(bankCashAccounts.code, dto.code),
          ),
        )
        .limit(1);
      if (existingCode.length > 0) {
        throw new ConflictException(
          `A Bank/Cash Account with code "${dto.code}" already exists in this legal entity.`,
        );
      }

      let created: BankCashAccount;
      try {
        const currencyCode = await this.resolveCurrency(
          tx,
          tenantId,
          legalEntityId,
        );
        const [row] = await tx
          .insert(bankCashAccounts)
          .values({
            tenantId,
            legalEntityId,
            code: dto.code,
            name: dto.name,
            kind: dto.kind,
            purpose: dto.purpose ?? "OPERATING",
            glAccountId: dto.glAccountId,
            currencyCode,
            bankName: dto.bankName ?? null,
            maskedAccountNumber: dto.maskedAccountNumber ?? null,
            createdBy: actorUserId ?? null,
          })
          .returning();
        created = row!;
      } catch (err) {
        // Closes the race the pre-checks above can't: two concurrent
        // create() calls both pass the friendly pre-checks (neither sees
        // the other's not-yet-committed row), both attempt the insert,
        // one commits, the loser lands here. No raw Postgres error may
        // escape the API — same discipline as
        // AccountingPeriodsService.create(). 23505 covers both
        // bank_cash_accounts_tenant_entity_code_unique and
        // bank_cash_accounts_gl_account_unique.
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            "This Bank/Cash Account's code or GL account conflicts with an existing Bank/Cash Account in this legal entity.",
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "bank_cash_account",
        entityId: created.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  /** No filtering/hiding based on the linked GL account's active state
   * (locked CTO correction) — a Bank/Cash Account whose glAccountId has
   * since been deactivated remains fully readable/listable here. Only
   * `isActive` on bank_cash_accounts itself controls the
   * includeInactive filter, exactly mirroring SuppliersService.list(). */
  async list(
    tenantId: string,
    legalEntityId: string,
    includeInactive: boolean,
  ): Promise<BankCashAccount[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const scope = eq(bankCashAccounts.legalEntityId, legalEntityId);
      if (includeInactive) {
        return tx.select().from(bankCashAccounts).where(scope);
      }
      return tx
        .select()
        .from(bankCashAccounts)
        .where(and(scope, eq(bankCashAccounts.isActive, true)));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<BankCashAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const account = await this.findByIdInTx(tx, legalEntityId, id);
      if (!account) {
        throw new NotFoundException(
          `No Bank/Cash Account found with id ${id}.`,
        );
      }
      return account;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateBankCashAccountDto,
  ): Promise<BankCashAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(
          `No Bank/Cash Account found with id ${id}.`,
        );
      }

      if (dto.glAccountId) {
        // Re-validated exactly as at create time — active + ASSET + own
        // legal entity + not already claimed by a DIFFERENT Bank/Cash
        // Account (this row's own current glAccountId is excluded from
        // the "already claimed" check, so re-submitting the same value
        // is never rejected as a self-conflict).
        await this.validateGlAccountOrThrow(
          tx,
          legalEntityId,
          dto.glAccountId,
          id,
        );
      }

      let updated: BankCashAccount;
      try {
        const [row] = await tx
          .update(bankCashAccounts)
          .set({
            name: dto.name ?? before.name,
            kind: dto.kind ?? before.kind,
            purpose: dto.purpose ?? before.purpose,
            glAccountId: dto.glAccountId ?? before.glAccountId,
            bankName:
              dto.bankName !== undefined ? dto.bankName : before.bankName,
            maskedAccountNumber:
              dto.maskedAccountNumber !== undefined
                ? dto.maskedAccountNumber
                : before.maskedAccountNumber,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bankCashAccounts.id, id),
              eq(bankCashAccounts.legalEntityId, legalEntityId),
            ),
          )
          .returning();
        updated = row!;
      } catch (err) {
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            "This Bank/Cash Account's GL account conflicts with an existing Bank/Cash Account in this legal entity.",
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_cash_account",
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
  ): Promise<BankCashAccount> {
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
  ): Promise<BankCashAccount> {
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
   * SuppliersService.setActive() (no 409 on a no-op transition; the
   * audit trail still records the action). */
  private async setActive(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    isActive: boolean,
    action: "DEACTIVATE" | "REACTIVATE",
  ): Promise<BankCashAccount> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(
          `No Bank/Cash Account found with id ${id}.`,
        );
      }

      const [updated] = await tx
        .update(bankCashAccounts)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(bankCashAccounts.id, id),
            eq(bankCashAccounts.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action,
        entityType: "bank_cash_account",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** Looks up a Bank/Cash Account by id, additionally scoped to
   * legalEntityId — RLS already restricts to the caller's tenant, but a
   * direct-by-id lookup must not leak a row belonging to a different
   * legal entity within the same tenant, so that predicate is applied
   * explicitly here too (same reasoning as
   * SuppliersService.findByIdInTx). Deliberately does NOT join or filter
   * on the linked chart_of_accounts row's isActive state — reads never
   * reject/hide a Bank/Cash Account because its GL account later became
   * inactive (locked CTO correction). */
  private async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<BankCashAccount | undefined> {
    const rows = await tx
      .select()
      .from(bankCashAccounts)
      .where(
        and(
          eq(bankCashAccounts.id, id),
          eq(bankCashAccounts.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** CREATE/EDIT-time-only validation (locked CTO decision, proposal
   * §12 "GL ACCOUNT VALIDATION"): glAccountId must exist, belong to the
   * caller's own legal entity (RLS already scopes the lookup to the
   * caller's tenant), be ACTIVE, be of type ASSET — identical predicate
   * to supplierPayments/customerReceipts.bankCashAccountId's own
   * existing validation — and must not already be claimed by another
   * ACTIVE Bank/Cash Account row (the new bank_cash_accounts_gl_account_
   * unique invariant, friendly-checked here; the DB UNIQUE constraint is
   * the real race-closer, caught in create()/update() above). This
   * method is intentionally never called from list()/findOne() — reads
   * do not re-validate the linked GL account at all. `excludeId` lets
   * update() re-submit the account's own current glAccountId without
   * self-conflicting. */
  private async validateGlAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
    excludeId: string | null,
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
        `glAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
    if (rows[0]!.type !== "ASSET") {
      throw new BadRequestException(
        `glAccountId ${accountId} must reference an ASSET account (found ${rows[0]!.type}).`,
      );
    }

    // Friendly pre-check for the uniqueness invariant — better error
    // message when there's no race. The real guarantee is
    // bank_cash_accounts_gl_account_unique; the catch block in
    // create()/update() is what closes the race this pre-check can't.
    const claimedByConditions = excludeId
      ? and(
          eq(bankCashAccounts.glAccountId, accountId),
          ne(bankCashAccounts.id, excludeId),
        )
      : eq(bankCashAccounts.glAccountId, accountId);
    const claimedBy = await tx
      .select({ id: bankCashAccounts.id, code: bankCashAccounts.code })
      .from(bankCashAccounts)
      .where(claimedByConditions)
      .limit(1);
    if (claimedBy.length > 0) {
      throw new ConflictException(
        `glAccountId ${accountId} is already the GL account for Bank/Cash Account "${claimedBy[0]!.code}" — a GL account may back at most one Bank/Cash Account.`,
      );
    }
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * JournalEntriesService.resolveCurrency /
   * SupplierBillsService.resolveCurrency, duplicated locally (private to
   * this class, same convention as every other sub-ledger). */
  private async resolveCurrency(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const [entity] = await tx
      .select({ currencyCode: legalEntities.currencyCode })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.id, legalEntityId),
          eq(legalEntities.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!entity) {
      throw new NotFoundException(
        "Legal entity context could not be resolved for this token.",
      );
    }
    return entity.currencyCode;
  }
}
