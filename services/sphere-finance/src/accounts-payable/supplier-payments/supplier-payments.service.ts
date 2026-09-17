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
import { JournalEntriesService } from "../../journal-entries/journal-entries.service";
import type { ReverseJournalEntryDto } from "../../journal-entries/dto/reverse-journal-entry.dto";
import {
  resolveOpenPeriodOrThrow,
  resolveReversalInfo,
  unsettleTarget,
  type ReversalInfo,
} from "../../common/reversal/reversal.util";
import type { CreateSupplierPaymentDto } from "./dto/create-supplier-payment.dto";
import type { CreateSupplierPaymentAllocationDto } from "./dto/create-supplier-payment-allocation.dto";
import type { UpdateSupplierPaymentDto } from "./dto/update-supplier-payment.dto";
import type { ApplySupplierPaymentAllocationDto } from "./dto/apply-supplier-payment-allocation.dto";

export type SupplierPaymentWithAllocations = SupplierPayment & {
  allocations: SupplierPaymentAllocation[];
};

export type SupplierPaymentWithReversal = SupplierPaymentWithAllocations & {
  reversal: ReversalInfo | null;
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
  constructor(private readonly journalEntries: JournalEntriesService) {}

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
        createdPayment!.paymentDate,
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
  ): Promise<SupplierPaymentWithReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }
      // Document-Level Reversal work item
      // (docs/finance-work-item-document-reversal-proposal.md §17) —
      // additive, computed field on single-document reads.
      const reversal = await resolveReversalInfo(tx, found.journalEntryId);
      return { ...found, reversal };
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
        // allocation_date for every row this full-replace writes is the
        // payment's own (possibly just-patched) paymentDate — these rows
        // are, by construction, contemporaneous with the payment's own
        // date, exactly like every pre-existing allocation row the
        // on-account migration backfilled (proposal §15.1).
        await tx
          .delete(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, id));
        await this.insertAllocations(
          tx,
          tenantId,
          id,
          dto.allocations,
          headerPatch.paymentDate ?? before.paymentDate,
        );
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
   * `POST /payments/:id/post` — DRAFT -> POSTED. Proposal §8's step
   * shape: lock, status, bank/cash account re-validation, AP settings
   * load, period resolution+lock, fixed-order multi-bill locking,
   * per-bill re-validation, allocated-total-does-not-exceed-header-
   * amount check, payment-number allocation, journal-number allocation,
   * direct journal_entries/journal_lines insertion (DRAFT-then-POST
   * ordering — see the inline note below), commit, per-bill paid_minor/
   * payment_status updates, N+2-row audit. A failure at any step rolls
   * the whole transaction back — no burned payment number, no burned
   * journal number, no orphaned journal entry, no partial bill update,
   * from a failed post.
   *
   * On-Account (Unapplied) Supplier Payments & Customer Receipts work
   * item (docs/finance-work-item-on-account-payments-proposal.md, CTO
   * Architecture Gate, approved): a payment with zero or partial
   * allocations may now post — see the inline notes on Steps 3, 7, and 9
   * below — and may receive further allocations afterward via
   * `applyAllocation()`.
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

      // Step 3 (RELAXED — On-Account (Unapplied) Supplier Payments &
      // Customer Receipts work item, CTO Architecture Gate, approved):
      // the original AP-1c guard required at least 1 allocation to
      // post. That guard is removed — a payment may now post with zero
      // allocations and later receive one or more via
      // applyAllocation() (§9 of the proposal). No replacement check is
      // needed here: Invariant 2 (allocated total never exceeds the
      // header amount) is enforced below (Step 9, now an inequality),
      // and zero allocations trivially satisfies it.

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
      // step 7). Guarded for the empty-array case (`billIds.length ?
      // ... : []`) — required the instant Step 3's floor is removed,
      // since `before.allocations` may now legitimately be `[]`; mirrors
      // the identical, already-proven-safe guard `reverse()` already
      // uses for the same reason (proposal §3.4/self-critique).
      const billIds = before.allocations.map((a) => a.billId);
      const lockedBills = billIds.length
        ? await tx
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
            .for("update")
        : [];
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

      // Step 9 (RELAXED from an exact-equality check to an upper-bound
      // check — On-Account work item, CTO Architecture Gate, approved).
      // Invariant 2 (proposal §6.2): 0 <= appliedMinor(p) <=
      // paymentAmountMinor at all times. Zero and partial allocation are
      // now valid posting states; only exceeding the header amount is
      // still rejected.
      const allocatedTotal = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (allocatedTotal > before.paymentAmountMinor) {
        throw new UnprocessableEntityException(
          `Total allocated amount (${allocatedTotal}) exceeds the payment amount (${before.paymentAmountMinor}).`,
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

  /**
   * `POST /payments/:id/allocations` — applies one or more NEW
   * allocations to an already-POSTED supplier payment. On-Account
   * (Unapplied) Supplier Payments & Customer Receipts work item
   * (docs/finance-work-item-on-account-payments-proposal.md §9.1/§9.4,
   * CTO Architecture Gate, approved implementation authorization).
   * Append-only: no existing allocation row is ever read, merged into,
   * or updated — every call inserts brand-new row(s), each carrying its
   * own `allocationDate` (§9.4). A reversed payment permanently rejects
   * this call (Step 5) — both at the application layer here and,
   * independently, at the database layer via the relaxed immutability
   * trigger (§15.3), as defense-in-depth.
   */
  async applyAllocation(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: ApplySupplierPaymentAllocationDto,
  ): Promise<SupplierPaymentWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1-2: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }

      // Step 3: only a POSTED payment can receive a new allocation.
      if (before.status !== "POSTED") {
        throw new UnprocessableEntityException(
          "Only a posted supplier payment can receive a new allocation.",
        );
      }
      // Step 4: structurally unreachable once Step 3 passes (a POSTED
      // payment always has a journalEntryId, per post()'s own Step 12-13)
      // — kept for parity with reverse()'s own defensive check.
      if (!before.journalEntryId) {
        throw new UnprocessableEntityException(
          "This supplier payment has no posted journal entry.",
        );
      }

      // Step 5: a reversed payment can never receive a further
      // allocation — its cash movement has been accounting-reversed
      // (§9.3). Checked directly against the journal entry's own
      // reversedByJournalEntryId, the single source of truth for
      // reversal state (no REVERSED status value exists on this table).
      const [journalEntry] = await tx
        .select({
          reversedByJournalEntryId: journalEntries.reversedByJournalEntryId,
        })
        .from(journalEntries)
        .where(eq(journalEntries.id, before.journalEntryId));
      if (journalEntry?.reversedByJournalEntryId != null) {
        throw new ConflictException(
          "This supplier payment has already been reversed and cannot receive further allocations.",
        );
      }

      // Step 6: appliedMinor(p) — the true, current, cumulative applied
      // amount, over ALL existing allocation rows (create-time and
      // every prior applyAllocation() call alike).
      const currentlyAppliedMinor = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );

      // Step 7: reused unmodified — rejects a duplicate billId within
      // this request, and any billId not belonging to this payment's own
      // supplier in this legal entity.
      await this.validateAllocationsShapeOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.supplierId,
        dto.allocations,
      );

      // Step 8: the incremental, always-enforced form of Invariant 2
      // (§6.2/§9.2) — currentlyAppliedMinor + this request's total must
      // not exceed the payment's own header amount.
      const requestedTotal = dto.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (currentlyAppliedMinor + requestedTotal > before.paymentAmountMinor) {
        throw new UnprocessableEntityException(
          `Applying ${requestedTotal} would bring this payment's total applied amount to ${
            currentlyAppliedMinor + requestedTotal
          }, exceeding its amount of ${before.paymentAmountMinor}.`,
        );
      }

      // Step 9 (§9.4 Rules 1-2): effectiveAllocationDate defaults to
      // today (Rule 5), must not be earlier than the payment's own
      // paymentDate (Rule 1), and must not be later than today — no
      // future-effective allocation (Rule 2, CTO Architecture Gate
      // Option A; see reversal.util.ts's scheduled-reversals precedent
      // discussion in the proposal for why this codebase's only
      // established future-effective mechanism is a deferred-execution
      // design this endpoint deliberately does not replicate).
      const todayUtc = new Date().toISOString().slice(0, 10);
      const effectiveAllocationDate = dto.allocationDate ?? todayUtc;
      if (effectiveAllocationDate > todayUtc) {
        throw new UnprocessableEntityException(
          `Allocation date ${effectiveAllocationDate} cannot be later than today (${todayUtc}) — this endpoint does not support a future-effective allocation.`,
        );
      }
      if (effectiveAllocationDate < before.paymentDate) {
        throw new UnprocessableEntityException(
          `Allocation date ${effectiveAllocationDate} cannot be earlier than this payment's own payment date ${before.paymentDate}.`,
        );
      }

      // Step 10 (§9.4 Rules 3-4/6-7): resolve + lock the OPEN period
      // covering the allocation event's OWN date — never before.
      // paymentDate's period — reusing the exact shared helper
      // reverse() itself already uses (resolveOpenPeriodOrThrow, backed
      // by JournalEntriesService.resolvePeriodForDate(), which locks the
      // period row via SELECT ... FOR UPDATE). Enforced even though this
      // call inserts no journal_entries row (Rule 7).
      await resolveOpenPeriodOrThrow(
        this.journalEntries,
        tx,
        tenantId,
        legalEntityId,
        effectiveAllocationDate,
      );

      // Step 11: lock every targeted bill, fixed ascending-id order —
      // identical pattern to post() Step 7 / reverse().
      const billIds = dto.allocations.map((a) => a.billId);
      const lockedBills = billIds.length
        ? await tx
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
            .for("update")
        : [];
      const billsById = new Map<string, SupplierBill>(
        lockedBills.map((b) => [b.id, b]),
      );

      // Step 12: re-validate each targeted bill under lock — identical
      // checks to post() Step 8.
      for (const allocation of dto.allocations) {
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

      // Step 13: INSERT one new row per dto.allocations[*] — append-only,
      // each with allocationDate = effectiveAllocationDate. No existing
      // row is ever read, merged into, or updated.
      const insertedAllocations = await tx
        .insert(supplierPaymentAllocations)
        .values(
          dto.allocations.map((allocation) => ({
            tenantId,
            paymentId: id,
            billId: allocation.billId,
            allocatedAmountMinor: allocation.allocatedAmountMinor,
            allocationDate: effectiveAllocationDate,
          })),
        )
        .returning();

      // Step 14: settle each newly-allocated bill — identical arithmetic
      // to post() Step 14, including the same "never set updated_at"
      // caveat (the immutability trigger rejects it alongside
      // paid_minor/payment_status).
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
      for (const allocation of dto.allocations) {
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
        ...before,
        allocations: [...before.allocations, ...insertedAllocations],
      };

      // Step 15: audit — one UPDATE row on the payment (before/after
      // allocation list), one UPDATE row per settled bill.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "UPDATE",
          entityType: "supplier_payment",
          entityId: id,
          beforeState: before as unknown as Record<string, unknown>,
          afterState: after as unknown as Record<string, unknown>,
        },
        ...billAuditRows,
      ]);

      // Step 16: return the payment with its full current allocation
      // list.
      return after;
    });
  }

  /**
   * `POST /payments/:id/reverse` — Document-Level Reversal for Posted
   * AP & AR Documents work item
   * (docs/finance-work-item-document-reversal-proposal.md §7/§9/§18,
   * CTO-approved implementation authorization). Supplier payments are a
   * "settlement" document (§7): never blocked by their own state, but
   * responsible for unwinding their own allocations against whatever
   * bills they settled — the exact mirror image of `post()`'s own step
   * 14 apply-side arithmetic (§9), via the shared `unsettleTarget()`
   * helper. Locks every allocated bill first, in the SAME fixed
   * ascending-id order `post()` itself uses (proposal §11/§18's
   * concurrency requirement), before locking the journal entry — so a
   * concurrent reversal or a fresh payment/debit-note posting touching
   * an overlapping bill set can never deadlock against this one.
   */
  async reverse(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: ReverseJournalEntryDto,
  ): Promise<SupplierPaymentWithReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier payment found with id ${id}.`);
      }
      if (before.status !== "POSTED") {
        throw new UnprocessableEntityException(
          "Only a posted supplier payment can be reversed.",
        );
      }
      if (!before.journalEntryId) {
        throw new UnprocessableEntityException(
          "This supplier payment has no posted journal entry to reverse.",
        );
      }

      const billIds = before.allocations.map((a) => a.billId);
      const lockedBills = billIds.length
        ? await tx
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
            .for("update")
        : [];
      const billsById = new Map<string, SupplierBill>(
        lockedBills.map((b) => [b.id, b]),
      );

      const original =
        await this.journalEntries.lockAndValidateOriginalForReversal(
          tx,
          tenantId,
          legalEntityId,
          before.journalEntryId,
        );

      const transactionDate =
        dto.transactionDate ?? new Date().toISOString().slice(0, 10);
      const memo =
        dto.memo ?? `Reversal of supplier payment ${before.internalReference}`;

      const period = await resolveOpenPeriodOrThrow(
        this.journalEntries,
        tx,
        tenantId,
        legalEntityId,
        transactionDate,
      );

      await this.journalEntries.completeReversalPosting(
        tx,
        tenantId,
        legalEntityId,
        actorUserId,
        original,
        period,
        transactionDate,
        memo,
      );

      // Unwind each allocation's effect on its bill — mirrors post()'s
      // own step 14, subtracting instead of adding (proposal §9).
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
        const bill = billsById.get(allocation.billId);
        if (!bill) {
          throw new UnprocessableEntityException(
            `Allocated bill ${allocation.billId} could not be found in this legal entity.`,
          );
        }
        const updatedBill = await unsettleTarget(
          tx,
          supplierBills,
          bill,
          allocation.allocatedAmountMinor,
        );
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

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "REVERSE",
          entityType: "supplier_payment",
          entityId: id,
          beforeState: before as unknown as Record<string, unknown>,
          afterState: after as unknown as Record<string, unknown>,
        },
        ...billAuditRows,
      ]);

      const reversal = await resolveReversalInfo(tx, after!.journalEntryId);
      return { ...after!, reversal };
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
    // CTO remediation runtime-verification finding (NORYX SPHERE final
    // runtime quality gate — Table 19.1 #12/#13): both checks below
    // threw BadRequestException (400), but the proposal is explicit
    // both here and at §19 Table 19.1 items 12/20 ("Duplicate allocation
    // ... 422 — validateAllocationsShapeOrThrow()'s existing duplicate
    // check (unmodified)") that this method's own rejections are 422,
    // not 400 — a pre-existing mismatch between spec and implementation,
    // never caught by source inspection, only by actually running
    // on-account-allocation.e2e-spec.ts's #12/#13 against a live server.
    // Corrected to UnprocessableEntityException for both throws.
    const uniqueBillIds = [...new Set(allocations.map((a) => a.billId))];
    if (uniqueBillIds.length !== allocations.length) {
      throw new UnprocessableEntityException(
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
      throw new UnprocessableEntityException(
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

  /** `allocationDate` is required on every inserted row (schema.ts,
   * proposal §15.1) — create()/update() both pass the payment's own
   * (possibly just-patched) paymentDate, since every row created through
   * this path is, by construction, contemporaneous with the payment
   * itself (only applyAllocation()'s own INSERT, §9.1 Step 13, ever
   * writes a materially different allocationDate). */
  private async insertAllocations(
    tx: TxClient,
    tenantId: string,
    paymentId: string,
    allocations: CreateSupplierPaymentAllocationDto[],
    allocationDate: string,
  ): Promise<SupplierPaymentAllocation[]> {
    // CTO remediation runtime-verification finding (NORYX SPHERE final
    // runtime quality gate — on-account AP e2e, "#1 — posts with ZERO
    // allocations"): Drizzle's `.insert().values(...)` throws
    // synchronously ("values() must be called with at least one value")
    // when given an empty array — never reachable via source inspection
    // alone, only by actually posting a zero-allocation (on-account)
    // payment, which is this work item's own primary scenario. Every
    // caller (create(), update()) is otherwise correct to pass an empty
    // `allocations` array through unconditionally; the empty case simply
    // means "no rows to insert", so short-circuit before Drizzle sees it.
    if (allocations.length === 0) {
      return [];
    }
    return tx
      .insert(supplierPaymentAllocations)
      .values(
        allocations.map((allocation) => ({
          tenantId,
          paymentId,
          billId: allocation.billId,
          allocatedAmountMinor: allocation.allocatedAmountMinor,
          allocationDate,
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
