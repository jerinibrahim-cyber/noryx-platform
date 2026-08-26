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
  customerInvoiceLines,
  journalEntries,
  journalLines,
  type AccountingPeriod,
  type ArSettings,
  type Customer,
  type CustomerInvoice,
  type CustomerInvoiceLine,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateCustomerInvoiceDto } from "./dto/create-customer-invoice.dto";
import type { CreateCustomerInvoiceLineDto } from "./dto/create-customer-invoice-line.dto";
import type { UpdateCustomerInvoiceDto } from "./dto/update-customer-invoice.dto";

export type CustomerInvoiceWithLines = CustomerInvoice & {
  lines: CustomerInvoiceLine[];
};

export interface ListCustomerInvoicesFilters {
  status?: "DRAFT" | "POSTED";
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Customer invoices — AR-1b
 * (docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §3, §6,
 * §8). Draft CRUD mirrors SupplierBillsService's create/list/findOne/
 * update/remove shape exactly (full-line-array-replacement on update,
 * DRAFT-only edit/delete, SELECT ... FOR UPDATE before any
 * status-dependent mutation). post() replicates
 * SupplierBillsService.post()'s 11-step transaction against
 * customer_invoices instead of supplier_bills, and inserts DIRECTLY
 * into the shared journal_entries/journal_lines/journal_number_counters
 * tables rather than calling JournalEntriesService — same architectural
 * reasoning as AP-1b (transaction-atomicity mismatch). The debit/credit
 * sides are the mirror image of AP-1b's: CREDIT revenue line(s) and the
 * tax-output account, DEBIT the AR control account (proposal §6).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service throughout.
 */
@Injectable()
export class CustomerInvoicesService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateCustomerInvoiceDto,
  ): Promise<CustomerInvoiceWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const customer = await this.validateCustomerRefOrThrow(
        tx,
        legalEntityId,
        dto.customerId,
      );
      await this.validateLineAccountsOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.lines,
      );

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );
      const dueDate =
        dto.dueDate ??
        this.computeDefaultDueDate(dto.invoiceDate, customer.paymentTermsDays);
      const totals = this.computeTotals(dto.lines);

      const [createdInvoice] = await tx
        .insert(customerInvoices)
        .values({
          tenantId,
          legalEntityId,
          customerId: dto.customerId,
          invoiceDate: dto.invoiceDate,
          dueDate: dueDate ?? null,
          currencyCode,
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedLines = await this.insertLines(
        tx,
        tenantId,
        createdInvoice!.id,
        dto.lines,
      );

      const full: CustomerInvoiceWithLines = {
        ...createdInvoice!,
        lines: insertedLines,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "customer_invoice",
        entityId: createdInvoice!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListCustomerInvoicesFilters,
  ): Promise<CustomerInvoice[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(customerInvoices.tenantId, tenantId),
        eq(customerInvoices.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(customerInvoices.status, filters.status));
      }
      if (filters.customerId) {
        conditions.push(eq(customerInvoices.customerId, filters.customerId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(customerInvoices.invoiceDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(customerInvoices.invoiceDate, filters.dateTo));
      }
      return tx
        .select()
        .from(customerInvoices)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<CustomerInvoiceWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No customer invoice found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateCustomerInvoiceDto,
  ): Promise<CustomerInvoiceWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer invoice found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted customer invoice.");
      }

      const headerPatch: Partial<typeof customerInvoices.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.invoiceDate !== undefined) {
        headerPatch.invoiceDate = dto.invoiceDate;
      }
      if (dto.dueDate !== undefined) {
        headerPatch.dueDate = dto.dueDate;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      if (dto.lines) {
        await this.validateLineAccountsOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.lines,
        );
        const totals = this.computeTotals(dto.lines);
        headerPatch.subtotalMinor = totals.subtotalMinor;
        headerPatch.taxMinor = totals.taxMinor;
        headerPatch.totalMinor = totals.totalMinor;
      }

      await tx
        .update(customerInvoices)
        .set(headerPatch)
        .where(
          and(
            eq(customerInvoices.id, id),
            eq(customerInvoices.tenantId, tenantId),
            eq(customerInvoices.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        // Full-array replacement, not line-level add/remove — same
        // convention as SupplierBillsService.update(). Fresh 1..N
        // numbering, independent of whatever numbering the replaced
        // lines had.
        await tx
          .delete(customerInvoiceLines)
          .where(eq(customerInvoiceLines.invoiceId, id));
        await this.insertLines(tx, tenantId, id, dto.lines);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "customer_invoice",
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
  ): Promise<CustomerInvoiceWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer invoice found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted customer invoice.");
      }

      // customer_invoice_lines rows cascade via the existing FK's
      // onDelete: "cascade".
      await tx
        .delete(customerInvoices)
        .where(
          and(
            eq(customerInvoices.id, id),
            eq(customerInvoices.tenantId, tenantId),
            eq(customerInvoices.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "customer_invoice",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /invoices/:id/post` — DRAFT -> POSTED. Proposal §6's 11-step
   * shape, replicated from SupplierBillsService.post() and applied to
   * an invoice instead of a bill, with the debit/credit sides mirrored:
   * lock, status, line-count, account re-validation, AR settings +
   * tax-account validation, period resolution+lock, invoice-number
   * allocation, journal-number allocation, direct journal_entries/
   * journal_lines insertion (Cr revenue lines, Cr tax-output, Dr AR
   * control), commit, dual audit. A failure at any step rolls the whole
   * transaction back — no burned invoice number, no burned journal
   * number, no orphaned journal entry, from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<CustomerInvoiceWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No customer invoice found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This customer invoice is already posted.");
      }

      // Step 3: at least 1 line (an invoice's own natural minimum —
      // unlike journal entries' >= 2, a single-line invoice is a valid
      // business document).
      if (before.lines.length < 1) {
        throw new UnprocessableEntityException(
          "A customer invoice must have at least 1 line to be posted.",
        );
      }

      // Step 4: re-validate every line's account, independently of
      // whatever passed at create/edit time — an account can be
      // archived between draft creation and posting.
      await this.revalidateLineAccountsForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.lines,
      );

      // Step 5: load AR settings; validate the tax-output account is
      // configured if this invoice carries any tax.
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
          "This invoice has tax amounts but no tax output account is configured in AR settings for this legal entity.",
        );
      }

      // Step 6: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.invoiceDate,
      );

      // Step 7: atomic invoice-number allocation — a SEPARATE counter
      // from journal_number_counters/ap_number_counters (proposal §6
      // step 7).
      const internalReference = await this.allocateInvoiceNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 8: atomic journal-number allocation from the SAME sequence
      // real journal entries use — no AR-only journal-number series
      // (proposal §6 step 8, the literal "posts through the existing
      // Journal Engine" property).
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 9: insert the journal entry header as DRAFT first, then its
      // lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED. journal_lines_immutable blocks any
      // INSERT once its parent journal_entries row is POSTED, mirroring
      // SupplierBillsService's own create-lines-while-DRAFT,
      // post()-only-flips-status shape exactly, just both steps inside
      // this one transaction instead of two separate HTTP calls.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.invoiceDate,
          currencyCode: before.currencyCode,
          memo: `Customer invoice ${internalReference}`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const journalLineValues: (typeof journalLines.$inferInsert)[] = [];
      let lineNumber = 1;
      for (const line of before.lines) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: line.accountId,
          debitMinor: 0,
          creditMinor: line.amountMinor,
          description: line.description ?? `Invoice ${internalReference} line`,
        });
      }
      if (taxTotal > 0) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: settings.taxOutputAccountId!,
          debitMinor: 0,
          creditMinor: taxTotal,
          description: `Tax on invoice ${internalReference}`,
        });
      }
      journalLineValues.push({
        tenantId,
        journalEntryId: draftJournalEntry!.id,
        lineNumber: lineNumber++,
        accountId: settings.arControlAccountId,
        debitMinor: before.totalMinor,
        creditMinor: 0,
        description: `AR control — invoice ${internalReference}`,
      });

      const insertedJournalLines = await tx
        .insert(journalLines)
        .values(journalLineValues)
        .returning();

      // Step 9b: now that the lines exist, flip the journal entry header
      // to POSTED — the same DRAFT -> POSTED transition
      // JournalEntriesService.post() performs, just inside this same
      // transaction rather than a separate HTTP call.
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

      // Step 10: commit the invoice's transition.
      const [posted] = await tx
        .update(customerInvoices)
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
            eq(customerInvoices.id, id),
            eq(customerInvoices.tenantId, tenantId),
            eq(customerInvoices.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      const after: CustomerInvoiceWithLines = {
        ...posted!,
        lines: before.lines,
      };

      // Step 11: dual audit — POST against the invoice, CREATE against
      // the new journal entry, same two-row-for-one-operation shape
      // SupplierBillsService.post() already establishes.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "customer_invoice",
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
      ]);

      return after;
    });
  }

  /** customerId must resolve to an existing, active customer in the
   * caller's own (tenantId [via RLS], legalEntityId). Returns the
   * customer row so callers can read paymentTermsDays for the due-date
   * default. */
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
   * — create/edit-time validation. 400: request-shape validation on
   * caller-supplied input. See revalidateLineAccountsForPostingOrThrow
   * for the 422 posting-time counterpart. Deliberately does not
   * distinguish "doesn't exist" from "wrong tenant/entity" from
   * "inactive", same information-disclosure convention as every other
   * Finance service. */
  private async validateLineAccountsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateCustomerInvoiceLineDto[],
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
   * of whatever passed at draft create/edit time. An account can be
   * archived between draft creation and posting. 422, not 400: this is
   * a business-rule/invariant failure at posting time. */
  private async revalidateLineAccountsForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CustomerInvoiceLine[],
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

  /** Loads ar_settings for this legal entity, scoped by tenantId +
   * legalEntityId within the SAME posting transaction (so a concurrent
   * ArSettingsService.upsert() either commits fully before or fully
   * after this read under read-committed isolation — same narrow-window
   * discussion as SupplierBillsService.loadApSettingsOrThrow). 422, not
   * 404: at posting time, an unconfigured AR settings row is a
   * business-rule failure on this invoice's posting attempt, not "the
   * resource you asked for doesn't exist" (contrast with
   * ArSettingsService.findOne's 404 for the direct `GET /ar/settings`
   * read). */
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
   * SupplierBillsService.resolveCurrency, duplicated locally (private
   * to that class). */
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

  /** Resolves the accounting period covering `invoiceDate` for
   * (tenantId, legalEntityId), locked via `SELECT ... FOR UPDATE` in
   * the same transaction — identical query/lock shape to
   * SupplierBillsService.resolveAndLockOpenPeriod, duplicated locally
   * (private to that class). Required so a concurrent
   * AccountingPeriodsService.close() cannot complete between this
   * resolution and the posting commit. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    invoiceDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, invoiceDate),
          gte(accountingPeriods.endDate, invoiceDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers invoice date ${invoiceDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${invoiceDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free invoice-number allocation via ar_number_counters' atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE
   * counter table/row from journal_number_counters/ap_number_counters
   * (proposal §6 step 7). Formatted `INV-{n:06d}`, scoped per legal
   * entity. */
  private async allocateInvoiceNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO ar_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = ar_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `INV-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries use — identical
   * atomic pattern to SupplierBillsService.allocateJournalNumber,
   * duplicated locally (private to that class) rather than sharing the
   * same sequence via a cross-service call, which would reintroduce the
   * exact multi-transaction atomicity problem this design avoids.
   * Formatted `JE-{n:06d}`, scoped per legal entity — the literal "no
   * parallel journal-number series" property. */
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
    invoiceId: string,
    lines: CreateCustomerInvoiceLineDto[],
  ): Promise<CustomerInvoiceLine[]> {
    return tx
      .insert(customerInvoiceLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          invoiceId,
          lineNumber: index + 1,
          accountId: line.accountId,
          description: line.description ?? null,
          amountMinor: line.amountMinor,
          taxAmountMinor: line.taxAmountMinor ?? 0,
        })),
      )
      .returning();
  }

  /** subtotalMinor = SUM(line.amountMinor), taxMinor =
   * SUM(line.taxAmountMinor), totalMinor = subtotalMinor + taxMinor —
   * server-computed, never client-supplied, matches the
   * customer_invoices_total_equals_subtotal_plus_tax CHECK constraint
   * by construction. */
  private computeTotals(lines: CreateCustomerInvoiceLineDto[]): {
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
  } {
    const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    const taxMinor = lines.reduce((sum, l) => sum + (l.taxAmountMinor ?? 0), 0);
    return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
  }

  /** invoiceDate + paymentTermsDays, computed once at create time — the
   * result is then an independently-editable field, never re-derived
   * from a later invoiceDate edit (matches supplierBills.dueDate's
   * identical posture). Returns null if the customer has no
   * paymentTermsDays configured. Date arithmetic is done in
   * UTC-anchored components to avoid any timezone-dependent day-shift. */
  private computeDefaultDueDate(
    invoiceDate: string,
    paymentTermsDays: number | null,
  ): string | null {
    if (paymentTermsDays === null || paymentTermsDays === undefined) {
      return null;
    }
    const [year, month, day] = invoiceDate.split("-").map(Number);
    const due = new Date(Date.UTC(year!, month! - 1, day!));
    due.setUTCDate(due.getUTCDate() + paymentTermsDays);
    return due.toISOString().slice(0, 10);
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking an invoice belonging to a different legal
   * entity within the same tenant, same convention as every other
   * Finance service. `options.forUpdate` acquires `SELECT ... FOR
   * UPDATE` on the header row — used by every mutating operation
   * (update/remove/post) as their first statement. Plain reads never
   * lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<CustomerInvoiceWithLines | undefined> {
    const condition = and(
      eq(customerInvoices.id, id),
      eq(customerInvoices.tenantId, tenantId),
      eq(customerInvoices.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(customerInvoices)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(customerInvoices).where(condition).limit(1);
    const invoice = rows[0];
    if (!invoice) return undefined;

    const lines = await tx
      .select()
      .from(customerInvoiceLines)
      .where(eq(customerInvoiceLines.invoiceId, id))
      .orderBy(asc(customerInvoiceLines.lineNumber));

    return { ...invoice, lines };
  }
}
