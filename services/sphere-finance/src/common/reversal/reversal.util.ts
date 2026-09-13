import { UnprocessableEntityException } from "@nestjs/common";
import { eq } from "@noryx/db-core";
import { journalEntries } from "../../db/schema";
import type { TxClient } from "../../db/db";
import type { JournalEntriesService } from "../../journal-entries/journal-entries.service";

/**
 * Shared reversal infrastructure for the Document-Level Reversal for
 * Posted AP & AR Documents work item
 * (docs/finance-work-item-document-reversal-proposal.md §18/§23,
 * CTO-approved implementation authorization). Two things live here,
 * neither of which duplicates anything `JournalEntriesService` already
 * owns:
 *
 *  - `resolveOpenPeriodOrThrow` — a thin, throwing wrapper over the
 *    already-public `JournalEntriesService.resolvePeriodForDate()`,
 *    reproducing exactly the error type/message shape
 *    `JournalEntriesService`'s own private `resolveAndLockOpenPeriod()`
 *    uses (proposal §14 — that method itself is private, so each of the
 *    six document services' `reverse()` needs this same wrapper; kept
 *    here once rather than duplicated six times).
 *  - `unsettleTarget` — the one new shared, generically-parameterized
 *    settlement-unwind helper the proposal calls for (§18), used by every
 *    settlement-document reversal (Supplier Payments/Debit Notes,
 *    Customer Receipts/Credit Notes) to un-apply its own allocations'
 *    effect on a target's `paidMinor`/`paymentStatus` — the exact mirror
 *    image of `post()`'s own apply-side arithmetic, subtracting instead
 *    of adding (proposal §9).
 *  - `resolveReversalInfo` — reads the additive, computed `reversal`
 *    field (proposal §17) for a document's existing `journalEntryId`,
 *    never stored, always derived from
 *    `journal_entries.reversedByJournalEntryId` (proposal §5/§16).
 *
 * Deliberately NOT shared: the top-level `reverse()` orchestration method
 * itself on each of the six services (lock own row -> check own
 * type-specific precondition -> call the shared pieces above and
 * `JournalEntriesService`'s own `lockAndValidateOriginalForReversal()`/
 * `completeReversalPosting()` -> write the document-specific audit
 * row(s)) — mirroring how `post()` itself is not shared across the six
 * services today (proposal §18's "what stays document-specific" list).
 */

/** A target document row's own settlement-relevant columns — the
 * intersection `supplier_bills` and `customer_invoices` both already
 * have. Both tables' own generated row types satisfy this shape. */
export interface UnsettleableTargetRow {
  id: string;
  paidMinor: number;
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID";
  totalMinor: number;
}

/** Any Drizzle table object exposing exactly the same four columns a
 * target document's settlement state lives on — `supplierBills` and
 * `customerInvoices` both satisfy this. Kept intentionally loose (not a
 * full `PgTable` generic) because the two real tables' inferred Drizzle
 * types differ in every OTHER column, and this helper only ever reads or
 * writes these four. */
export interface UnsettleableTargetTable {
  id: unknown;
  paidMinor: unknown;
  paymentStatus: unknown;
}

/**
 * Un-applies `unapplyAmountMinor` from one already-locked target row
 * (a Supplier Bill or Customer Invoice, already `SELECT ... FOR UPDATE`d
 * by the caller — this function never acquires its own lock), mirroring
 * `post()`'s own apply-side arithmetic exactly in reverse (proposal §9):
 *
 *   newPaidMinor = target.paidMinor - unapplyAmountMinor
 *   newPaymentStatus =
 *     newPaidMinor === 0 ? "UNPAID"
 *     : newPaidMinor === target.totalMinor ? "PAID"
 *     : "PARTIALLY_PAID"
 *
 * The UPDATE never includes `updatedAt` in its `SET` clause — the exact
 * same CRITICAL constraint every existing settlement-apply UPDATE in
 * this codebase already documents (005/009's narrow trigger exception
 * checks every other column, `updatedAt` included).
 *
 * `newPaidMinor < 0` is treated as an internal invariant violation, not a
 * business-rule 4xx: the existing invariants (allocation rows are
 * permanently immutable once posted, per the zero-exception child-table
 * triggers 008/012/015/018) should make this unreachable in practice —
 * mirrors the existing hard-fail style already used elsewhere in this
 * codebase for the trial-balance debit=credit assertion.
 */
export async function unsettleTarget<T extends UnsettleableTargetTable>(
  tx: TxClient,
  table: T,
  target: UnsettleableTargetRow,
  unapplyAmountMinor: number,
): Promise<UnsettleableTargetRow> {
  const newPaidMinor = target.paidMinor - unapplyAmountMinor;
  if (newPaidMinor < 0) {
    throw new Error(
      `Internal invariant violation: unsettling ${unapplyAmountMinor} minor units from target ${target.id} would produce a negative paidMinor (${newPaidMinor}). This should be unreachable given immutable allocation rows.`,
    );
  }
  const newPaymentStatus: UnsettleableTargetRow["paymentStatus"] =
    newPaidMinor === 0
      ? "UNPAID"
      : newPaidMinor === target.totalMinor
        ? "PAID"
        : "PARTIALLY_PAID";

  // `table` is typed only against the loose `UnsettleableTargetTable`
  // interface (deliberately, so this one helper works against both
  // `supplierBills` and `customerInvoices` — see that interface's own
  // doc comment), so drizzle's real, much stricter `.update()`/`.set()`/
  // `.where()` overloads can't be resolved from it at the type level.
  // `any` here is a deliberate, narrowly-scoped type-level widening —
  // not a runtime behavior change — to bridge that gap; the actual
  // query shape is identical to every other settlement UPDATE in this
  // codebase (post()'s own paidMinor/paymentStatus-only SET, matching
  // the immutability triggers' narrow exception).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await tx
    .update(table as any)
    .set({
      paidMinor: newPaidMinor,
      paymentStatus: newPaymentStatus,
    })
    .where(eq(table.id as any, target.id))
    .returning();

  return rows[0] as UnsettleableTargetRow;
}

/**
 * Thin, throwing wrapper over the already-public
 * `JournalEntriesService.resolvePeriodForDate()` — reproduces
 * `JournalEntriesService`'s own private `resolveAndLockOpenPeriod()`
 * error types/messages exactly (journal-entries.service.ts), since that
 * method itself is private and therefore not directly reusable from a
 * document service. Locks the reversal's OWN transaction date's covering
 * period (never the original document's own posting period — proposal
 * §14, the existing, already-shipped behavior this reuses unchanged).
 */
export async function resolveOpenPeriodOrThrow(
  journalEntriesService: JournalEntriesService,
  tx: TxClient,
  tenantId: string,
  legalEntityId: string,
  transactionDate: string,
) {
  const resolution = await journalEntriesService.resolvePeriodForDate(
    tx,
    tenantId,
    legalEntityId,
    transactionDate,
  );
  if (resolution.kind === "NOT_FOUND") {
    throw new UnprocessableEntityException(
      `No accounting period covers transaction date ${transactionDate} for this legal entity.`,
    );
  }
  if (resolution.kind === "CLOSED") {
    throw new UnprocessableEntityException(
      `Accounting period "${resolution.period.code}" covering ${transactionDate} is closed.`,
    );
  }
  return resolution.period;
}

/** The additive, computed `reversal` field (proposal §17) — never
 * stored, always derived from the document's existing `journalEntryId`
 * -> `journal_entries.reversedByJournalEntryId` linkage (proposal
 * §5/§16). `null` when the document was never posted, or has been posted
 * but never reversed. */
export interface ReversalInfo {
  journalEntryId: string;
  journalNumber: string;
  transactionDate: string;
  postedAt: Date | null;
  postedBy: string | null;
}

export async function resolveReversalInfo(
  tx: TxClient,
  journalEntryId: string | null,
): Promise<ReversalInfo | null> {
  if (!journalEntryId) return null;

  const [original] = await tx
    .select({
      reversedByJournalEntryId: journalEntries.reversedByJournalEntryId,
    })
    .from(journalEntries)
    .where(eq(journalEntries.id, journalEntryId))
    .limit(1);
  if (!original?.reversedByJournalEntryId) return null;

  const [reversal] = await tx
    .select({
      id: journalEntries.id,
      journalNumber: journalEntries.journalNumber,
      transactionDate: journalEntries.transactionDate,
      postedAt: journalEntries.postedAt,
      postedBy: journalEntries.postedBy,
    })
    .from(journalEntries)
    .where(eq(journalEntries.id, original.reversedByJournalEntryId))
    .limit(1);
  if (!reversal) return null;

  return {
    journalEntryId: reversal.id,
    journalNumber: reversal.journalNumber!,
    transactionDate: reversal.transactionDate,
    postedAt: reversal.postedAt,
    postedBy: reversal.postedBy,
  };
}
