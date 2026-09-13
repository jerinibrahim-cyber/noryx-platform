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
  supplierBillLines,
  type AccountingPeriod,
  type ApSettings,
  type Supplier,
  type SupplierBill,
  type SupplierBillLine,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import { TaxRatesService } from "../../tax-configuration/tax-rates.service";
import { calculateTaxAmountMinor } from "../../tax-configuration/tax-calculation";
import { JournalEntriesService } from "../../journal-entries/journal-entries.service";
import type { ReverseJournalEntryDto } from "../../journal-entries/dto/reverse-journal-entry.dto";
import {
  resolveOpenPeriodOrThrow,
  resolveReversalInfo,
  type ReversalInfo,
} from "../../common/reversal/reversal.util";
import type { CreateSupplierBillDto } from "./dto/create-supplier-bill.dto";
import type { CreateSupplierBillLineDto } from "./dto/create-supplier-bill-line.dto";
import type { UpdateSupplierBillDto } from "./dto/update-supplier-bill.dto";

export type SupplierBillWithLines = SupplierBill & {
  lines: SupplierBillLine[];
};

export type SupplierBillWithReversal = SupplierBillWithLines & {
  reversal: ReversalInfo | null;
};

/** Tax/VAT Phase 2 — a line after tax resolution (discovery §3), ready
 * to insert. Every field is authoritative/final; unlike
 * CreateSupplierBillLineDto's optional taxAmountMinor, this shape's
 * taxAmountMinor is always the resolved, definite value that both
 * computeTotals() and insertLines() consume. */
interface ResolvedSupplierBillLine {
  accountId: string;
  description: string | null;
  amountMinor: number;
  taxAmountMinor: number;
  taxCodeId: string | null;
  taxRateId: string | null;
  taxAmountCalculatedMinor: number | null;
  taxAmountOverridden: boolean;
  /** Tax/VAT Phase 5 (docs/finance-work-item-tax-vat-phase-5-proposal.md
   * §5/§6) — the GL account this line's tax resolves to, snapshotted at
   * THIS resolution (draft create/edit), never re-derived at post()
   * time. taxCodeId.apTaxAccountId if set, else ap_settings'
   * tax_input_account_id at that same moment. Populated whenever
   * taxAmountMinor > 0, including legacy lines with no taxCodeId; null
   * when the line carries no tax, or when neither a code-level override
   * nor the AP-settings singleton is configured (posting then rejects
   * — see post()'s deterministic-destination check). */
  resolvedTaxAccountId: string | null;
}

export interface ListSupplierBillsFilters {
  status?: "DRAFT" | "POSTED";
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
  /// Added in AP-1c (docs/finance-work-item-1c-supplier-payments-
  /// proposal.md §1/§11) — a minimal, direct enabler of AP-1c's own
  /// payment-allocation flow (finding candidate bills to allocate
  /// against), not an AP-1d report endpoint.
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID";
}

/**
 * Supplier bills — AP-1b
 * (docs/finance-work-item-1b-supplier-bills-proposal.md §4, §7, §8, §17).
 *
 * Draft CRUD mirrors JournalEntriesService's create/list/findOne/update/
 * remove shape exactly (full-line-array-replacement on update, DRAFT-only
 * edit/delete, SELECT ... FOR UPDATE before any status-dependent
 * mutation). post() replicates JournalEntriesService.post()'s 10-step
 * transaction against supplier_bills instead of journal_entries, and
 * inserts DIRECTLY into the shared journal_entries/journal_lines/
 * journal_number_counters tables rather than calling
 * JournalEntriesService — proposal §8's key architectural decision:
 * JournalEntriesService.create()/.post() each own their own transaction,
 * which is the wrong shape for "bill POSTED" and "journal entry POSTED"
 * needing to commit atomically together. The private helpers below that
 * mirror JournalEntriesService's own private helpers
 * (resolveAndLockOpenPeriod, allocateJournalNumber-equivalent,
 * findInvalidAccountIds-equivalent) are deliberate, documented
 * duplication — those methods are private to JournalEntriesService, not
 * a shared exported utility only two call sites would ever use.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service throughout.
 */
@Injectable()
export class SupplierBillsService {
  constructor(
    private readonly taxRates: TaxRatesService,
    private readonly journalEntries: JournalEntriesService,
  ) {}

  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateSupplierBillDto,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const supplier = await this.validateSupplierRefOrThrow(
        tx,
        legalEntityId,
        dto.supplierId,
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
        this.computeDefaultDueDate(dto.billDate, supplier.paymentTermsDays);
      // Tax/VAT Phase 2 — resolve/calculate/snapshot each line's tax
      // BEFORE computing header totals, so subtotalMinor/taxMinor/
      // totalMinor reflect the resolved (possibly calculated or
      // overridden) taxAmountMinor, not the raw DTO input. Resolution
      // uses this bill's OWN billDate (Decision 6).
      const resolvedLines = await this.resolveLineTax(
        tx,
        tenantId,
        legalEntityId,
        dto.billDate,
        dto.lines,
      );
      const totals = this.computeTotals(resolvedLines);

      const [createdBill] = await tx
        .insert(supplierBills)
        .values({
          tenantId,
          legalEntityId,
          supplierId: dto.supplierId,
          supplierBillNumber: dto.supplierBillNumber,
          billDate: dto.billDate,
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
        createdBill!.id,
        resolvedLines,
      );

      const full: SupplierBillWithLines = {
        ...createdBill!,
        lines: insertedLines,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "supplier_bill",
        entityId: createdBill!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListSupplierBillsFilters,
  ): Promise<SupplierBill[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(supplierBills.tenantId, tenantId),
        eq(supplierBills.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(supplierBills.status, filters.status));
      }
      if (filters.supplierId) {
        conditions.push(eq(supplierBills.supplierId, filters.supplierId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(supplierBills.billDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(supplierBills.billDate, filters.dateTo));
      }
      if (filters.paymentStatus) {
        conditions.push(eq(supplierBills.paymentStatus, filters.paymentStatus));
      }
      return tx
        .select()
        .from(supplierBills)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<SupplierBillWithReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      // Document-Level Reversal work item
      // (docs/finance-work-item-document-reversal-proposal.md §17) —
      // additive, computed field on single-document reads; never
      // stored, always derived from journalEntryId ->
      // journal_entries.reversedByJournalEntryId.
      const reversal = await resolveReversalInfo(tx, found.journalEntryId);
      return { ...found, reversal };
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateSupplierBillDto,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted supplier bill.");
      }

      const headerPatch: Partial<typeof supplierBills.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.supplierBillNumber !== undefined) {
        headerPatch.supplierBillNumber = dto.supplierBillNumber;
      }
      if (dto.billDate !== undefined) {
        headerPatch.billDate = dto.billDate;
      }
      if (dto.dueDate !== undefined) {
        headerPatch.dueDate = dto.dueDate;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      // Tax/VAT Phase 2 — resolved once here (if lines are being
      // replaced) and reused below for the actual line replacement, so
      // resolution runs exactly once per call. Uses the EFFECTIVE
      // document date for THIS write: the incoming billDate if this same
      // call also changes it, else the bill's current stored billDate
      // (discovery §8 — this is the one case where a same-call
      // date+lines PATCH already resolves correctly; a date-only PATCH
      // that omits lines leaves already-resolved line snapshots frozen,
      // by design — see that section).
      let resolvedLines: ResolvedSupplierBillLine[] | undefined;
      if (dto.lines) {
        await this.validateLineAccountsOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.lines,
        );
        const documentDate = dto.billDate ?? before.billDate;
        resolvedLines = await this.resolveLineTax(
          tx,
          tenantId,
          legalEntityId,
          documentDate,
          dto.lines,
        );
        const totals = this.computeTotals(resolvedLines);
        headerPatch.subtotalMinor = totals.subtotalMinor;
        headerPatch.taxMinor = totals.taxMinor;
        headerPatch.totalMinor = totals.totalMinor;
      }

      await tx
        .update(supplierBills)
        .set(headerPatch)
        .where(
          and(
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        // Full-array replacement, not line-level add/remove — same
        // convention as JournalEntriesService.update(). Fresh 1..N
        // numbering, independent of whatever numbering the replaced
        // lines had.
        await tx
          .delete(supplierBillLines)
          .where(eq(supplierBillLines.billId, id));
        await this.insertLines(tx, tenantId, id, resolvedLines!);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "supplier_bill",
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
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted supplier bill.");
      }

      // supplier_bill_lines rows cascade via the existing FK's
      // onDelete: "cascade".
      await tx
        .delete(supplierBills)
        .where(
          and(
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "supplier_bill",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /bills/:id/post` — DRAFT -> POSTED. Proposal §8's 10-step
   * shape, replicated from JournalEntriesService.post() and applied to
   * a bill instead of a journal entry: lock, status, line-count,
   * account re-validation, AP settings + tax-account validation, period
   * resolution+lock, bill-number allocation, journal-number allocation,
   * direct journal_entries/journal_lines insertion, commit, dual audit.
   * A failure at any step rolls the whole transaction back — no burned
   * bill number, no burned journal number, no orphaned journal entry,
   * from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This supplier bill is already posted.");
      }

      // Step 3: at least 1 line (a bill's own natural minimum — unlike
      // journal entries' >= 2, a single-line bill is a valid document).
      if (before.lines.length < 1) {
        throw new UnprocessableEntityException(
          "A supplier bill must have at least 1 line to be posted.",
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

      // Step 5: load AP settings — apControlAccountId is required for
      // every bill regardless of tax (loadApSettingsOrThrow's own doc
      // comment). Tax/VAT Phase 5 (proposal §6): this step no longer
      // reads settings.taxInputAccountId for the tax check/journal
      // line below — each line's own resolvedTaxAccountId snapshot
      // (captured at draft resolveLineTax() time) is now what
      // determines that. "Every posted tax line must have a
      // deterministic accounting destination": any line carrying tax
      // but snapshotted with a null resolvedTaxAccountId (no code-level
      // override AND no singleton fallback configured at resolution
      // time) blocks posting here.
      const settings = await this.loadApSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );
      const linesMissingTaxAccount = before.lines.filter(
        (l) => l.taxAmountMinor > 0 && !l.resolvedTaxAccountId,
      );
      if (linesMissingTaxAccount.length > 0) {
        throw new UnprocessableEntityException(
          "This bill has tax amounts on one or more lines with no resolved tax account. Configure a tax-code-level or AP-settings tax input account and re-save the affected line(s) before posting.",
        );
      }

      // Step 6: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.billDate,
      );

      // Step 7: atomic bill-number allocation — a SEPARATE counter from
      // journal_number_counters (proposal §8 step 7).
      const internalReference = await this.allocateBillNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 8: atomic journal-number allocation from the SAME sequence
      // real journal entries use — no AP-only journal-number series
      // (proposal §8 step 8, the literal "posts through the existing
      // Journal Engine" property).
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 9: insert the journal entry header as DRAFT first, then its
      // lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED. journal_lines_immutable (004) blocks
      // any INSERT once its parent journal_entries row is POSTED
      // (correctly — that guarantee is exactly what makes posted-entry
      // history append-only), so lines must exist before the header's
      // status transition, mirroring JournalEntriesService's own
      // create()-builds-lines-while-DRAFT, post()-only-flips-status
      // shape exactly, just both steps inside this one transaction
      // instead of two separate HTTP calls.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.billDate,
          currencyCode: before.currencyCode,
          memo: `Supplier bill ${internalReference} (${before.supplierBillNumber})`,
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
          debitMinor: line.amountMinor,
          creditMinor: 0,
          description: line.description ?? `Bill ${internalReference} line`,
        });
      }
      // Tax/VAT Phase 5 (proposal §6, CTO worked example) — one journal
      // line per DISTINCT resolvedTaxAccountId, aggregating every line
      // that resolved to that same account; never aggregating different
      // accounts together merely because they're both input tax, and
      // never emitting a separate line per source line when multiple
      // lines share one account. Accumulated in first-seen order for a
      // deterministic journal-line ordering.
      const taxByAccount = new Map<string, number>();
      const taxAccountOrder: string[] = [];
      for (const line of before.lines) {
        if (line.taxAmountMinor > 0 && line.resolvedTaxAccountId) {
          if (!taxByAccount.has(line.resolvedTaxAccountId)) {
            taxAccountOrder.push(line.resolvedTaxAccountId);
            taxByAccount.set(line.resolvedTaxAccountId, 0);
          }
          taxByAccount.set(
            line.resolvedTaxAccountId,
            taxByAccount.get(line.resolvedTaxAccountId)! + line.taxAmountMinor,
          );
        }
      }
      for (const accountId of taxAccountOrder) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId,
          debitMinor: taxByAccount.get(accountId)!,
          creditMinor: 0,
          description: `Tax on bill ${internalReference}`,
        });
      }
      journalLineValues.push({
        tenantId,
        journalEntryId: draftJournalEntry!.id,
        lineNumber: lineNumber++,
        accountId: settings.apControlAccountId,
        debitMinor: 0,
        creditMinor: before.totalMinor,
        description: `AP control — bill ${internalReference}`,
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

      // Step 10: commit the bill's transition.
      const [posted] = await tx
        .update(supplierBills)
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
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      const after: SupplierBillWithLines = {
        ...posted!,
        lines: before.lines,
      };

      // Step 11: dual audit — POST against the bill, CREATE against the
      // new journal entry, same two-row-for-one-operation shape
      // JournalEntriesService.reverse() already establishes.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "supplier_bill",
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

  /**
   * `POST /bills/:id/reverse` — Document-Level Reversal for Posted AP &
   * AR Documents work item
   * (docs/finance-work-item-document-reversal-proposal.md §7/§8/§18,
   * CTO-approved implementation authorization). Supplier bills are a
   * "target" document (§7): reversal is blocked while any payment
   * allocation exists (`paidMinor > 0`) — unwind allocations first via
   * the settlement document's own reversal, not here. Reversal state is
   * never stored on the bill itself; it is always derived (§16) from
   * this same `journalEntryId` -> `journal_entries.reversedByJournalEntryId`
   * link that `post()` already establishes. The bill's own status stays
   * POSTED — reversal only ever adds a second, opposite journal entry
   * and links it, exactly as `JournalEntriesService.reverse()` already
   * does for a bare journal entry.
   *
   * Reuses `JournalEntriesService.lockAndValidateOriginalForReversal()`
   * and `completeReversalPosting()` directly (§15/§18 — no duplicated
   * journal-reversal logic), plus this work item's own
   * `resolveOpenPeriodOrThrow()` (the thin public wrapper over
   * `resolvePeriodForDate()`, since the original's own
   * `resolveAndLockOpenPeriod()` is private). Locks the bill row first
   * (fixed lock order: own row, then the original journal entry via
   * `lockAndValidateOriginalForReversal()`, then the reversal's covering
   * period) — the same "lock the thing you're mutating before you lock
   * anything downstream of it" ordering `post()` itself already uses.
   */
  async reverse(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: ReverseJournalEntryDto,
  ): Promise<SupplierBillWithReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      if (before.status !== "POSTED") {
        throw new UnprocessableEntityException(
          "Only a posted supplier bill can be reversed.",
        );
      }
      if (before.paidMinor > 0) {
        throw new UnprocessableEntityException(
          "Cannot reverse a supplier bill with payment allocations; unwind the allocating payment(s)/debit note(s) first.",
        );
      }
      if (!before.journalEntryId) {
        throw new UnprocessableEntityException(
          "This supplier bill has no posted journal entry to reverse.",
        );
      }

      // Lock + validate the original journal entry (exists, POSTED, not
      // already reversed, not itself a reversal) — the same shared
      // mechanism JournalEntriesService.reverse() and
      // ScheduledReversalsService both already use.
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
        dto.memo ?? `Reversal of supplier bill ${before.internalReference}`;

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

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      // The bill's own status/columns never change from reversal — the
      // audit's before/after states are therefore the same row shape,
      // documenting the event itself (the linkage), not a bill-side
      // state transition.
      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "REVERSE",
        entityType: "supplier_bill",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: after as unknown as Record<string, unknown>,
      });

      const reversal = await resolveReversalInfo(tx, after!.journalEntryId);
      return { ...after!, reversal };
    });
  }

  /** supplierId must resolve to an existing, active supplier in the
   * caller's own (tenantId [via RLS], legalEntityId). Returns the
   * supplier row so callers can read paymentTermsDays for the due-date
   * default. */
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
    lines: CreateSupplierBillLineDto[],
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
   * a business-rule/invariant failure at posting time.
   *
   * Tax/VAT Phase 5 (docs/finance-work-item-tax-vat-phase-5-proposal.md
   * §6) — also re-validates every distinct resolvedTaxAccountId
   * snapshotted on these lines: a tax account can be archived between
   * draft resolution and posting, exactly the same hazard this method
   * already guards against for each line's own accountId. */
  private async revalidateLineAccountsForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: SupplierBillLine[],
  ): Promise<void> {
    const taxAccountIds = lines
      .map((l) => l.resolvedTaxAccountId)
      .filter((accId): accId is string => accId !== null);
    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      [...lines.map((l) => l.accountId), ...taxAccountIds],
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

  /** Loads ap_settings for this legal entity, scoped by tenantId +
   * legalEntityId within the SAME posting transaction (so a concurrent
   * ApSettingsService.upsert() either commits fully before or fully
   * after this read under read-committed isolation — see proposal §14's
   * concurrency discussion for the narrow window this does not close).
   * 422, not 404: at posting time, an unconfigured AP settings row is a
   * business-rule failure on this bill's posting attempt, not "the
   * resource you asked for doesn't exist" (contrast with
   * ApSettingsService.findOne's 404 for the direct `GET /ap/settings`
   * read). */
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
   * JournalEntriesService.resolveCurrency, duplicated locally (private
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

  /** Resolves the accounting period covering `billDate` for
   * (tenantId, legalEntityId), locked via `SELECT ... FOR UPDATE` in
   * the same transaction — identical query/lock shape to
   * JournalEntriesService.resolveAndLockOpenPeriod, duplicated locally
   * (private to that class). Required so a concurrent
   * AccountingPeriodsService.close() cannot complete between this
   * resolution and the posting commit. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    billDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, billDate),
          gte(accountingPeriods.endDate, billDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers bill date ${billDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${billDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free bill-number allocation via ap_number_counters' atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE
   * counter table/row from journal_number_counters (proposal §8 step
   * 7). Formatted `BILL-{n:06d}`, scoped per legal entity. */
  private async allocateBillNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO ap_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = ap_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `BILL-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries use — identical
   * atomic pattern to JournalEntriesService.allocateJournalNumber,
   * duplicated locally (private to that class) rather than sharing the
   * same sequence via a cross-service call, which would reintroduce the
   * exact multi-transaction atomicity problem §8 avoids. Formatted
   * `JE-{n:06d}`, scoped per legal entity — the literal "no parallel
   * journal-number series" property. */
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
    billId: string,
    lines: ResolvedSupplierBillLine[],
  ): Promise<SupplierBillLine[]> {
    return tx
      .insert(supplierBillLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          billId,
          lineNumber: index + 1,
          accountId: line.accountId,
          description: line.description,
          amountMinor: line.amountMinor,
          taxAmountMinor: line.taxAmountMinor,
          taxCodeId: line.taxCodeId,
          taxRateId: line.taxRateId,
          taxAmountCalculatedMinor: line.taxAmountCalculatedMinor,
          taxAmountOverridden: line.taxAmountOverridden,
          resolvedTaxAccountId: line.resolvedTaxAccountId,
        })),
      )
      .returning();
  }

  /** Tax/VAT Phase 5 (docs/finance-work-item-tax-vat-phase-5-proposal.md
   * §6) — non-throwing AP-settings lookup used only to source the
   * singleton tax-input-account fallback during resolveLineTax(). Unlike
   * loadApSettingsOrThrow (used at post() time, where an unconfigured AP
   * settings row IS a hard failure because apControlAccountId is always
   * required), draft create/update must succeed even when AP settings
   * haven't been configured yet — the resulting resolvedTaxAccountId is
   * simply null, and post()'s own deterministic-destination check is
   * what turns that into a hard failure, only if and when this bill
   * actually carries tax at posting time. */
  private async loadApTaxInputAccountFallback(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ taxInputAccountId: apSettings.taxInputAccountId })
      .from(apSettings)
      .where(
        and(
          eq(apSettings.tenantId, tenantId),
          eq(apSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0]?.taxInputAccountId ?? null;
  }

  /** Tax/VAT Phase 2
   * (docs/finance-work-item-tax-vat-phase-2-discovery.md §3/§5/§6) —
   * resolves/calculates/snapshots tax for every line, in DTO order,
   * against this bill's OWN billDate (never posting date — Decision 6).
   * A line with no taxCodeId is untouched (100% legacy behavior:
   * taxAmountMinor stays exactly the client-supplied manual value, or
   * 0). A line with taxCodeId resolves the effective tax_rates row,
   * calculates the line's tax, and — per Decision 4 — treats an
   * explicitly-supplied taxAmountMinor as an override: the supplied
   * value becomes authoritative, the calculated value is retained in
   * taxAmountCalculatedMinor, and taxAmountOverridden is set. Nothing is
   * ever silently discarded. Runs sequentially (not batched) since each
   * line's resolution is an independent, typically-small query set and
   * lines rarely number more than a handful per document. */
  private async resolveLineTax(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    documentDate: string,
    lines: CreateSupplierBillLineDto[],
  ): Promise<ResolvedSupplierBillLine[]> {
    // Tax/VAT Phase 5 — loaded once per call, not once per line: the
    // singleton AP tax-input-account fallback, used only when a line's
    // own tax code carries no apTaxAccountId override (or the line has
    // no tax code at all). Non-throwing — see
    // loadApTaxInputAccountFallback's own doc comment.
    const fallbackTaxAccountId = await this.loadApTaxInputAccountFallback(
      tx,
      tenantId,
      legalEntityId,
    );

    const resolved: ResolvedSupplierBillLine[] = [];
    for (const line of lines) {
      if (!line.taxCodeId) {
        const taxAmountMinor = line.taxAmountMinor ?? 0;
        resolved.push({
          accountId: line.accountId,
          description: line.description ?? null,
          amountMinor: line.amountMinor,
          taxAmountMinor,
          taxCodeId: null,
          taxRateId: null,
          taxAmountCalculatedMinor: null,
          taxAmountOverridden: false,
          // Legacy/manual-tax lines have no tax code to carry a
          // per-code override, so they always fall back to the
          // singleton AP tax-input account (or null if unconfigured).
          resolvedTaxAccountId:
            taxAmountMinor > 0 ? fallbackTaxAccountId : null,
        });
        continue;
      }

      const { rate, taxCode } = await this.taxRates.resolveEffectiveRate(
        tx,
        tenantId,
        legalEntityId,
        line.taxCodeId,
        documentDate,
      );
      const calculated = calculateTaxAmountMinor(
        line.amountMinor,
        rate.rateBasisPoints,
      );
      const overridden = line.taxAmountMinor !== undefined;
      const finalTaxAmountMinor = overridden
        ? line.taxAmountMinor!
        : calculated;
      resolved.push({
        accountId: line.accountId,
        description: line.description ?? null,
        amountMinor: line.amountMinor,
        taxAmountMinor: finalTaxAmountMinor,
        taxCodeId: line.taxCodeId,
        taxRateId: rate.id,
        taxAmountCalculatedMinor: calculated,
        taxAmountOverridden: overridden,
        // This tax code's own AP override if set, else the singleton
        // fallback — resolved at THIS moment (draft create/edit), never
        // re-resolved at post() time.
        resolvedTaxAccountId:
          finalTaxAmountMinor > 0
            ? (taxCode.apTaxAccountId ?? fallbackTaxAccountId)
            : null,
      });
    }
    return resolved;
  }

  /** subtotalMinor = SUM(line.amountMinor), taxMinor =
   * SUM(line.taxAmountMinor), totalMinor = subtotalMinor + taxMinor —
   * server-computed, never client-supplied, matches the
   * supplier_bills_total_equals_subtotal_plus_tax CHECK constraint by
   * construction. Operates on already-resolved lines (Tax/VAT Phase 2)
   * so taxAmountMinor here is always the final authoritative value —
   * calculated, overridden, or plain legacy manual/0. */
  private computeTotals(lines: ResolvedSupplierBillLine[]): {
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
  } {
    const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    const taxMinor = lines.reduce((sum, l) => sum + l.taxAmountMinor, 0);
    return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
  }

  /** billDate + paymentTermsDays, computed once at create time — the
   * result is then an independently-editable field, never re-derived
   * from a later billDate edit (proposal §4's doc comment on dueDate).
   * Returns null if the supplier has no paymentTermsDays configured.
   * Date arithmetic is done in UTC-anchored components to avoid any
   * timezone-dependent day-shift. */
  private computeDefaultDueDate(
    billDate: string,
    paymentTermsDays: number | null,
  ): string | null {
    if (paymentTermsDays === null || paymentTermsDays === undefined) {
      return null;
    }
    const [year, month, day] = billDate.split("-").map(Number);
    const due = new Date(Date.UTC(year!, month! - 1, day!));
    due.setUTCDate(due.getUTCDate() + paymentTermsDays);
    return due.toISOString().slice(0, 10);
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking a bill belonging to a different legal entity
   * within the same tenant, same convention as every other Finance
   * service. `options.forUpdate` acquires `SELECT ... FOR UPDATE` on
   * the header row — used by every mutating operation (update/remove/
   * post) as their first statement. Plain reads never lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SupplierBillWithLines | undefined> {
    const condition = and(
      eq(supplierBills.id, id),
      eq(supplierBills.tenantId, tenantId),
      eq(supplierBills.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(supplierBills)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(supplierBills).where(condition).limit(1);
    const bill = rows[0];
    if (!bill) return undefined;

    const lines = await tx
      .select()
      .from(supplierBillLines)
      .where(eq(supplierBillLines.billId, id))
      .orderBy(asc(supplierBillLines.lineNumber));

    return { ...bill, lines };
  }
}
