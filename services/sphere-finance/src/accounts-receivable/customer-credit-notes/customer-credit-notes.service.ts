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
  arSettings,
  chartOfAccounts,
  customers,
  customerInvoices,
  customerCreditNotes,
  customerCreditNoteLines,
  customerCreditNoteAllocations,
  journalEntries,
  journalLines,
  type AccountingPeriod,
  type ArSettings,
  type Customer,
  type CustomerInvoice,
  type CustomerCreditNote,
  type CustomerCreditNoteLine,
  type CustomerCreditNoteAllocation,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateCustomerCreditNoteDto } from "./dto/create-customer-credit-note.dto";
import type { CreateCustomerCreditNoteLineDto } from "./dto/create-customer-credit-note-line.dto";
import type { CreateCustomerCreditNoteAllocationDto } from "./dto/create-customer-credit-note-allocation.dto";
import type { UpdateCustomerCreditNoteDto } from "./dto/update-customer-credit-note.dto";

export type CustomerCreditNoteWithDetails = CustomerCreditNote & {
  lines: CustomerCreditNoteLine[];
  allocations: CustomerCreditNoteAllocation[];
};

export interface ListCustomerCreditNotesFilters {
  status?: "DRAFT" | "POSTED";
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Customer credit notes, lines & allocations — the Credit/Debit Notes
 * work item (docs/finance-work-item-credit-debit-notes-proposal.md §5,
 * §9, §10, §13, CTO-approved — "PROCEED WITH IMPLEMENTATION").
 *
 * A credit note combines TWO existing patterns: it has LINES like
 * CustomerInvoicesService (its own subtotal/tax/total, distributed
 * across accounts) AND ALLOCATIONS like CustomerReceiptsService (it
 * settles against one or more already-POSTED invoices of the same
 * customer). Draft CRUD mirrors both services' create/list/findOne/
 * update/remove shape exactly (full-array-replacement on update for
 * BOTH lines and allocations, DRAFT-only edit/delete, SELECT ... FOR
 * UPDATE before any status-dependent mutation).
 *
 * post() does NOT call JournalEntriesService, same architectural
 * reasoning as every other Finance write path (transaction-atomicity
 * mismatch) — direct insertion into the shared journal_entries/
 * journal_lines/journal_number_counters tables, extended with
 * multi-invoice row locking in a fixed ascending-id order (same
 * deadlock-avoidance reasoning as CustomerReceiptsService.post()).
 *
 * Accounting polarity is the invoice's own polarity REVERSED (proposal
 * §9): Dr each line's account (+ Dr arSettings.taxOutputAccountId if
 * tax > 0) / Cr arSettings.arControlAccountId — revenue and AR both
 * decrease. Locked CTO decision: allocations settle directly against
 * customer_invoices.paidMinor/paymentStatus — no separate creditedMinor
 * column. A credit note cannot create negative outstanding or "credit on
 * account": every allocation is validated against the invoice's existing
 * (totalMinor - paidMinor) outstanding amount under lock, and the full
 * credit-note total must be allocated to post (mirrors AR-1c's own "no
 * receipt on account" rule exactly) — a fully-paid invoice therefore
 * rejects a further allocation with 422, by construction.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class CustomerCreditNotesService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateCustomerCreditNoteDto,
  ): Promise<CustomerCreditNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateCustomerRefOrThrow(tx, legalEntityId, dto.customerId);
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
        dto.customerId,
        dto.allocations,
      );

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );
      const totals = this.computeTotals(dto.lines);

      const [createdCreditNote] = await tx
        .insert(customerCreditNotes)
        .values({
          tenantId,
          legalEntityId,
          customerId: dto.customerId,
          creditNoteDate: dto.creditNoteDate,
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
        createdCreditNote!.id,
        dto.lines,
      );
      const insertedAllocations = await this.insertAllocations(
        tx,
        tenantId,
        createdCreditNote!.id,
        dto.allocations,
      );

      const full: CustomerCreditNoteWithDetails = {
        ...createdCreditNote!,
        lines: insertedLines,
        allocations: insertedAllocations,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "customer_credit_note",
        entityId: createdCreditNote!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListCustomerCreditNotesFilters,
  ): Promise<CustomerCreditNote[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(customerCreditNotes.tenantId, tenantId),
        eq(customerCreditNotes.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(customerCreditNotes.status, filters.status));
      }
      if (filters.customerId) {
        conditions.push(eq(customerCreditNotes.customerId, filters.customerId));
      }
      if (filters.dateFrom) {
        conditions.push(
          gte(customerCreditNotes.creditNoteDate, filters.dateFrom),
        );
      }
      if (filters.dateTo) {
        conditions.push(
          lte(customerCreditNotes.creditNoteDate, filters.dateTo),
        );
      }
      return tx
        .select()
        .from(customerCreditNotes)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<CustomerCreditNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(
          `No customer credit note found with id ${id}.`,
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
    dto: UpdateCustomerCreditNoteDto,
  ): Promise<CustomerCreditNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No customer credit note found with id ${id}.`,
        );
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot edit a posted customer credit note.",
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
          before.customerId,
          dto.allocations,
        );
      }

      const headerPatch: Partial<typeof customerCreditNotes.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.creditNoteDate !== undefined) {
        headerPatch.creditNoteDate = dto.creditNoteDate;
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
        .update(customerCreditNotes)
        .set(headerPatch)
        .where(
          and(
            eq(customerCreditNotes.id, id),
            eq(customerCreditNotes.tenantId, tenantId),
            eq(customerCreditNotes.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        // Full-array replacement, not line-level add/remove — same
        // convention as CustomerInvoicesService.update()'s line handling.
        await tx
          .delete(customerCreditNoteLines)
          .where(eq(customerCreditNoteLines.creditNoteId, id));
        await this.insertLines(tx, tenantId, id, dto.lines);
      }
      if (dto.allocations) {
        // Full-array replacement, not allocation-level add/remove — same
        // convention as CustomerReceiptsService.update()'s allocation
        // handling.
        await tx
          .delete(customerCreditNoteAllocations)
          .where(eq(customerCreditNoteAllocations.creditNoteId, id));
        await this.insertAllocations(tx, tenantId, id, dto.allocations);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "customer_credit_note",
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
  ): Promise<CustomerCreditNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No customer credit note found with id ${id}.`,
        );
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot delete a posted customer credit note.",
        );
      }

      // customer_credit_note_lines/customer_credit_note_allocations rows
      // cascade via the existing FKs' onDelete: "cascade".
      await tx
        .delete(customerCreditNotes)
        .where(
          and(
            eq(customerCreditNotes.id, id),
            eq(customerCreditNotes.tenantId, tenantId),
            eq(customerCreditNotes.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "customer_credit_note",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /credit-notes/:id/post` — DRAFT -> POSTED. Proposal §9/§10's
   * combined-lines-and-allocations shape: lock, status, line-count,
   * allocation-count, account re-validation, AR settings + tax-account
   * validation, period resolution+lock, fixed-order multi-invoice
   * locking, per-invoice re-validation (status/customer/outstanding
   * balance), exact-allocation-sum check, credit-note-number allocation,
   * journal-number allocation, direct journal_entries/journal_lines
   * insertion (Dr each line account + Dr tax-output, Cr AR control —
   * proposal §9's reversed polarity), commit, per-invoice paid_minor/
   * payment_status updates, full audit. A failure at any step rolls the
   * whole transaction back.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<CustomerCreditNoteWithDetails> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(
          `No customer credit note found with id ${id}.`,
        );
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "This customer credit note is already posted.",
        );
      }

      // Step 3: at least 1 line (a credit note's own natural minimum,
      // same posture as CustomerInvoicesService.post()).
      if (before.lines.length < 1) {
        throw new UnprocessableEntityException(
          "A customer credit note must have at least 1 line to be posted.",
        );
      }

      // Step 4: a credit note must allocate to post — no "credit on
      // account" (proposal §9, CTO-approved), same posture as
      // CustomerReceiptsService.post().
      if (before.allocations.length < 1) {
        throw new UnprocessableEntityException(
          "A customer credit note must have at least 1 allocation to be posted.",
        );
      }

      // Step 5: re-validate every line's account, independently of
      // whatever passed at create/edit time.
      await this.revalidateLineAccountsForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.lines,
      );

      // Step 6: load AR settings; validate the tax-output account is
      // configured if this credit note carries any tax — same
      // validation CustomerInvoicesService.post() already performs.
      const settings = await this.loadArSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );
      const taxTotal = before.lines.reduce(
        (sum, l) => sum + l.taxAmountMinor,
        0,
      );
      if (taxTotal > 0 && !settings.taxOutputAccountId) {
        throw new UnprocessableEntityException(
          "This credit note has tax amounts but no tax output account is configured in AR settings for this legal entity.",
        );
      }

      // Step 7: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.creditNoteDate,
      );

      // Step 8: lock every allocated invoice in ONE statement, in a
      // fixed ascending-id order — same deadlock-avoidance reasoning as
      // CustomerReceiptsService.post() step 7.
      const invoiceIds = before.allocations.map((a) => a.invoiceId);
      const lockedInvoices = await tx
        .select()
        .from(customerInvoices)
        .where(
          and(
            inArray(customerInvoices.id, invoiceIds),
            eq(customerInvoices.tenantId, tenantId),
            eq(customerInvoices.legalEntityId, legalEntityId),
          ),
        )
        .orderBy(asc(customerInvoices.id))
        .for("update");
      const invoicesById = new Map<string, CustomerInvoice>(
        lockedInvoices.map((inv) => [inv.id, inv]),
      );

      // Step 9: re-validate each allocated invoice under lock — status,
      // same customer, and sufficient remaining outstanding balance
      // (paidMinor-based — the locked CTO decision). A fully-paid
      // invoice's outstanding is 0, so any allocation against it fails
      // here with 422 — "no refund/on-account functionality" is
      // enforced structurally, not by a separate check.
      for (const allocation of before.allocations) {
        const invoice = invoicesById.get(allocation.invoiceId);
        if (!invoice) {
          throw new UnprocessableEntityException(
            `Allocated invoice ${allocation.invoiceId} could not be found in this legal entity.`,
          );
        }
        if (invoice.status !== "POSTED") {
          throw new UnprocessableEntityException(
            `Invoice ${allocation.invoiceId} is not posted and cannot receive a credit-note allocation.`,
          );
        }
        if (invoice.customerId !== before.customerId) {
          throw new UnprocessableEntityException(
            `Invoice ${allocation.invoiceId} does not belong to this credit note's customer.`,
          );
        }
        const outstanding = invoice.totalMinor - invoice.paidMinor;
        if (allocation.allocatedAmountMinor > outstanding) {
          throw new UnprocessableEntityException(
            `Allocation of ${allocation.allocatedAmountMinor} to invoice ${allocation.invoiceId} exceeds its outstanding balance of ${outstanding}.`,
          );
        }
      }

      // Step 10: full-allocation requirement — no "credit on account"
      // (proposal §9, CTO-approved, restated from step 4's count check).
      const allocatedTotal = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (allocatedTotal !== before.totalMinor) {
        throw new UnprocessableEntityException(
          `Total allocated amount (${allocatedTotal}) must equal the credit note total (${before.totalMinor}) to post.`,
        );
      }

      // Step 11: atomic credit-note-number allocation — a SEPARATE
      // counter from every other Finance document's own number sequence.
      const internalReference = await this.allocateCreditNoteNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 12: atomic journal-number allocation from the SAME sequence
      // real journal entries, invoices, bills, receipts, and payments
      // use.
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
          transactionDate: before.creditNoteDate,
          currencyCode: before.currencyCode,
          memo: `Customer credit note ${internalReference}`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      // Accounting polarity — the invoice's own polarity reversed
      // (proposal §9): DEBIT each line's account (+ DEBIT tax-output),
      // CREDIT the AR control account. Revenue and AR both decrease.
      const journalLineValues: (typeof journalLines.$inferInsert)[] = [];
      let lineNumber = 1;
      for (const line of before.lines) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: line.accountId,
          debitMinor: line.amountMinor,
          creditMinor: 0,
          description:
            line.description ?? `Credit note ${internalReference} line`,
        });
      }
      if (taxTotal > 0) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: settings.taxOutputAccountId!,
          debitMinor: taxTotal,
          creditMinor: 0,
          description: `Tax on credit note ${internalReference}`,
        });
      }
      journalLineValues.push({
        tenantId,
        journalEntryId: draftJournalEntry!.id,
        lineNumber: lineNumber++,
        accountId: settings.arControlAccountId,
        debitMinor: 0,
        creditMinor: before.totalMinor,
        description: `AR control — credit note ${internalReference}`,
      });

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

      // Step 14: commit the credit note's own transition.
      const [posted] = await tx
        .update(customerCreditNotes)
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
            eq(customerCreditNotes.id, id),
            eq(customerCreditNotes.tenantId, tenantId),
            eq(customerCreditNotes.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      // Step 15: settle each allocated invoice, still within the same
      // transaction. CRITICAL — this UPDATE must NOT include updated_at
      // in its SET clause: 009_customer_invoices_immutability_trigger.sql
      // rejects any change to a POSTED row's updated_at alongside
      // paid_minor/payment_status. This is the CTO-approved reuse of
      // paidMinor/paymentStatus — no separate creditedMinor column.
      const invoiceAuditRows: {
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
        const invoice = invoicesById.get(allocation.invoiceId)!;
        const newPaidMinor =
          invoice.paidMinor + allocation.allocatedAmountMinor;
        const newPaymentStatus =
          newPaidMinor === invoice.totalMinor
            ? "PAID"
            : newPaidMinor > 0
              ? "PARTIALLY_PAID"
              : "UNPAID";
        const [updatedInvoice] = await tx
          .update(customerInvoices)
          .set({
            paidMinor: newPaidMinor,
            paymentStatus: newPaymentStatus,
          })
          .where(eq(customerInvoices.id, invoice.id))
          .returning();
        invoiceAuditRows.push({
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "UPDATE",
          entityType: "customer_invoice",
          entityId: invoice.id,
          beforeState: invoice as unknown as Record<string, unknown>,
          afterState: updatedInvoice as unknown as Record<string, unknown>,
        });
      }

      const after: CustomerCreditNoteWithDetails = {
        ...posted!,
        lines: before.lines,
        allocations: before.allocations,
      };

      // Step 16: audit — POST against the credit note, CREATE against
      // the new journal entry, one UPDATE row per settled invoice.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "customer_credit_note",
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
        ...invoiceAuditRows,
      ]);

      return after;
    });
  }

  /** customerId must resolve to an existing, active customer in the
   * caller's own (tenantId [via RLS], legalEntityId). */
  private async validateCustomerRefOrThrow(
    tx: TxClient,
    legalEntityId: string,
    customerId: string,
  ): Promise<Customer> {
    const rows = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.legalEntityId, legalEntityId),
          eq(customers.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `customerId ${customerId} does not refer to an active customer in this legal entity.`,
      );
    }
    return rows[0]!;
  }

  /** Every line's accountId must resolve to an existing, active
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — create/edit-time validation, 400. No type restriction, same
   * posture as CustomerInvoicesService.validateLineAccountsOrThrow. */
  private async validateLineAccountsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateCustomerCreditNoteLineDto[],
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

  /** Posting-time re-validation of every line's account — independent
   * of whatever passed at draft create/edit time. 422, not 400. */
  private async revalidateLineAccountsForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CustomerCreditNoteLine[],
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

  /** Every allocation's invoiceId must resolve to an existing invoice in
   * the caller's own (tenantId, legalEntityId) belonging to the same
   * customer as the credit note — create/edit-time SHAPE validation only
   * (400). Deliberately does not require the invoice to be POSTED yet,
   * or check its outstanding balance — those are posting-time concerns,
   * same create-time-vs-post-time split as
   * CustomerReceiptsService.validateAllocationsShapeOrThrow. */
  private async validateAllocationsShapeOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    customerId: string,
    allocations: CreateCustomerCreditNoteAllocationDto[],
  ): Promise<void> {
    const uniqueInvoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
    if (uniqueInvoiceIds.length !== allocations.length) {
      throw new BadRequestException(
        "A credit note may allocate to a given invoice at most once — combine amounts into a single allocation entry.",
      );
    }
    const validInvoices = await tx
      .select({ id: customerInvoices.id })
      .from(customerInvoices)
      .where(
        and(
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.legalEntityId, legalEntityId),
          eq(customerInvoices.customerId, customerId),
          inArray(customerInvoices.id, uniqueInvoiceIds),
        ),
      );
    const validIds = new Set(validInvoices.map((i) => i.id));
    const invalid = uniqueInvoiceIds.filter((invId) => !validIds.has(invId));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `The following invoice id(s) do not refer to invoices belonging to this credit note's customer in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  /** Loads ar_settings for this legal entity, within the SAME posting
   * transaction. 422, not 404 — same reasoning as
   * CustomerInvoicesService.loadArSettingsOrThrow. */
  private async loadArSettingsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<ArSettings> {
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
    if (rows.length === 0) {
      throw new UnprocessableEntityException(
        "AR settings have not been configured for this legal entity.",
      );
    }
    return rows[0]!;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * CustomerInvoicesService.resolveCurrency, duplicated locally. */
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

  /** Resolves the accounting period covering `creditNoteDate`, locked
   * via `SELECT ... FOR UPDATE`. Identical query/lock shape to
   * CustomerInvoicesService.resolveAndLockOpenPeriod, duplicated
   * locally. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    creditNoteDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, creditNoteDate),
          gte(accountingPeriods.endDate, creditNoteDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers credit note date ${creditNoteDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${creditNoteDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free credit-note-number allocation via
   * customer_credit_note_number_counters' atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE table
   * from every other Finance document's own number counter. Formatted
   * `CRN-{n:06d}`, scoped per legal entity. */
  private async allocateCreditNoteNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO customer_credit_note_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = customer_credit_note_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `CRN-${String(lastAssignedNumber).padStart(6, "0")}`;
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
    creditNoteId: string,
    lines: CreateCustomerCreditNoteLineDto[],
  ): Promise<CustomerCreditNoteLine[]> {
    return tx
      .insert(customerCreditNoteLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          creditNoteId,
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
    creditNoteId: string,
    allocations: CreateCustomerCreditNoteAllocationDto[],
  ): Promise<CustomerCreditNoteAllocation[]> {
    return tx
      .insert(customerCreditNoteAllocations)
      .values(
        allocations.map((allocation) => ({
          tenantId,
          creditNoteId,
          invoiceId: allocation.invoiceId,
          allocatedAmountMinor: allocation.allocatedAmountMinor,
        })),
      )
      .returning();
  }

  /** subtotalMinor = SUM(line.amountMinor), taxMinor =
   * SUM(line.taxAmountMinor), totalMinor = subtotalMinor + taxMinor —
   * server-computed, never client-supplied, matches the
   * customer_credit_notes_total_equals_subtotal_plus_tax CHECK
   * constraint by construction. Identical to
   * CustomerInvoicesService.computeTotals. */
  private computeTotals(lines: CreateCustomerCreditNoteLineDto[]): {
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
   * `SELECT ... FOR UPDATE` on the header row — used by every mutating
   * operation (update/remove/post) as their first statement. Plain
   * reads never lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<CustomerCreditNoteWithDetails | undefined> {
    const condition = and(
      eq(customerCreditNotes.id, id),
      eq(customerCreditNotes.tenantId, tenantId),
      eq(customerCreditNotes.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(customerCreditNotes)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(customerCreditNotes).where(condition).limit(1);
    const creditNote = rows[0];
    if (!creditNote) return undefined;

    const lines = await tx
      .select()
      .from(customerCreditNoteLines)
      .where(eq(customerCreditNoteLines.creditNoteId, id))
      .orderBy(asc(customerCreditNoteLines.lineNumber));

    const allocations = await tx
      .select()
      .from(customerCreditNoteAllocations)
      .where(eq(customerCreditNoteAllocations.creditNoteId, id));

    return { ...creditNote, lines, allocations };
  }
}
