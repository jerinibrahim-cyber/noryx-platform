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
  suppliers,
  supplierBills,
  supplierDebitNotes,
  supplierDebitNoteLines,
  supplierDebitNoteAllocations,
  journalEntries,
  journalLines,
  type AccountingPeriod,
  type ApSettings,
  type Supplier,
  type SupplierBill,
  type SupplierDebitNote,
  type SupplierDebitNoteLine,
  type SupplierDebitNoteAllocation,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateSupplierDebitNoteDto } from "./dto/create-supplier-debit-note.dto";
import type { CreateSupplierDebitNoteLineDto } from "./dto/create-supplier-debit-note-line.dto";
import type { CreateSupplierDebitNoteAllocationDto } from "./dto/create-supplier-debit-note-allocation.dto";
import type { UpdateSupplierDebitNoteDto } from "./dto/update-supplier-debit-note.dto";

export type SupplierDebitNoteWithDetails = SupplierDebitNote & {
  lines: SupplierDebitNoteLine[];
  allocations: SupplierDebitNoteAllocation[];
};

export interface ListSupplierDebitNotesFilters {
  status?: "DRAFT" | "POSTED";
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Supplier debit notes, lines & allocations — the Credit/Debit Notes
 * work item (docs/finance-work-item-credit-debit-notes-proposal.md §5,
 * §9, §10, §13, CTO-approved — "PROCEED WITH IMPLEMENTATION"). Exact AP
 * structural mirror of CustomerCreditNotesService, applied to
 * suppliers/supplier_bills instead of customers/customer_invoices.
 *
 * A debit note combines TWO existing patterns: it has LINES like
 * SupplierBillsService (its own subtotal/tax/total, distributed across
 * accounts) AND ALLOCATIONS like SupplierPaymentsService (it settles
 * against one or more already-POSTED bills of the same supplier). Draft
 * CRUD mirrors both services' create/list/findOne/update/remove shape
 * exactly (full-array-replacement on update for BOTH lines and
 * allocations, DRAFT-only edit/delete, SELECT ... FOR UPDATE before any
 * status-dependent mutation).
 *
 * post() does NOT call JournalEntriesService, same architectural
 * reasoning as every other Finance write path — direct insertion into
 * the shared journal_entries/journal_lines/journal_number_counters
 * tables, with multi-bill row locking in a fixed ascending-id order
 * (same deadlock-avoidance reasoning as SupplierPaymentsService.post()).
 *
 * Accounting polarity is the bill's own polarity REVERSED (proposal
 * §9): Dr apSettings.apControlAccountId / Cr each line's account (+ Cr
 * apSettings.taxInputAccountId if tax > 0) — AP and expense both
 * decrease. Locked CTO decision: allocations settle directly against
 * supplier_bills.paidMinor/paymentStatus — no separate debitedMinor
 * column. A debit note cannot create negative outstanding or "debit on
 * account": every allocation is validated against the bill's existing
 * (totalMinor - paidMinor) outstanding amount under lock, and the full
 * debit-note total must be allocated to post — a fully-paid bill
 * therefore rejects a further allocation with 422, by construction.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class SupplierDebitNotesService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateSupplierDebitNoteDto,
  ): Promise<SupplierDebitNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateSupplierRefOrThrow(tx, legalEntityId, dto.supplierId);
      await this.validateLineAccountsOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.lines,
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
      const totals = this.computeTotals(dto.lines);

      const [createdDebitNote] = await tx
        .insert(supplierDebitNotes)
        .values({
          tenantId,
          legalEntityId,
          supplierId: dto.supplierId,
          debitNoteDate: dto.debitNoteDate,
          currencyCode,
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          reason: dto.reason ?? null,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedLines = await this.insertLines(
        tx,
        tenantId,
        createdDebitNote!.id,
        dto.lines,
      );
      const insertedAllocations = await this.insertAllocations(
        tx,
        tenantId,
        createdDebitNote!.id,
        dto.allocations,
      );

      const full: SupplierDebitNoteWithDetails = {
        ...createdDebitNote!,
        lines: insertedLines,
        allocations: insertedAllocations,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "supplier_debit_note",
        entityId: createdDebitNote!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListSupplierDebitNotesFilters,
  ): Promise<SupplierDebitNote[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(supplierDebitNotes.tenantId, tenantId),
        eq(supplierDebitNotes.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(supplierDebitNotes.status, filters.status));
      }
      if (filters.supplierId) {
        conditions.push(eq(supplierDebitNotes.supplierId, filters.supplierId));
      }
      if (filters.dateFrom) {
        conditions.push(
          gte(supplierDebitNotes.debitNoteDate, filters.dateFrom),
        );
      }
      if (filters.dateTo) {
        conditions.push(lte(supplierDebitNotes.debitNoteDate, filters.dateTo));
      }
      return tx
        .select()
        .from(supplierDebitNotes)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<SupplierDebitNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(
          `No supplier debit note found with id ${id}.`,
        );
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateSupplierDebitNoteDto,
  ): Promise<SupplierDebitNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No supplier debit note found with id ${id}.`,
        );
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot edit a posted supplier debit note.",
        );
      }

      if (dto.lines) {
        await this.validateLineAccountsOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.lines,
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

      const headerPatch: Partial<typeof supplierDebitNotes.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.debitNoteDate !== undefined) {
        headerPatch.debitNoteDate = dto.debitNoteDate;
      }
      if (dto.reason !== undefined) {
        headerPatch.reason = dto.reason;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }
      if (dto.lines) {
        const totals = this.computeTotals(dto.lines);
        headerPatch.subtotalMinor = totals.subtotalMinor;
        headerPatch.taxMinor = totals.taxMinor;
        headerPatch.totalMinor = totals.totalMinor;
      }

      await tx
        .update(supplierDebitNotes)
        .set(headerPatch)
        .where(
          and(
            eq(supplierDebitNotes.id, id),
            eq(supplierDebitNotes.tenantId, tenantId),
            eq(supplierDebitNotes.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        await tx
          .delete(supplierDebitNoteLines)
          .where(eq(supplierDebitNoteLines.debitNoteId, id));
        await this.insertLines(tx, tenantId, id, dto.lines);
      }
      if (dto.allocations) {
        await tx
          .delete(supplierDebitNoteAllocations)
          .where(eq(supplierDebitNoteAllocations.debitNoteId, id));
        await this.insertAllocations(tx, tenantId, id, dto.allocations);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "supplier_debit_note",
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
  ): Promise<SupplierDebitNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No supplier debit note found with id ${id}.`,
        );
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot delete a posted supplier debit note.",
        );
      }

      await tx
        .delete(supplierDebitNotes)
        .where(
          and(
            eq(supplierDebitNotes.id, id),
            eq(supplierDebitNotes.tenantId, tenantId),
            eq(supplierDebitNotes.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "supplier_debit_note",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /debit-notes/:id/post` — DRAFT -> POSTED. Exact AP mirror of
   * CustomerCreditNotesService.post()'s combined-lines-and-allocations
   * shape.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<SupplierDebitNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No supplier debit note found with id ${id}.`,
        );
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "This supplier debit note is already posted.",
        );
      }

      // Step 3: at least 1 line.
      if (before.lines.length < 1) {
        throw new UnprocessableEntityException(
          "A supplier debit note must have at least 1 line to be posted.",
        );
      }

      // Step 4: a debit note must allocate to post — no "debit on
      // account" (proposal §9, CTO-approved).
      if (before.allocations.length < 1) {
        throw new UnprocessableEntityException(
          "A supplier debit note must have at least 1 allocation to be posted.",
        );
      }

      // Step 5: re-validate every line's account.
      await this.revalidateLineAccountsForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.lines,
      );

      // Step 6: load AP settings; validate the tax-input account is
      // configured if this debit note carries any tax.
      const settings = await this.loadApSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );
      const taxTotal = before.lines.reduce(
        (sum, l) => sum + l.taxAmountMinor,
        0,
      );
      if (taxTotal > 0 && !settings.taxInputAccountId) {
        throw new UnprocessableEntityException(
          "This debit note has tax amounts but no tax input account is configured in AP settings for this legal entity.",
        );
      }

      // Step 7: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.debitNoteDate,
      );

      // Step 8: lock every allocated bill in ONE statement, in a fixed
      // ascending-id order.
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

      // Step 9: re-validate each allocated bill under lock — status,
      // same supplier, and sufficient remaining outstanding balance
      // (paidMinor-based — the locked CTO decision). A fully-paid bill's
      // outstanding is 0, so any allocation against it fails here with
      // 422 — "no refund/on-account functionality" is enforced
      // structurally, not by a separate check.
      for (const allocation of before.allocations) {
        const bill = billsById.get(allocation.billId);
        if (!bill) {
          throw new UnprocessableEntityException(
            `Allocated bill ${allocation.billId} could not be found in this legal entity.`,
          );
        }
        if (bill.status !== "POSTED") {
          throw new UnprocessableEntityException(
            `Bill ${allocation.billId} is not posted and cannot receive a debit-note allocation.`,
          );
        }
        if (bill.supplierId !== before.supplierId) {
          throw new UnprocessableEntityException(
            `Bill ${allocation.billId} does not belong to this debit note's supplier.`,
          );
        }
        const outstanding = bill.totalMinor - bill.paidMinor;
        if (allocation.allocatedAmountMinor > outstanding) {
          throw new UnprocessableEntityException(
            `Allocation of ${allocation.allocatedAmountMinor} to bill ${allocation.billId} exceeds its outstanding balance of ${outstanding}.`,
          );
        }
      }

      // Step 10: full-allocation requirement — no "debit on account".
      const allocatedTotal = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (allocatedTotal !== before.totalMinor) {
        throw new UnprocessableEntityException(
          `Total allocated amount (${allocatedTotal}) must equal the debit note total (${before.totalMinor}) to post.`,
        );
      }

      // Step 11: atomic debit-note-number allocation — a SEPARATE
      // counter from every other Finance document's own number sequence.
      const internalReference = await this.allocateDebitNoteNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 12: atomic journal-number allocation from the SAME sequence
      // every other Finance write path uses.
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 13: insert the journal entry header as DRAFT first, then
      // its lines, then flip to POSTED in a separate UPDATE below.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.debitNoteDate,
          currencyCode: before.currencyCode,
          memo: `Supplier debit note ${internalReference}`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      // Accounting polarity — the bill's own polarity reversed (proposal
      // §9): DEBIT the AP control account, CREDIT each line's account
      // (+ CREDIT tax-input). AP and expense both decrease.
      const journalLineValues: (typeof journalLines.$inferInsert)[] = [
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 1,
          accountId: settings.apControlAccountId,
          debitMinor: before.totalMinor,
          creditMinor: 0,
          description: `AP control — debit note ${internalReference}`,
        },
      ];
      let lineNumber = 2;
      for (const line of before.lines) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: line.accountId,
          debitMinor: 0,
          creditMinor: line.amountMinor,
          description:
            line.description ?? `Debit note ${internalReference} line`,
        });
      }
      if (taxTotal > 0) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: settings.taxInputAccountId!,
          debitMinor: 0,
          creditMinor: taxTotal,
          description: `Tax on debit note ${internalReference}`,
        });
      }

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

      // Step 14: commit the debit note's own transition.
      const [posted] = await tx
        .update(supplierDebitNotes)
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
            eq(supplierDebitNotes.id, id),
            eq(supplierDebitNotes.tenantId, tenantId),
            eq(supplierDebitNotes.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      // Step 15: settle each allocated bill, still within the same
      // transaction. CRITICAL — this UPDATE must NOT include updated_at
      // in its SET clause: 005_supplier_bills_immutability_trigger.sql
      // rejects any change to a POSTED row's updated_at alongside
      // paid_minor/payment_status. This is the CTO-approved reuse of
      // paidMinor/paymentStatus — no separate debitedMinor column.
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

      const after: SupplierDebitNoteWithDetails = {
        ...posted!,
        lines: before.lines,
        allocations: before.allocations,
      };

      // Step 16: audit — POST against the debit note, CREATE against the
      // new journal entry, one UPDATE row per settled bill.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "supplier_debit_note",
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

  /** Every line's accountId must resolve to an existing, active
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — create/edit-time validation, 400. No type restriction, same
   * posture as SupplierBillsService.validateLineAccountsOrThrow. */
  private async validateLineAccountsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateSupplierDebitNoteLineDto[],
  ): Promise<void> {
    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      lines.map((l) => l.accountId),
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  /** Posting-time re-validation of every line's account. 422, not 400. */
  private async revalidateLineAccountsForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: SupplierDebitNoteLine[],
  ): Promise<void> {
    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      lines.map((l) => l.accountId),
    );
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  private async findInvalidAccountIds(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(accountIds)];
    const validAccounts = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
          inArray(chartOfAccounts.id, uniqueIds),
        ),
      );
    const validIds = new Set(validAccounts.map((a) => a.id));
    return uniqueIds.filter((accId) => !validIds.has(accId));
  }

  /** Every allocation's billId must resolve to an existing bill in the
   * caller's own (tenantId, legalEntityId) belonging to the same
   * supplier as the debit note — create/edit-time SHAPE validation only
   * (400). Deliberately does not require the bill to be POSTED yet, or
   * check its outstanding balance — those are posting-time concerns,
   * same create-time-vs-post-time split as
   * SupplierPaymentsService.validateAllocationsShapeOrThrow. */
  private async validateAllocationsShapeOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    supplierId: string,
    allocations: CreateSupplierDebitNoteAllocationDto[],
  ): Promise<void> {
    const uniqueBillIds = [...new Set(allocations.map((a) => a.billId))];
    if (uniqueBillIds.length !== allocations.length) {
      throw new BadRequestException(
        "A debit note may allocate to a given bill at most once — combine amounts into a single allocation entry.",
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
        `The following bill id(s) do not refer to bills belonging to this debit note's supplier in this legal entity: ${invalid.join(", ")}.`,
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

  /** Resolves the accounting period covering `debitNoteDate`, locked via
   * `SELECT ... FOR UPDATE`. Identical query/lock shape to
   * SupplierBillsService.resolveAndLockOpenPeriod, duplicated locally. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    debitNoteDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, debitNoteDate),
          gte(accountingPeriods.endDate, debitNoteDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers debit note date ${debitNoteDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${debitNoteDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free debit-note-number allocation via
   * supplier_debit_note_number_counters' atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE table
   * from every other Finance document's own number counter. Formatted
   * `DBN-{n:06d}`, scoped per legal entity. */
  private async allocateDebitNoteNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO supplier_debit_note_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = supplier_debit_note_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `DBN-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row every other Finance write path uses —
   * identical atomic pattern, duplicated locally rather than sharing via
   * a cross-service call. Formatted `JE-{n:06d}`, scoped per legal
   * entity. */
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

  private async insertLines(
    tx: TxClient,
    tenantId: string,
    debitNoteId: string,
    lines: CreateSupplierDebitNoteLineDto[],
  ): Promise<SupplierDebitNoteLine[]> {
    return tx
      .insert(supplierDebitNoteLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          debitNoteId,
          lineNumber: index + 1,
          accountId: line.accountId,
          description: line.description ?? null,
          amountMinor: line.amountMinor,
          taxAmountMinor: line.taxAmountMinor ?? 0,
        })),
      )
      .returning();
  }

  private async insertAllocations(
    tx: TxClient,
    tenantId: string,
    debitNoteId: string,
    allocations: CreateSupplierDebitNoteAllocationDto[],
  ): Promise<SupplierDebitNoteAllocation[]> {
    return tx
      .insert(supplierDebitNoteAllocations)
      .values(
        allocations.map((allocation) => ({
          tenantId,
          debitNoteId,
          billId: allocation.billId,
          allocatedAmountMinor: allocation.allocatedAmountMinor,
        })),
      )
      .returning();
  }

  /** subtotalMinor = SUM(line.amountMinor), taxMinor =
   * SUM(line.taxAmountMinor), totalMinor = subtotalMinor + taxMinor —
   * server-computed, never client-supplied. Identical to
   * SupplierBillsService.computeTotals. */
  private computeTotals(lines: CreateSupplierDebitNoteLineDto[]): {
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
  } {
    const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    const taxMinor = lines.reduce((sum, l) => sum + (l.taxAmountMinor ?? 0), 0);
    return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
  }

  /** Scoped by (id, tenantId, legalEntityId) — same convention as every
   * other Finance service. `options.forUpdate` acquires
   * `SELECT ... FOR UPDATE` on the header row. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SupplierDebitNoteWithDetails | undefined> {
    const condition = and(
      eq(supplierDebitNotes.id, id),
      eq(supplierDebitNotes.tenantId, tenantId),
      eq(supplierDebitNotes.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(supplierDebitNotes)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(supplierDebitNotes).where(condition).limit(1);
    const debitNote = rows[0];
    if (!debitNote) return undefined;

    const lines = await tx
      .select()
      .from(supplierDebitNoteLines)
      .where(eq(supplierDebitNoteLines.debitNoteId, id))
      .orderBy(asc(supplierDebitNoteLines.lineNumber));

    const allocations = await tx
      .select()
      .from(supplierDebitNoteAllocations)
      .where(eq(supplierDebitNoteAllocations.debitNoteId, id));

    return { ...debitNote, lines, allocations };
  }
}
