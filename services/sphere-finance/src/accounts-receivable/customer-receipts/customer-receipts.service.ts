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
  customerReceipts,
  customerReceiptAllocations,
  journalEntries,
  journalLines,
  type AccountingPeriod,
  type ArSettings,
  type Customer,
  type CustomerInvoice,
  type CustomerReceipt,
  type CustomerReceiptAllocation,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateCustomerReceiptDto } from "./dto/create-customer-receipt.dto";
import type { CreateCustomerReceiptAllocationDto } from "./dto/create-customer-receipt-allocation.dto";
import type { UpdateCustomerReceiptDto } from "./dto/update-customer-receipt.dto";

export type CustomerReceiptWithAllocations = CustomerReceipt & {
  allocations: CustomerReceiptAllocation[];
};

export interface ListCustomerReceiptsFilters {
  status?: "DRAFT" | "POSTED";
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Customer receipts & allocations — AR-1c
 * (docs/finance-work-item-1c-customer-receipts-proposal.md §6, §9, §10,
 * §13, §18 — CTO-approved).
 *
 * Draft CRUD mirrors SupplierPaymentsService's create/list/findOne/
 * update/remove shape exactly (full-array-replacement on update,
 * DRAFT-only edit/delete, SELECT ... FOR UPDATE before any
 * status-dependent mutation). post() replicates the same direct-
 * Journal-Engine-posting shape AR-1b/AP-1b/AP-1c established — direct
 * insertion into the shared journal_entries/journal_lines/
 * journal_number_counters tables rather than calling
 * JournalEntriesService, for the identical transaction-atomicity reason
 * — extended here with multi-invoice row locking in a fixed order
 * (ascending id) so two concurrent receipts touching an overlapping
 * invoice set can never deadlock each other (proposal §13 step 7,
 * restating the AP Foundation proposal's own §15 locking strategy).
 *
 * The accounting polarity is the mirror image of AP-1c's payment entry:
 * DEBIT the bank/cash account, CREDIT the AR control account (proposal
 * §9) — cash increases, the receivable decreases.
 *
 * The ENTIRE post() operation — header lock, validation, invoice
 * locking/re-validation, numbering, journal entry/lines, the receipt's
 * own status transition, every settled invoice's paid_minor/
 * payment_status update, and every audit row — executes inside the
 * single transaction withTenant() opens for this call. There is no
 * intermediate commit anywhere in post(): Postgres does not durably
 * persist any of it until withTenant()'s real COMMIT, issued once (and
 * only once) this async callback returns without throwing. A failure at
 * any step rolls every prior write in this same call back together
 * (proposal §13, CTO-approved correction 1).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class CustomerReceiptsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateCustomerReceiptDto,
  ): Promise<CustomerReceiptWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateCustomerRefOrThrow(tx, legalEntityId, dto.customerId);
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
        dto.customerId,
        dto.allocations,
      );

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );

      const [createdReceipt] = await tx
        .insert(customerReceipts)
        .values({
          tenantId,
          legalEntityId,
          customerId: dto.customerId,
          receiptDate: dto.receiptDate,
          currencyCode,
          receiptAmountMinor: dto.receiptAmountMinor,
          receiptMethod: dto.receiptMethod,
          bankCashAccountId: dto.bankCashAccountId,
          reference: dto.reference ?? null,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedAllocations = await this.insertAllocations(
        tx,
        tenantId,
        createdReceipt!.id,
        dto.allocations,
      );

      const full: CustomerReceiptWithAllocations = {
        ...createdReceipt!,
        allocations: insertedAllocations,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "customer_receipt",
        entityId: createdReceipt!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListCustomerReceiptsFilters,
  ): Promise<CustomerReceipt[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(customerReceipts.tenantId, tenantId),
        eq(customerReceipts.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(customerReceipts.status, filters.status));
      }
      if (filters.customerId) {
        conditions.push(eq(customerReceipts.customerId, filters.customerId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(customerReceipts.receiptDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(customerReceipts.receiptDate, filters.dateTo));
      }
      return tx
        .select()
        .from(customerReceipts)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<CustomerReceiptWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No customer receipt found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateCustomerReceiptDto,
  ): Promise<CustomerReceiptWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer receipt found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted customer receipt.");
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
          before.customerId,
          dto.allocations,
        );
      }

      const headerPatch: Partial<typeof customerReceipts.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.receiptDate !== undefined) {
        headerPatch.receiptDate = dto.receiptDate;
      }
      if (dto.receiptAmountMinor !== undefined) {
        headerPatch.receiptAmountMinor = dto.receiptAmountMinor;
      }
      if (dto.receiptMethod !== undefined) {
        headerPatch.receiptMethod = dto.receiptMethod;
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
        .update(customerReceipts)
        .set(headerPatch)
        .where(
          and(
            eq(customerReceipts.id, id),
            eq(customerReceipts.tenantId, tenantId),
            eq(customerReceipts.legalEntityId, legalEntityId),
          ),
        );

      if (dto.allocations) {
        // Full-array replacement, not allocation-level add/remove — same
        // convention as SupplierPaymentsService.update()'s allocation
        // handling.
        await tx
          .delete(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, id));
        await this.insertAllocations(tx, tenantId, id, dto.allocations);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "customer_receipt",
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
  ): Promise<CustomerReceiptWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer receipt found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted customer receipt.");
      }

      // customer_receipt_allocations rows cascade via the existing FK's
      // onDelete: "cascade".
      await tx
        .delete(customerReceipts)
        .where(
          and(
            eq(customerReceipts.id, id),
            eq(customerReceipts.tenantId, tenantId),
            eq(customerReceipts.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "customer_receipt",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /receipts/:id/post` — DRAFT -> POSTED. Proposal §13's 14-step
   * shape: lock, status, allocation-count, bank/cash account
   * re-validation, AR settings load, period resolution+lock, fixed-order
   * multi-invoice locking, per-invoice re-validation, exact-allocation-
   * sum check, receipt-number allocation, journal-number allocation,
   * direct journal_entries/journal_lines insertion (DRAFT-then-POST
   * ordering — see the inline note below), the receipt's own status
   * update, per-invoice paid_minor/payment_status updates, and the audit
   * rows — ALL inside one transaction, with the real COMMIT occurring
   * only after every step below succeeds (CTO-approved correction 1). A
   * failure at any step rolls the whole transaction back — no burned
   * receipt number, no burned journal number, no orphaned journal entry,
   * no partial invoice update, from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<CustomerReceiptWithAllocations> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer receipt found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This customer receipt is already posted.");
      }

      // Step 3: a receipt must allocate to post — no bare unapplied
      // receipt in this Work Item (proposal §10).
      if (before.allocations.length < 1) {
        throw new UnprocessableEntityException(
          "A customer receipt must have at least 1 allocation to be posted.",
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

      // Step 5: load AR settings (the same arControlAccountId invoices
      // already use).
      const settings = await this.loadArSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 6: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.receiptDate,
      );

      // Step 7: lock every allocated invoice in ONE statement, in a
      // fixed ascending-id order — two concurrent receipts touching an
      // overlapping invoice set always acquire row locks in the same
      // relative order, so neither can deadlock the other (proposal §13
      // step 7).
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

      // Step 8: re-validate each allocated invoice under lock — status,
      // same customer, and sufficient remaining balance — independently
      // of whatever passed at create/edit time (another receipt may
      // have posted against the same invoice since).
      for (const allocation of before.allocations) {
        const invoice = invoicesById.get(allocation.invoiceId);
        if (!invoice) {
          throw new UnprocessableEntityException(
            `Allocated invoice ${allocation.invoiceId} could not be found in this legal entity.`,
          );
        }
        if (invoice.status !== "POSTED") {
          throw new UnprocessableEntityException(
            `Invoice ${allocation.invoiceId} is not posted and cannot receive a receipt allocation.`,
          );
        }
        if (invoice.customerId !== before.customerId) {
          throw new UnprocessableEntityException(
            `Invoice ${allocation.invoiceId} does not belong to this receipt's customer.`,
          );
        }
        const outstanding = invoice.totalMinor - invoice.paidMinor;
        if (allocation.allocatedAmountMinor > outstanding) {
          throw new UnprocessableEntityException(
            `Allocation of ${allocation.allocatedAmountMinor} to invoice ${allocation.invoiceId} exceeds its outstanding balance of ${outstanding}.`,
          );
        }
      }

      // Step 9: full-allocation requirement — no "receipt on account" in
      // this Work Item (proposal §4/§10).
      const allocatedTotal = before.allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      if (allocatedTotal !== before.receiptAmountMinor) {
        throw new UnprocessableEntityException(
          `Total allocated amount (${allocatedTotal}) must equal the receipt amount (${before.receiptAmountMinor}) to post.`,
        );
      }

      // Step 10: atomic receipt-number allocation — a SEPARATE counter
      // from ar_number_counters (CTO-approved decision 1, proposal §14).
      const internalReference = await this.allocateReceiptNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 11: atomic journal-number allocation from the SAME sequence
      // real journal entries, invoices, bills, and payments use — no
      // AR-receipt-only journal-number series.
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 12: insert the journal entry header as DRAFT first, then
      // its lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED. journal_lines_immutable blocks any
      // INSERT once its parent journal_entries row is POSTED.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.receiptDate,
          currencyCode: before.currencyCode,
          memo: `Receipt ${internalReference} from customer (bank/cash account posting)`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      // Accounting polarity — the mirror image of AP-1c's payment entry
      // (proposal §9): DEBIT bank/cash (asset increases), CREDIT AR
      // control (asset decreases).
      const journalLineValues: (typeof journalLines.$inferInsert)[] = [
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 1,
          accountId: before.bankCashAccountId,
          debitMinor: before.receiptAmountMinor,
          creditMinor: 0,
          description: `Bank/cash — receipt ${internalReference}`,
        },
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 2,
          accountId: settings.arControlAccountId,
          debitMinor: 0,
          creditMinor: before.receiptAmountMinor,
          description: `AR control — receipt ${internalReference}`,
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

      // Step 13: update the receipt's status/internalReference/
      // journalEntryId/periodId/postedBy/postedAt WITHIN THE SAME
      // TRANSACTION. Do not commit yet — this is an UPDATE statement
      // against the still-open transaction, not a durability boundary;
      // the settlement updates and audit rows below still have to
      // succeed before any of this becomes durable (proposal §13,
      // CTO-approved correction 1).
      const [posted] = await tx
        .update(customerReceipts)
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
            eq(customerReceipts.id, id),
            eq(customerReceipts.tenantId, tenantId),
            eq(customerReceipts.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      // Step 14: settle each allocated invoice, still within the same
      // transaction. CRITICAL — this UPDATE must NOT include updated_at
      // in its SET clause: 009_customer_invoices_immutability_trigger.sql
      // rejects any change to a POSTED row's updated_at alongside
      // paid_minor/payment_status (checked column-by-column, by design —
      // the exact exception AR-1b's own migration built in ahead of this
      // Work Item — proposal §11).
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

      const after: CustomerReceiptWithAllocations = {
        ...posted!,
        allocations: before.allocations,
      };

      // Still within the same transaction: audit — POST against the
      // receipt, CREATE against the new journal entry, one UPDATE row
      // per settled invoice (proposal §13 step 14 / §16 — "audit all
      // financially significant state changes"). Only after this insert
      // succeeds does the enclosing withTenant() call issue the actual
      // COMMIT — the receipt's status update, every invoice's settlement
      // update, the journal entry/lines, and these audit rows all become
      // durable together, in one atomic COMMIT, or none of them do.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "customer_receipt",
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

  /** bankCashAccountId must resolve to an existing, active, type-ASSET
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — create/edit-time validation, 400. Type-restricted the same way
   * ar_settings.arControlAccountId is restricted to ASSET — "bank/cash
   * account" is unambiguously an asset by definition, identical posture
   * to SupplierPaymentsService.validateBankCashAccountOrThrow. */
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
   * SupplierPaymentsService.revalidateBankCashAccountForPostingOrThrow. */
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

  /** Every allocation's invoiceId must resolve to an existing invoice in
   * the caller's own (tenantId, legalEntityId) belonging to the same
   * customer as the receipt — create/edit-time SHAPE validation only
   * (400). Deliberately does not require the invoice to be POSTED yet,
   * or check its outstanding balance — those are posting-time concerns
   * (proposal §10's create-time-vs-post-time split), since an invoice
   * this receipt intends to settle may not be posted yet at
   * draft-creation time, and its remaining balance can legitimately
   * change before this receipt itself posts. */
  private async validateAllocationsShapeOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    customerId: string,
    allocations: CreateCustomerReceiptAllocationDto[],
  ): Promise<void> {
    const uniqueInvoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
    if (uniqueInvoiceIds.length !== allocations.length) {
      throw new BadRequestException(
        "A receipt may allocate to a given invoice at most once — combine amounts into a single allocation entry.",
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
        `The following invoice id(s) do not refer to invoices belonging to this receipt's customer in this legal entity: ${invalid.join(", ")}.`,
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

  /** Resolves the accounting period covering `receiptDate`, locked via
   * `SELECT ... FOR UPDATE`. Identical query/lock shape to
   * CustomerInvoicesService.resolveAndLockOpenPeriod, duplicated
   * locally. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    receiptDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, receiptDate),
          gte(accountingPeriods.endDate, receiptDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers receipt date ${receiptDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${receiptDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free receipt-number allocation via ar_receipt_number_counters'
   * atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE
   * table from ar_number_counters (CTO-approved decision 1, proposal
   * §14/§17). Formatted `RCT-{n:06d}`, scoped per legal entity. */
  private async allocateReceiptNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO ar_receipt_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = ar_receipt_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `RCT-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries, invoices, bills,
   * and payments use — identical atomic pattern to every other Finance
   * service's own private copy, duplicated locally rather than sharing
   * via a cross-service call. Formatted `JE-{n:06d}`, scoped per legal
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

  private async insertAllocations(
    tx: TxClient,
    tenantId: string,
    receiptId: string,
    allocations: CreateCustomerReceiptAllocationDto[],
  ): Promise<CustomerReceiptAllocation[]> {
    return tx
      .insert(customerReceiptAllocations)
      .values(
        allocations.map((allocation) => ({
          tenantId,
          receiptId,
          invoiceId: allocation.invoiceId,
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
  ): Promise<CustomerReceiptWithAllocations | undefined> {
    const condition = and(
      eq(customerReceipts.id, id),
      eq(customerReceipts.tenantId, tenantId),
      eq(customerReceipts.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(customerReceipts)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(customerReceipts).where(condition).limit(1);
    const receipt = rows[0];
    if (!receipt) return undefined;

    const allocations = await tx
      .select()
      .from(customerReceiptAllocations)
      .where(eq(customerReceiptAllocations.receiptId, id));

    return { ...receipt, allocations };
  }
}
