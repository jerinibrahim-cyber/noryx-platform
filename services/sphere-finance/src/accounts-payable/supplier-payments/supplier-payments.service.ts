import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  and,
  asc,
  auditLogs,
  eq,
  gte,
  inArray,
  legalEntities,
  lte,
  sql,
} from "@noryx/db-core";
import {
  accountingPeriods,
  apSettings,
  chartOfAccounts,
  journalEntries,
  journalLines,
  suppliers,
  supplierBills,
  supplierPayments,
  supplierPaymentAllocations,
  type AccountingPeriod,
  type ApSettings,
  type Supplier,
  type SupplierBill,
  type SupplierPayment,
  type SupplierPaymentAllocation,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateSupplierPaymentDto } from "./dto/create-supplier-payment.dto";
import type { CreateSupplierPaymentAllocationDto } from "./dto/create-supplier-payment-allocation.dto";
import type { UpdateSupplierPaymentDto } from "./dto/update-supplier-payment.dto";

export type SupplierPaymentWithAllocations = SupplierPayment & {
  allocations: SupplierPaymentAllocation[];
};

export interface ListSupplierPaymentsFilters {
  status?: "DRAFT" | "POSTED";
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Supplier payments & allocations — AP-1c
 * (docs/finance-work-item-1c-supplier-payments-proposal.md §3, §6, §7,
 * §8, §11).
 *
 * Draft CRUD mirrors SupplierBillsService's create/list/findOne/update/
 * remove shape exactly (full-array-replacement on update, DRAFT-only
 * edit/delete, SELECT ... FOR UPDATE before any status-dependent
 * mutation). post() replicates the same replicated-Journal-Engine-
 * posting shape AP-1b established — direct insertion into the shared
 * journal_entries/journal_lines/journal_number_counters tables rather
 * than calling JournalEntriesService, for the identical
 * transaction-atomicity reason (proposal §6/§8) — extended here with
 * multi-bill row locking in a fixed order (ascending id) so two
 * concurrent payments touching an overlapping bill set can never
 * deadlock each other (proposal §8 step 7, restating the AP-1a
 * proposal's own §15 locking strategy).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class SupplierPaymentsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateSupplierPaymentDto,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateSupplierRefOrThrow(tx, legalEntityId, dto.supplierId);
      await this.validateBankCashAccountOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.bankCashAccountId,
      );
      await this.validateAllocationsShapeOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.supplierId,
        dto.allocations,
      );

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );

      const [createdPayment] = await tx
        .insert(supplierPayments)
        .values({
          tenantId,
          legalEntityId,
          supplierId: dto.supplierId,
          paymentDate: dto.paymentDate,
          currencyCode,
          paymentAmountMinor: dto.paymentAmountMinor,
          paymentMethod: dto.paymentMethod,
          bankCashAccountId: dto.bankCashAccountId,
          reference: dto.reference ?? null,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedAllocations = await this.insertAllocations(
        tx,
        tenantId,
        createdPayment!.id,
        dto.allocations,
      );

      const full: SupplierPaymentWithAllocations = {
        ...createdPayment!,
        allocations: insertedAllocations,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "supplier_payment",
        entityId: createdPayment!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListSupplierPaymentsFilters,
  ): Promise<SupplierPayment[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(supplierPayments.tenantId, tenantId),
        eq(supplierPayments.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(supplierPayments.status, filters.status));
      }
      if (filters.supplierId) {
        conditions.push(eq(supplierPayments.supplierId, filters.supplierId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(supplierPayments.paymentDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(supplierPayments.paymentDate, filters.dateTo));
      }
      return tx
        .select()
        .from(supplierPayments)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateSupplierPaymentDto,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted supplier payment.");
      }

      if (dto.bankCashAccountId !== undefined) {
        await this.validateBankCashAccountOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.bankCashAccountId,
        );
      }
      if (dto.allocations) {
        await this.validateAllocationsShapeOrThrow(
          tx,
          tenantId,
          legalEntityId,
          before.supplierId,
          dto.allocations,
        );
      }

      const headerPatch: Partial<typeof supplierPayments.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.paymentDate !== undefined) {
        headerPatch.paymentDate = dto.paymentDate;
      }
      if (dto.paymentAmountMinor !== undefined) {
        headerPatch.paymentAmountMinor = dto.paymentAmountMinor;
      }
      if (dto.paymentMethod !== undefined) {
        headerPatch.paymentMethod = dto.paymentMethod;
      }
      if (dto.bankCashAccountId !== undefined) {
        headerPatch.bankCashAccountId = dto.bankCashAccountId;
      }
      if (dto.reference !== undefined) {
        headerPatch.reference = dto.reference;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      await tx
        .update(supplierPayments)
        .set(headerPatch)
        .where(
          and(
            eq(supplierPayments.id, id),
            eq(supplierPayments.tenantId, tenantId),
            eq(supplierPayments.legalEntityId, legalEntityId),
          ),
        );

      if (dto.allocations) {
        // Full-array replacement, not allocation-level add/remove — same
        // convention as SupplierBillsService.update()'s line handling.
        await tx
          .delete(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, id));
        await this.insertAllocations(tx, tenantId, id, dto.allocations);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "supplier_payment",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: after as unknown as Record<string, unknown>,
      });

      return after!;
    });
  }

  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted supplier payment.");
      }

      // supplier_payment_allocations rows cascade via the existing FK's
      // onDelete: "cascade".
      await tx
        .delete(supplierPayments)
        .where(
          and(
            eq(supplierPayments.id, id),
            eq(supplierPayments.tenantId, tenantId),
            eq(supplierPayments.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "supplier_payment",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /payments/:id/post` — DRAFT -> POSTED. Proposal §8's 13-step
   * shape: lock, status, allocation-count, bank/cash account
   * re-validation, AP settings load, period resolution+lock, fixed-order
   * multi-bill locking, per-bill re-validation, exact-allocation-sum
   * check, payment-number allocation, journal-number allocation, direct
   * journal_entries/journal_lines insertion (DRAFT-then-POST ordering —
   * see the inline note below), commit, per-bill paid_minor/
   * payment_status updates, N+2-row audit. A failure at any step rolls
   * the whole transaction back — no burned payment number, no burned
   * journal number, no orphaned journal entry, no partial bill update,
   * from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This supplier payment is already posted.");
      }

      // Step 3: a payment must allocate to post — no bare unapplied
      // payment in this Work Item (proposal §7).
      if (before.allocations.length < 1) {
        throw new UnprocessableEntityException(
          "A supplier payment must have at least 1 allocation to be posted.",
        );
      }

      // Step 4: re-validate the bank/cash account, independently of
      // whatever passed at create/edit time — an account can be
      // archived between draft creation and posting.
      await this.revalidateBankCashAccountForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.bankCashAccountId,
      );

      // Step 5: load AP settings (the same apControlAccountId bills
      // already use).
      const settings = await this.loadApSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 6: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.paymentDate,
      );

      // Step 7: lock every allocated bill in ONE statement, in a fixed
      // ascending-id order — two concurrent payments touching an
      // overlapping bill set always acquire row locks in the same
      // relative order, so neither can deadlock the other (proposal §8
      // step 7).
      const billIds = before.allocations.map((a) => a.billId);
      const lockedBills = await tx
        .select()
        .from(supplierBills)
        .where(
          and(
            inArray(supplierBills.id, billIds),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        )
        .orderBy(asc(supplierBills.id))
        .for("update");
      const billsById = new Map<string, SupplierBill>(
        lockedBills.map((b) => [b.id, b]),
      );

      // Step 8: re-validate each allocated bill under lock — status,
      // same supplier, and sufficient remaining balance — independently
      // of whatever passed at create/edit time (another payment may
      // have posted against the same bill since).
      for (const allocation of before.allocations) {
        const bill = billsById.get(allocation.billId);
        if (!bill) {
          throw new UnprocessableEntityException(
            `Allocated bill ${allocation.billId} could not be found in this legal entity.`,
          );
        }
        if (bill.status !== "POSTED") {
          throw new UnprocessableEntityException(
            `Bill ${allocation.billId} is not posted and cannot receive a payment allocation.`,
          );
        }
        if (bill.supplierId !== before.supplierId) {
          throw new UnprocessableEntityException(
            `Bill ${allocation.billId} does not belong to this payment's supplier.`,
          );
        }
        const outstanding = bill.totalMinor - bill.paidMinor;
        if (allocation.allocatedAmountMinor > outstanding) {
          throw new UnprocessableEntityException(
            `Allocation of ${allocation.allocatedAmountMinor} to bill ${allocation.billId} exceeds its outstanding balance of ${outstanding}.`,
          );
        }
      }

      // Step 9: full-allocation requirement — no "payment on account"
      // in this Work Item (proposal §1/§7/§19 of the AP-1a proposal).
      const allocatedTotal = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (allocatedTotal !== before.paymentAmountMinor) {
        throw new UnprocessableEntityException(
          `Total allocated amount (${allocatedTotal}) must equal the payment amount (${before.paymentAmountMinor}) to post.`,
        );
      }

      // Step 10: atomic payment-number allocation — a SEPARATE counter
      // from ap_number_counters (proposal §12 decision 1, approved).
      const internalReference = await this.allocatePaymentNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 11: atomic journal-number allocation from the SAME sequence
      // real journal entries and bills use — no AP-only journal-number
      // series.
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 12: insert the journal entry header as DRAFT first, then
      // its lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED. journal_lines_immutable blocks any
      // INSERT once its parent journal_entries row is POSTED — the
      // exact ordering AP-1b's own e2e verification caught and fixed;
      // implemented correctly from the start here.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.paymentDate,
          currencyCode: before.currencyCode,
          memo: `Payment ${internalReference} to supplier (bank/cash account posting)`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const journalLineValues: (typeof journalLines.$inferInsert)[] = [
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 1,
          accountId: settings.apControlAccountId,
          debitMinor: before.paymentAmountMinor,
          creditMinor: 0,
          description: `AP control — payment ${internalReference}`,
        },
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 2,
          accountId: before.bankCashAccountId,
          debitMinor: 0,
          creditMinor: before.paymentAmountMinor,
          description: `Bank/cash — payment ${internalReference}`,
        },
      ];
      const insertedJournalLines = await tx
        .insert(journalLines)
        .values(journalLineValues)
        .returning();

      const [postedJournalEntry] = await tx
        .update(journalEntries)
        .set({
          status: "POSTED",
          journalNumber,
          periodId: period.id,
          postedBy: actorUserId ?? null,
          postedAt: new Date(),
        })
        .where(eq(journalEntries.id, draftJournalEntry!.id))
        .returning();

      // Step 13: commit the payment's own transition.
      const [posted] = await tx
        .update(supplierPayments)
        .set({
          status: "POSTED",
          internalReference,
          journalEntryId: postedJournalEntry!.id,
          periodId: period.id,
          postedBy: actorUserId ?? null,
          postedAt: new Date(),
        })
        .where(
          and(
            eq(supplierPayments.id, id),
            eq(supplierPayments.tenantId, tenantId),
            eq(supplierPayments.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      // Step 14: settle each allocated bill. CRITICAL — this UPDATE
      // must NOT include updated_at in its SET clause:
      // 005_supplier_bills_immutability_trigger.sql rejects any change
      // to a POSTED row's updated_at alongside paid_minor/
      // payment_status (checked column-by-column, by design — AP-1b's
      // own narrow-exception trigger, proposal §8 step 11).
      const billAuditRows: {
        tenantId: string;
        legalEntityId: string;
        actorUserId: string | undefined;
        action: string;
        entityType: string;
        entityId: string;
        beforeState: Record<string, unknown>;
        afterState: Record<string, unknown>;
      }[] = [];
      for (const allocation of before.allocations) {
        const bill = billsById.get(allocation.billId)!;
        const newPaidMinor = bill.paidMinor + allocation.allocatedAmountMinor;
        const newPaymentStatus =
          newPaidMinor === bill.totalMinor
            ? "PAID"
            : newPaidMinor > 0
              ? "PARTIALLY_PAID"
              : "UNPAID";
        const [updatedBill] = await tx
          .update(supplierBills)
          .set({
            paidMinor: newPaidMinor,
            paymentStatus: newPaymentStatus,
          })
          .where(eq(supplierBills.id, bill.id))
          .returning();
        billAuditRows.push({
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "UPDATE",
          entityType: "supplier_bill",
          entityId: bill.id,
          beforeState: bill as unknown as Record<string, unknown>,
          afterState: updatedBill as unknown as Record<string, unknown>,
        });
      }

      const after: SupplierPaymentWithAllocations = {
        ...posted!,
        allocations: before.allocations,
      };

      // Step 15: audit — POST against the payment, CREATE against the
      // new journal entry, one UPDATE row per settled bill (proposal §8
      // step 13 — "audit all financially significant state changes").
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "supplier_payment",
          entityId: id,
          beforeState: before as unknown as Record<string, unknown>,
          afterState: after as unknown as Record<string, unknown>,
        },
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "CREATE",
          entityType: "journal_entry",
          entityId: postedJournalEntry!.id,
          beforeState: null,
          afterState: {
            ...postedJournalEntry!,
            lines: insertedJournalLines,
          } as unknown as Record<string, unknown>,
        },
        ...billAuditRows,
      ]);

      return after;
    });
  }

  /** supplierId must resolve to an existing, active supplier in the
   * caller's own (tenantId [via RLS], legalEntityId). */
  private async validateSupplierRefOrThrow(
    tx: TxClient,
    legalEntityId: string,
    supplierId: string,
  ): Promise<Supplier> {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.legalEntityId, legalEntityId),
          eq(suppliers.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `supplierId ${supplierId} does not refer to an active supplier in this legal entity.`,
      );
    }
    return rows[0]!;
  }

  /** bankCashAccountId must resolve to an existing, active, type-ASSET
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — create/edit-time validation, 400. Type-restricted the same way
   * ap_settings.apControlAccountId is restricted to LIABILITY
   * (ApSettingsService.upsert) — "bank/cash account" is unambiguously an
   * asset by definition. */
  private async validateBankCashAccountOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
          eq(chartOfAccounts.type, "ASSET"),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `bankCashAccountId ${accountId} does not refer to an active ASSET account in this legal entity.`,
      );
    }
  }

  /** Posting-time re-validation of the bank/cash account — independent
   * of whatever passed at draft create/edit time. 422, not 400: this is
   * a business-rule/invariant failure at posting time, same posture as
   * SupplierBillsService.revalidateLineAccountsForPostingOrThrow. */
  private async revalidateBankCashAccountForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
          eq(chartOfAccounts.type, "ASSET"),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new UnprocessableEntityException(
        `bankCashAccountId ${accountId} is not an active ASSET account in this legal entity.`,
      );
    }
  }

  /** Every allocation's billId must resolve to an existing bill in the
   * caller's own (tenantId, legalEntityId) belonging to the same
   * supplier as the payment — create/edit-time SHAPE validation only
   * (400). Deliberately does not require the bill to be POSTED yet, or
   * check its outstanding balance — those are posting-time concerns
   * (proposal §7's create-time-vs-post-time split), since a bill this
   * payment intends to pay may not be posted yet at draft-creation
   * time, and its remaining balance can legitimately change before this
   * payment itself posts. */
  private async validateAllocationsShapeOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    supplierId: string,
    allocations: CreateSupplierPaymentAllocationDto[],
  ): Promise<void> {
    const uniqueBillIds = [...new Set(allocations.map((a) => a.billId))];
    if (uniqueBillIds.length !== allocations.length) {
      throw new BadRequestException(
        "A payment may allocate to a given bill at most once — combine amounts into a single allocation entry.",
      );
    }
    const validBills = await tx
      .select({ id: supplierBills.id })
      .from(supplierBills)
      .where(
        and(
          eq(supplierBills.tenantId, tenantId),
          eq(supplierBills.legalEntityId, legalEntityId),
          eq(supplierBills.supplierId, supplierId),
          inArray(supplierBills.id, uniqueBillIds),
        ),
      );
    const validIds = new Set(validBills.map((b) => b.id));
    const invalid = uniqueBillIds.filter((billId) => !validIds.has(billId));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `The following bill id(s) do not refer to bills belonging to this payment's supplier in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  /** Loads ap_settings for this legal entity, within the SAME posting
   * transaction. 422, not 404 — same reasoning as
   * SupplierBillsService.loadApSettingsOrThrow. */
  private async loadApSettingsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<ApSettings> {
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
    if (rows.length === 0) {
      throw new UnprocessableEntityException(
        "AP settings have not been configured for this legal entity.",
      );
    }
    return rows[0]!;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * SupplierBillsService.resolveCurrency, duplicated locally. */
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

  /** Resolves the accounting period covering `paymentDate`, locked via
   * `SELECT ... FOR UPDATE`. Identical query/lock shape to
   * SupplierBillsService.resolveAndLockOpenPeriod, duplicated locally. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    paymentDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, paymentDate),
          gte(accountingPeriods.endDate, paymentDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers payment date ${paymentDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${paymentDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free payment-number allocation via ap_payment_number_counters'
   * atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a
   * SEPARATE table from ap_number_counters (proposal §12 decision 1,
   * approved). Formatted `PAY-{n:06d}`, scoped per legal entity. */
  private async allocatePaymentNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO ap_payment_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = ap_payment_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `PAY-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries and bills use —
   * identical atomic pattern to SupplierBillsService's own private
   * copy, duplicated locally rather than sharing via a cross-service
   * call. Formatted `JE-{n:06d}`, scoped per legal entity. */
  private async allocateJournalNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO journal_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = journal_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `JE-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  private async insertAllocations(
    tx: TxClient,
    tenantId: string,
    paymentId: string,
    allocations: CreateSupplierPaymentAllocationDto[],
  ): Promise<SupplierPaymentAllocation[]> {
    return tx
      .insert(supplierPaymentAllocations)
      .values(
        allocations.map((allocation) => ({
          tenantId,
          paymentId,
          billId: allocation.billId,
          allocatedAmountMinor: allocation.allocatedAmountMinor,
        })),
      )
      .returning();
  }

  /** Scoped by (id, tenantId, legalEntityId) — same convention as every
   * other Finance service. `options.forUpdate` acquires
   * `SELECT ... FOR UPDATE` on the header row — used by every mutating
   * operation (update/remove/post) as their first statement. Plain
   * reads never lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SupplierPaymentWithAllocations | undefined> {
    const condition = and(
      eq(supplierPayments.id, id),
      eq(supplierPayments.tenantId, tenantId),
      eq(supplierPayments.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(supplierPayments)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(supplierPayments).where(condition).limit(1);
    const payment = rows[0];
    if (!payment) return undefined;

    const allocations = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(eq(supplierPaymentAllocations.paymentId, id));

    return { ...payment, allocations };
  }
}
