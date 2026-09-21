import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, legalEntities, sql } from "@noryx/db-core";
import type { PaginatedMeta } from "@noryx/shared-types";
import { apSettings, arSettings, accountingPeriods, taxCodes } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { REPORT_TX_CONFIG } from "../general-ledger/general-ledger.service";
import type { VatPositionQueryDto } from "./dto/vat-position-query.dto";
import type { VatPositionDetailQueryDto } from "./dto/vat-position-detail-query.dto";

export interface VatPositionCodeRow {
  taxCodeId: string;
  code: string;
  name: string;
  treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  netSupplyValueMinor: number;
  netTaxMinor: number;
  netCalculatedTaxMinor: number;
  /** Tax/VAT Phase 6 (CTO authorization §8.7) — the portion of
   * netTaxMinor sourced from explicitly tax-classified manual journal
   * lines (journal_lines.tax_code_id), already included within
   * netTaxMinor, never a separate additional amount. `netTaxMinor -
   * manualTaxMinor` recovers the AP/AR-only (invoice/credit-note or
   * bill/debit-note) contribution — the "source-level attribution"
   * required alongside the unified headline. Always 0 for a code with
   * no manual-journal activity this window. */
  manualTaxMinor: number;
}

/** Tax/VAT Phase 5 (docs/finance-work-item-tax-vat-phase-5-proposal.md
 * §8) — one distinct tax GL account's own movement/reconciliation for a
 * report window, within `VatPositionGlCrossCheck.outputTaxAccounts`/
 * `inputTaxAccounts`. `sourceLineTaxMinor` is derived from the POSTED
 * lines' own `resolvedTaxAccountId` snapshots (historical fact), never
 * from current `tax_codes`/AP-AR-settings configuration — see
 * docs/finance-work-item-tax-vat-phase-5-discovery.md §13's correctness
 * proof for why that stays correct even after a later remapping. */
export interface VatPositionGlAccountBreakdown {
  accountId: string;
  sourceLineTaxMinor: number;
  glMovementMinor: number;
  differenceMinor: number;
  reconciled: boolean;
}

export interface VatPositionGlCrossCheck {
  taxOutputAccountId: string | null;
  glOutputTaxMovementMinor: number;
  outputDifferenceMinor: number;
  outputReconciled: boolean;
  taxInputAccountId: string | null;
  glInputTaxMovementMinor: number;
  inputDifferenceMinor: number;
  inputReconciled: boolean;
  /** Tax/VAT Phase 5 (proposal §8) — ADDITIVE ONLY: the eight fields
   * above keep their exact pre-Phase-5 names/types/meanings, each still
   * describing the single singleton AP/AR-settings tax account
   * specifically (unchanged for existing consumers). These two new
   * fields are the full multi-account picture — one entry per distinct
   * GL account any in-window POSTED tax line actually resolved to,
   * unioned with the singleton account even if it saw no movement this
   * window. A tenant using only the singleton (no tax-code-level
   * overrides configured) sees exactly one entry here, equal in
   * substance to the corresponding 4 fields above. */
  outputTaxAccounts: VatPositionGlAccountBreakdown[];
  inputTaxAccounts: VatPositionGlAccountBreakdown[];
}

export interface VatPositionMeta {
  legalEntityId: string;
  dateFrom: string;
  dateTo: string;
  periodId: string | null;
  currencyCode: string;
  outputTaxMinor: number;
  inputTaxMinor: number;
  netPositionMinor: number;
  unclassifiedOutputTaxMinor: number;
  unclassifiedInputTaxMinor: number;
  /** Tax/VAT Phase 6 (CTO authorization §8.7) — the portion of
   * outputTaxMinor/inputTaxMinor sourced from explicitly
   * tax-classified manual journal lines, already included within
   * outputTaxMinor/inputTaxMinor (the unified headline), never a
   * separate additional amount. `outputTaxMinor - manualOutputTaxMinor`
   * recovers the AR-only figure; `inputTaxMinor - manualInputTaxMinor`
   * recovers the AP-only figure. A reversed manual entry (same
   * tax_code_id/tax_direction, swapped debit/credit — §8.6) always
   * nets its original's contribution to zero, so both fields are 0
   * for a legal entity with no *net* manual tax activity this window,
   * even if manual tax-classified entries exist and were reversed. */
  manualOutputTaxMinor: number;
  manualInputTaxMinor: number;
  glCrossCheck: VatPositionGlCrossCheck;
}

export interface VatPositionResult {
  outputByTaxCode: VatPositionCodeRow[];
  inputByTaxCode: VatPositionCodeRow[];
  meta: VatPositionMeta;
}

/**
 * Tax/VAT Phase 7 (CONTRACT.md §0/§5/§6) — VAT Position Detail /
 * Source-Document Drill-Down. One row per persisted tax-bearing source
 * line that contributed to `getVatPosition()`'s `netTaxMinor` (never one
 * row per document, per tax code, or an aggregate) — the same five
 * source types §5's table defines, read at row grain instead of
 * `SUM()`/`GROUP BY` grain.
 */
export interface VatPositionDetailRow {
  sourceType:
    | "SUPPLIER_BILL"
    | "SUPPLIER_DEBIT_NOTE"
    | "CUSTOMER_INVOICE"
    | "CUSTOMER_CREDIT_NOTE"
    | "MANUAL_JOURNAL";
  sourceDocumentId: string;
  /** The line's own primary-key UUID — CONTRACT.md §9's mandatory final
   * ordering tie-breaker (only guaranteed unique within its own table,
   * per §9's Correction-1 wording; `sourceType` disambiguates across
   * tables). */
  sourceLineId: string;
  sourceDocumentReference: string | null;
  /** Canonical source date, CONTRACT.md §9 — `bill_date` /
   * `debit_note_date` / `invoice_date` / `credit_note_date` /
   * `transaction_date`, per `sourceType`. `YYYY-MM-DD`. */
  sourceDocumentDate: string;
  taxCodeId: string;
  code: string;
  name: string;
  direction: "INPUT" | "OUTPUT";
  /** Signed per CONTRACT.md §7's polarity table — already sign-adjusted,
   * never a value the caller must re-sign. */
  signedTaxContributionMinor: number;
}

/**
 * Tax/VAT Phase 7 (CONTRACT.md §11A) — one entry per `(taxCodeId,
 * direction)` present in the request's COMPLETE filtered result (never
 * merely the current page), computed inside the same
 * `REPORT_TX_CONFIG` transaction/snapshot as the page fetch (§10A).
 * `direction` — not the display `code` string — is part of the
 * reconciliation identity (Hardening Requirement 4): INPUT and OUTPUT
 * activity under what displays as "the same code" are two separate
 * entries.
 */
export interface VatPositionReconciliationTotal {
  taxCodeId: string;
  code: string;
  direction: "INPUT" | "OUTPUT";
  netTaxContributionMinor: number;
}

export interface VatPositionDetailMeta extends PaginatedMeta {
  legalEntityId: string;
  dateFrom: string;
  dateTo: string;
  periodId: string | null;
  taxCodeId: string | null;
  currencyCode: string;
}

export interface VatPositionDetailResult {
  rows: VatPositionDetailRow[];
  reconciliationTotals: VatPositionReconciliationTotal[];
  meta: VatPositionDetailMeta;
}

interface RawDetailRow {
  source_type: string;
  source_document_id: string;
  source_line_id: string;
  source_document_reference: string | null;
  source_document_date: unknown;
  tax_code_id: string;
  code: string;
  name: string;
  direction: string;
  signed_tax_contribution_minor: unknown;
}

interface RawReconciliationRow {
  tax_code_id: string;
  code: string;
  direction: string;
  net_tax_contribution_minor: unknown;
}

interface RawCodeRow {
  tax_code_id: string;
  code: string;
  name: string;
  treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  supply_value_minor: unknown;
  tax_minor: unknown;
  calculated_tax_minor: unknown;
}

interface RawTotalsRow {
  total_tax_minor: unknown;
}

/** Tax/VAT Phase 6 — one row per (tax code, tax direction) combination
 * seen on any POSTED, explicitly-classified manual journal line this
 * window. net_tax_minor is already signed per the formula in
 * manualTaxRows()'s own doc comment — no separate primary/contra pair
 * to net against, unlike codeRows()/RawCodeRow (reversals net to zero
 * within this single signed sum instead). */
interface RawManualCodeRow {
  tax_code_id: string;
  code: string;
  name: string;
  treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  tax_direction: "INPUT" | "OUTPUT";
  net_tax_minor: unknown;
}

/**
 * Tax/VAT Phase 4 — VAT Position Report.
 * docs/finance-work-item-tax-vat-phase-4-discovery.md, CTO-authorized
 * implementation resolving discovery §11 decisions 1-5 as recommended
 * there (decision 6, the stale roadmap paragraph, is a separate
 * documentation-only fix — see this phase's completion report).
 *
 * Read-only, full stop: no INSERT/UPDATE/DELETE anywhere in this file,
 * no audit-log writes (reads are never audited anywhere in this
 * codebase — same convention every other report service documents).
 * Runs inside `withTenant(tenantId, ..., REPORT_TX_CONFIG)`
 * (REPEATABLE READ + READ ONLY, imported directly from
 * general-ledger.service.ts rather than duplicated, the exact
 * convention `ApReportsService`/`ArReportsService`/
 * `FinancialStatementsService` already established) — this report reads
 * four separate line tables plus an optional GL cross-check across
 * several statements, and needs the identical one-snapshot guarantee
 * every other multi-statement Finance report already relies on.
 *
 * No dependency on `TaxConfigurationModule`/`TaxRatesService` at all
 * (discovery §5) — this report only ever reads already-snapshotted
 * `tax_code_id`/`tax_rate_id`/`tax_amount_minor` values (AP/AR) or
 * already-supplied `tax_code_id`/`tax_direction` values (manual, Phase
 * 6) off posted lines, never resolves a rate or calculates a tax
 * amount itself.
 *
 * Central architectural fact this file was originally built on
 * (discovery §3.2, confirmed by direct read of
 * `CustomerInvoicesService.post()`/`SupplierBillsService.post()`):
 * posting an AP/AR document writes ONE aggregate tax `journal_lines`
 * row per document, summed across every tax code on it — an AP/AR
 * per-tax-code breakdown is structurally impossible from that side of
 * the General Ledger, so every `*ByTaxCode` figure sourced from AP/AR
 * is read from the four document line tables directly
 * (`supplier_bill_lines`, `supplier_debit_note_lines`,
 * `customer_invoice_lines`, `customer_credit_note_lines`), never from
 * `journal_lines`.
 *
 * Tax/VAT Phase 6 (docs/finance-work-item-tax-vat-phase-6-manual-journal-tax-coverage-proposal.md,
 * CTO-approved implementation authorization) changes the previous
 * "journal_lines carries no tax_code_id at all" statement: migration
 * 0024 adds an OPTIONAL, explicitly-supplied `tax_code_id`/
 * `tax_direction` pair to `journal_lines`, for MANUALLY tax-classified
 * lines only (never auto-derived from AP/AR posting — those aggregate
 * lines are never tax-tagged). `manualTaxRows()` below reads exactly
 * that new, narrow slice of `journal_lines` — explicitly-tagged lines
 * only (`tax_code_id IS NOT NULL`) — and is additive to, not a
 * replacement for, the four-table AP/AR read above. The GL read layer
 * is still used only for the coarser, optional `glCrossCheck`
 * against the two singleton tax accounts, not a source of per-code
 * data.
 *
 * Polarity (discovery §3.3, confirmed by direct read of the posting
 * code and the existing e2e posting tests, not assumed): invoices
 * CREDIT the AR tax-output account and bills DEBIT the AP tax-input
 * account; credit notes and debit notes both REVERSE their own
 * document type's polarity. Economically this means credit notes
 * REDUCE previously-recognized output tax and debit notes REDUCE
 * previously-recognized input tax — `tax_amount_minor` is always
 * stored non-negative on all four tables (CHECK-constrained), so every
 * query below computes the net figure in application code as
 * `primary - contra`, never by relying on a stored sign.
 */
@Injectable()
export class TaxReportsService {
  async getVatPosition(
    tenantId: string,
    legalEntityId: string,
    query: VatPositionQueryDto,
  ): Promise<VatPositionResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let dateFrom: string;
        let dateTo: string;
        let periodId: string | null;

        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          dateFrom = period.startDate;
          dateTo = period.endDate;
          periodId = period.id;
        } else if (query.dateFrom && query.dateTo) {
          dateFrom = query.dateFrom;
          dateTo = query.dateTo;
          periodId = null;
        } else {
          // discovery §6.2 / the DTO's own doc comment: unlike P&L's
          // open-ended-by-default dateFrom, a VAT position report with
          // no lower bound at all would aggregate every posted document
          // ever created — never a coherent "VAT position" for a filing
          // period — so an explicit window (or periodId) is required,
          // not silently defaulted.
          throw new BadRequestException(
            "A VAT position report requires either a periodId or both dateFrom and dateTo.",
          );
        }

        const currencyCode = await this.resolveCurrency(
          tx,
          tenantId,
          legalEntityId,
        );

        // Output side — customer invoices (primary) net of customer
        // credit notes (contra), grouped by tax_code_id.
        const invoiceRows = await this.codeRows(
          tx,
          tenantId,
          legalEntityId,
          "customer_invoice_lines",
          "customer_invoices",
          "invoice_id",
          "invoice_date",
          dateFrom,
          dateTo,
        );
        const creditNoteRows = await this.codeRows(
          tx,
          tenantId,
          legalEntityId,
          "customer_credit_note_lines",
          "customer_credit_notes",
          "credit_note_id",
          "credit_note_date",
          dateFrom,
          dateTo,
        );
        let outputByTaxCode = this.netByCode(invoiceRows, creditNoteRows);

        // Input side — supplier bills (primary) net of supplier debit
        // notes (contra), grouped by tax_code_id.
        const billRows = await this.codeRows(
          tx,
          tenantId,
          legalEntityId,
          "supplier_bill_lines",
          "supplier_bills",
          "bill_id",
          "bill_date",
          dateFrom,
          dateTo,
        );
        const debitNoteRows = await this.codeRows(
          tx,
          tenantId,
          legalEntityId,
          "supplier_debit_note_lines",
          "supplier_debit_notes",
          "debit_note_id",
          "debit_note_date",
          dateFrom,
          dateTo,
        );
        let inputByTaxCode = this.netByCode(billRows, debitNoteRows);

        // Tax/VAT Phase 6 (CTO authorization §8.7 — CTO DECISION: manual
        // tax MUST be included in the existing VAT headline totals, not
        // a separate headline) — explicitly tax-classified manual
        // journal lines, already net per code+direction (reversals
        // cancel out within manualTaxRows() itself; see that method's
        // doc comment). Merged into the SAME outputByTaxCode/
        // inputByTaxCode arrays AP/AR already populate, each row's
        // manualTaxMinor tracking the manual-only portion so the
        // AP/AR-only figure stays recoverable (`netTaxMinor -
        // manualTaxMinor`) — the "detailed source attribution" the CTO
        // decision requires alongside the unified headline.
        const manualRows = await this.manualTaxRows(
          tx,
          tenantId,
          legalEntityId,
          dateFrom,
          dateTo,
        );
        const manualOutputRows = manualRows.filter(
          (r) => r.tax_direction === "OUTPUT",
        );
        const manualInputRows = manualRows.filter(
          (r) => r.tax_direction === "INPUT",
        );
        outputByTaxCode = this.mergeManualIntoByCode(
          outputByTaxCode,
          manualOutputRows,
        );
        inputByTaxCode = this.mergeManualIntoByCode(
          inputByTaxCode,
          manualInputRows,
        );
        const manualOutputTaxMinor = manualOutputRows.reduce(
          (sum, r) => sum + this.toNumber(r.net_tax_minor),
          0,
        );
        const manualInputTaxMinor = manualInputRows.reduce(
          (sum, r) => sum + this.toNumber(r.net_tax_minor),
          0,
        );

        // Headline totals — computed independently of tax-code
        // classification (no `tax_code_id IS NOT NULL` filter), so
        // `outputTaxMinor`/`inputTaxMinor` always equal the true total
        // regardless of how much of it is classified (discovery §7):
        // unclassified (legacy, no taxCodeId) lines roll into these
        // totals, and `unclassifiedOutputTaxMinor`/
        // `unclassifiedInputTaxMinor` is simply the remainder after
        // subtracting the classified sum — never a separately-computed
        // figure that could drift from the total by a second query.
        const totalInvoiceTax = await this.totalTax(
          tx,
          tenantId,
          legalEntityId,
          "customer_invoice_lines",
          "customer_invoices",
          "invoice_id",
          "invoice_date",
          dateFrom,
          dateTo,
        );
        const totalCreditNoteTax = await this.totalTax(
          tx,
          tenantId,
          legalEntityId,
          "customer_credit_note_lines",
          "customer_credit_notes",
          "credit_note_id",
          "credit_note_date",
          dateFrom,
          dateTo,
        );
        // Tax/VAT Phase 6 (CTO authorization §8.7) — the unified
        // headline: AP/AR total, plus the net manual contribution.
        const outputTaxMinor =
          totalInvoiceTax - totalCreditNoteTax + manualOutputTaxMinor;
        const classifiedOutputTaxMinor = outputByTaxCode.reduce(
          (sum, r) => sum + r.netTaxMinor,
          0,
        );
        const unclassifiedOutputTaxMinor =
          outputTaxMinor - classifiedOutputTaxMinor;

        const totalBillTax = await this.totalTax(
          tx,
          tenantId,
          legalEntityId,
          "supplier_bill_lines",
          "supplier_bills",
          "bill_id",
          "bill_date",
          dateFrom,
          dateTo,
        );
        const totalDebitNoteTax = await this.totalTax(
          tx,
          tenantId,
          legalEntityId,
          "supplier_debit_note_lines",
          "supplier_debit_notes",
          "debit_note_id",
          "debit_note_date",
          dateFrom,
          dateTo,
        );
        const inputTaxMinor =
          totalBillTax - totalDebitNoteTax + manualInputTaxMinor;
        const classifiedInputTaxMinor = inputByTaxCode.reduce(
          (sum, r) => sum + r.netTaxMinor,
          0,
        );
        const unclassifiedInputTaxMinor =
          inputTaxMinor - classifiedInputTaxMinor;

        const glCrossCheck = await this.getGlCrossCheck(
          tx,
          tenantId,
          legalEntityId,
          dateFrom,
          dateTo,
          outputTaxMinor,
          inputTaxMinor,
        );

        return {
          outputByTaxCode,
          inputByTaxCode,
          meta: {
            legalEntityId,
            dateFrom,
            dateTo,
            periodId,
            currencyCode,
            outputTaxMinor,
            inputTaxMinor,
            netPositionMinor: outputTaxMinor - inputTaxMinor,
            unclassifiedOutputTaxMinor,
            unclassifiedInputTaxMinor,
            manualOutputTaxMinor,
            manualInputTaxMinor,
            glCrossCheck,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  /**
   * Tax/VAT Phase 7 — VAT Position Detail / Source-Document Drill-Down
   * (docs/work-items/tax-vat-phase-7-vat-position-detail-drill-down/CONTRACT.md,
   * ACCEPTANCE.md). Read-only; no tax calculation, no write path, no new
   * accounting behavior — restates `codeRows()`/`manualTaxRows()`'s own
   * predicates at row grain instead of `SUM()`/`GROUP BY` grain (§4,
   * §20). Runs inside the identical `REPORT_TX_CONFIG` transaction
   * (`REPEATABLE READ`, `READ ONLY`) `getVatPosition()`/`getLedger()`
   * already use — the page fetch, `totalItems` count, and
   * `reconciliationTotals` are all computed against the same MVCC
   * snapshot (§10A), never redefined or reused across separate requests
   * (§10B — no cross-request/server-side snapshot infrastructure is
   * introduced).
   */
  async getVatPositionDetail(
    tenantId: string,
    legalEntityId: string,
    query: VatPositionDetailQueryDto,
  ): Promise<VatPositionDetailResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let dateFrom: string;
        let dateTo: string;
        let periodId: string | null;

        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          dateFrom = period.startDate;
          dateTo = period.endDate;
          periodId = period.id;
        } else if (query.dateFrom && query.dateTo) {
          dateFrom = query.dateFrom;
          dateTo = query.dateTo;
          periodId = null;
        } else {
          // Identical rule to getVatPosition() (§8) — a detail drill-down
          // with no lower bound at all would scan every posted document
          // ever created, never a coherent single VAT filing window.
          throw new BadRequestException(
            "A VAT position detail report requires either a periodId or both dateFrom and dateTo.",
          );
        }

        // §8/§13/§15 — an explicitly supplied taxCodeId must resolve
        // within the caller's own tenant/legal entity or 404, identical
        // "resolve or 404" posture to resolvePeriodInScope() immediately
        // above (ACCEPTANCE.md DRILL-037 — corrected from its earlier
        // "400" wording, which cited resolvePeriodInScope() as its own
        // precedent while that precedent actually throws 404; the
        // precedent's real behavior governs, not the earlier wording —
        // see this phase's completion report).
        let taxCodeId: string | null = null;
        if (query.taxCodeId) {
          taxCodeId = await this.resolveTaxCodeInScope(
            tx,
            tenantId,
            legalEntityId,
            query.taxCodeId,
          );
        }

        const currencyCode = await this.resolveCurrency(
          tx,
          tenantId,
          legalEntityId,
        );

        const unionSql = this.detailUnionSql(
          tenantId,
          legalEntityId,
          dateFrom,
          dateTo,
        );
        const taxCodeFilter = taxCodeId
          ? sql`WHERE d.tax_code_id = ${taxCodeId}`
          : sql``;

        // Hardening Requirement 7 (§9, FROZEN) — filtering, ordering, and
        // pagination all happen at the database layer: three statements
        // against the same inner union, never a JS-side sort/slice of a
        // fully materialized result set. All three share one transaction
        // snapshot (§10A), so they are mutually consistent regardless of
        // concurrent posting activity elsewhere.
        const totalItems = await this.countDetailRows(
          tx,
          unionSql,
          taxCodeFilter,
        );

        const offset = (query.page - 1) * query.pageSize;
        const rows = await this.fetchDetailPage(
          tx,
          unionSql,
          taxCodeFilter,
          query.pageSize,
          offset,
        );

        // §11A (FROZEN) — computed over the COMPLETE filtered result,
        // never the returned page alone (Correction 3); this is a
        // separate, unpaginated aggregate query against the same inner
        // union/snapshot, not a client-side sum of `rows`.
        const reconciliationTotals = await this.fetchReconciliationTotals(
          tx,
          unionSql,
          taxCodeFilter,
        );

        return {
          rows,
          reconciliationTotals,
          meta: {
            legalEntityId,
            dateFrom,
            dateTo,
            periodId,
            taxCodeId,
            currencyCode,
            page: query.page,
            pageSize: query.pageSize,
            totalItems,
            totalPages: Math.ceil(totalItems / query.pageSize),
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /**
   * Tax/VAT Phase 7 (CONTRACT.md §21, FROZEN — "must be built from the
   * same predicate-construction logic ... shared/factored, not
   * hand-duplicated") — the base AP/AR document eligibility predicate
   * (tenant + legal-entity isolation, `status = 'POSTED'`, the
   * document's own canonical date column within [dateFrom, dateTo], and
   * the Document-Level Reversal exclusion,
   * docs/finance-work-item-document-reversal-proposal.md §12/§23) for
   * exactly one line table. Shared verbatim by `totalTax()` (aggregate
   * grain, unclassified included), `codeRows()`/`detailUnionSql()`'s
   * `apArBranch()` (both add the classified-only filter via
   * `apArClassifiedEligibilitySql()` below) — one place to change this
   * predicate, so the VAT Position headline and the Phase 7 detail
   * drill-down can never silently drift apart through an edit applied
   * to only one call site. Returns a bare boolean SQL fragment (no
   * leading `WHERE`), for splicing into each caller's own `WHERE`
   * clause; `doc`/`ln` are the fixed aliases every caller's `FROM`/
   * `JOIN` already establishes.
   */
  private apArEligibilitySql(
    tenantId: string,
    legalEntityId: string,
    dateColumn: string,
    dateFrom: string,
    dateTo: string,
  ) {
    return sql`
      ln.tenant_id = ${tenantId}
        AND doc.tenant_id = ${tenantId}
        AND doc.legal_entity_id = ${legalEntityId}
        AND doc.status = 'POSTED'
        AND doc.${sql.raw(dateColumn)} >= ${dateFrom}::date
        AND doc.${sql.raw(dateColumn)} <= ${dateTo}::date
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries je
          WHERE je.id = doc.journal_entry_id
            AND je.reversed_by_journal_entry_id IS NOT NULL
        )
    `;
  }

  /** `apArEligibilitySql()` plus the classified-only filter
   * (`ln.tax_code_id IS NOT NULL`) — the predicate `codeRows()` and
   * `detailUnionSql()`'s `apArBranch()` both use (CONTRACT.md §21). */
  private apArClassifiedEligibilitySql(
    tenantId: string,
    legalEntityId: string,
    dateColumn: string,
    dateFrom: string,
    dateTo: string,
  ) {
    return sql`${this.apArEligibilitySql(tenantId, legalEntityId, dateColumn, dateFrom, dateTo)} AND ln.tax_code_id IS NOT NULL`;
  }

  /** Per-tax-code SUM of supply value / tax / calculated tax for one
   * line table — the classified slice only (discovery §6.4's core query
   * shape), via the shared `apArClassifiedEligibilitySql()` predicate
   * (CONTRACT.md §21). Table/column names are passed as plain strings
   * from a fixed internal call set (never user input), so `sql.raw` on
   * the identifier is safe here — the same posture every other report
   * service's raw-SQL helpers already take with their own fixed table
   * names. */
  private async codeRows(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lineTable: string,
    parentTable: string,
    parentFk: string,
    dateColumn: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<RawCodeRow[]> {
    const rows = (await tx.execute(sql`
      SELECT
        tc.id AS tax_code_id,
        tc.code AS code,
        tc.name AS name,
        tc.treatment AS treatment,
        COALESCE(SUM(ln.amount_minor), 0) AS supply_value_minor,
        COALESCE(SUM(ln.tax_amount_minor), 0) AS tax_minor,
        COALESCE(SUM(COALESCE(ln.tax_amount_calculated_minor, ln.tax_amount_minor)), 0) AS calculated_tax_minor
      FROM ${sql.raw(lineTable)} ln
      INNER JOIN ${sql.raw(parentTable)} doc ON doc.id = ln.${sql.raw(parentFk)}
      INNER JOIN tax_codes tc ON tc.id = ln.tax_code_id
      WHERE ${this.apArClassifiedEligibilitySql(tenantId, legalEntityId, dateColumn, dateFrom, dateTo)}
      GROUP BY tc.id, tc.code, tc.name, tc.treatment
    `)) as unknown as RawCodeRow[];
    return rows;
  }

  /** Total tax (classified + unclassified) for one line table, the same
   * base eligibility as `codeRows()` but WITHOUT the classified-only
   * filter (`apArEligibilitySql()` directly, not
   * `apArClassifiedEligibilitySql()`) — the always-correct headline
   * figure `codeRows()`'s classified breakdown is reconciled against
   * (discovery §7). */
  private async totalTax(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lineTable: string,
    parentTable: string,
    parentFk: string,
    dateColumn: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<number> {
    const rows = (await tx.execute(sql`
      SELECT COALESCE(SUM(ln.tax_amount_minor), 0) AS total_tax_minor
      FROM ${sql.raw(lineTable)} ln
      INNER JOIN ${sql.raw(parentTable)} doc ON doc.id = ln.${sql.raw(parentFk)}
      WHERE ${this.apArEligibilitySql(tenantId, legalEntityId, dateColumn, dateFrom, dateTo)}
    `)) as unknown as RawTotalsRow[];
    return this.toNumber(rows[0]?.total_tax_minor);
  }

  /** Merges a primary (invoices/bills) and contra (credit/debit notes)
   * per-code row set into net figures — `net = primary - contra`,
   * unioning every tax_code_id that appears on EITHER side (a code used
   * only on a credit note this window, for instance, must still appear
   * with a negative net rather than being dropped). */
  private netByCode(
    primary: RawCodeRow[],
    contra: RawCodeRow[],
  ): VatPositionCodeRow[] {
    const byCode = new Map<string, VatPositionCodeRow>();
    for (const r of primary) {
      byCode.set(r.tax_code_id, {
        taxCodeId: r.tax_code_id,
        code: r.code,
        name: r.name,
        treatment: r.treatment,
        netSupplyValueMinor: this.toNumber(r.supply_value_minor),
        netTaxMinor: this.toNumber(r.tax_minor),
        netCalculatedTaxMinor: this.toNumber(r.calculated_tax_minor),
        manualTaxMinor: 0,
      });
    }
    for (const r of contra) {
      const existing = byCode.get(r.tax_code_id);
      const supply = this.toNumber(r.supply_value_minor);
      const tax = this.toNumber(r.tax_minor);
      const calc = this.toNumber(r.calculated_tax_minor);
      if (existing) {
        existing.netSupplyValueMinor -= supply;
        existing.netTaxMinor -= tax;
        existing.netCalculatedTaxMinor -= calc;
      } else {
        byCode.set(r.tax_code_id, {
          taxCodeId: r.tax_code_id,
          code: r.code,
          name: r.name,
          treatment: r.treatment,
          netSupplyValueMinor: -supply,
          netTaxMinor: -tax,
          netCalculatedTaxMinor: -calc,
          manualTaxMinor: 0,
        });
      }
    }
    return Array.from(byCode.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }

  /** Tax/VAT Phase 6 (CTO authorization §8.7/§8.9/§8.10) — every
   * explicitly tax-classified manual journal line (`journal_lines.
   * tax_code_id IS NOT NULL`) on a POSTED journal entry within the
   * report window, grouped by (tax code, tax direction) and net per
   * the signed-contribution formula:
   *   OUTPUT: SUM(credit_minor - debit_minor)
   *   INPUT:  SUM(debit_minor - credit_minor)
   * — mirroring how a credit/debit note already contributes negatively
   * against its own primary document type elsewhere in this file, so a
   * reversal (same tax_code_id/tax_direction, swapped debit/credit —
   * JournalEntriesService.completeReversalPosting(), CTO authorization
   * §8.6) always nets its original's row to exactly zero WITHIN this
   * single query. Deliberately does NOT exclude reversed entries the
   * way codeRows()/totalTax() exclude a reversed AP/AR document's
   * journal — there is no separate "document row" for a manual entry
   * to net against; the original and its reversal are each their own
   * POSTED journal_entries row with their own tax-tagged lines, and
   * excluding either one would leave the OTHER one's contribution
   * unmatched (a wrong, nonzero residual) rather than a correct zero.
   * A DRAFT manual entry (je.status != 'POSTED') never contributes,
   * matching §8.4 (only posted classification is authoritative). Scoped
   * by transactionDate, the manual-journal analogue of AP/AR's own
   * document-date columns. */
  private async manualTaxRows(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<RawManualCodeRow[]> {
    const rows = (await tx.execute(sql`
      SELECT
        tc.id AS tax_code_id,
        tc.code AS code,
        tc.name AS name,
        tc.treatment AS treatment,
        jl.tax_direction AS tax_direction,
        COALESCE(SUM(
          CASE
            WHEN jl.tax_direction = 'OUTPUT' THEN jl.credit_minor - jl.debit_minor
            WHEN jl.tax_direction = 'INPUT' THEN jl.debit_minor - jl.credit_minor
          END
        ), 0) AS net_tax_minor
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      INNER JOIN tax_codes tc ON tc.id = jl.tax_code_id
      WHERE ${this.manualJournalEligibilitySql(tenantId, legalEntityId, dateFrom, dateTo)}
      GROUP BY tc.id, tc.code, tc.name, tc.treatment, jl.tax_direction
    `)) as unknown as RawManualCodeRow[];
    return rows;
  }

  /** Tax/VAT Phase 7 (CONTRACT.md §21, FROZEN) — the manual-journal
   * eligibility predicate (tenant + legal-entity isolation, `status =
   * 'POSTED'`, `transaction_date` within [dateFrom, dateTo], explicitly
   * tax-classified lines only — deliberately NO reversal exclusion, §7:
   * a manual reversal is its own independent POSTED row that nets to
   * zero purely through signed arithmetic). Shared verbatim by
   * `manualTaxRows()` (aggregate grain) and `detailUnionSql()`'s
   * `manualBranch` (row grain) — same one-predicate-one-place reasoning
   * as `apArEligibilitySql()` above. */
  private manualJournalEligibilitySql(
    tenantId: string,
    legalEntityId: string,
    dateFrom: string,
    dateTo: string,
  ) {
    return sql`
      jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND je.transaction_date >= ${dateFrom}::date
        AND je.transaction_date <= ${dateTo}::date
        AND jl.tax_code_id IS NOT NULL
    `;
  }

  /** Merges manual journal tax rows (one direction's worth — OUTPUT or
   * INPUT) into an existing AP/AR-sourced byCode array, mutating each
   * matched row's netTaxMinor/netCalculatedTaxMinor/manualTaxMinor in
   * place and appending a fresh row (netSupplyValueMinor: 0 — a manual
   * journal line has no base/supply-value concept at all, CTO
   * authorization §8.2/§11's null-vs-zero fallback clause: this field's
   * existing non-nullable `number` contract is preserved rather than
   * widened to `number | null` for the sake of one new, always-optional
   * source) for a code seen only on manual lines this window.
   * netCalculatedTaxMinor tracks netTaxMinor exactly for the manual
   * portion — manual tax is never "calculated vs. overridden" (CTO
   * authorization §8.2: no calculation exists to override), so
   * calculated == actual always holds for it, preserving this field's
   * existing "equals netTaxMinor iff nothing was overridden" meaning
   * for AP/AR consumers. */
  private mergeManualIntoByCode(
    base: VatPositionCodeRow[],
    manualRows: RawManualCodeRow[],
  ): VatPositionCodeRow[] {
    const byCode = new Map<string, VatPositionCodeRow>(
      base.map((r) => [r.taxCodeId, r]),
    );
    for (const r of manualRows) {
      const manualTax = this.toNumber(r.net_tax_minor);
      const existing = byCode.get(r.tax_code_id);
      if (existing) {
        existing.netTaxMinor += manualTax;
        existing.netCalculatedTaxMinor += manualTax;
        existing.manualTaxMinor += manualTax;
      } else {
        byCode.set(r.tax_code_id, {
          taxCodeId: r.tax_code_id,
          code: r.code,
          name: r.name,
          treatment: r.treatment,
          netSupplyValueMinor: 0,
          netTaxMinor: manualTax,
          netCalculatedTaxMinor: manualTax,
          manualTaxMinor: manualTax,
        });
      }
    }
    return Array.from(byCode.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }

  /** Optional GL cross-check (discovery §6.3/§6.4) — a coarse,
   * period-movement sanity check against the two singleton tax
   * accounts, NOT a source of per-tax-code data (the classified AP/AR
   * breakdown reads the four document line tables directly, and the
   * manual breakdown reads journal_lines.tax_code_id directly — this
   * cross-check instead reads aggregate GL account movement only, by
   * accountId, regardless of tax_code_id). Polarity confirmed by direct
   * read of the posting code this session: invoices CREDIT
   * taxOutputAccountId, credit notes DEBIT it (reversed) — so output
   * movement is `SUM(credit) - SUM(debit)`. Bills DEBIT
   * taxInputAccountId, debit notes CREDIT it (reversed) — so input
   * movement is `SUM(debit) - SUM(credit)`. Never throws when AP/AR
   * settings don't exist or carry no tax account — a legal entity with
   * no tax activity yet is a normal state for this report, not an
   * error (deliberately NOT the same posture as
   * `ApReportsService.getApReconciliation`'s `loadApSettingsOrThrow`,
   * which 404s — that endpoint is specifically ABOUT the AP control
   * account and cannot mean anything without it; this report's primary
   * value is the tax-code breakdown, which is fully meaningful with a
   * zero cross-check). */
  private async getGlCrossCheck(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    dateFrom: string,
    dateTo: string,
    outputTaxMinor: number,
    inputTaxMinor: number,
  ): Promise<VatPositionGlCrossCheck> {
    const [ar] = await tx
      .select({ taxOutputAccountId: arSettings.taxOutputAccountId })
      .from(arSettings)
      .where(
        and(
          eq(arSettings.tenantId, tenantId),
          eq(arSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    const [ap] = await tx
      .select({ taxInputAccountId: apSettings.taxInputAccountId })
      .from(apSettings)
      .where(
        and(
          eq(apSettings.tenantId, tenantId),
          eq(apSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);

    const taxOutputAccountId = ar?.taxOutputAccountId ?? null;
    const taxInputAccountId = ap?.taxInputAccountId ?? null;

    const glOutputTaxMovementMinor = taxOutputAccountId
      ? await this.glMovement(
          tx,
          tenantId,
          legalEntityId,
          taxOutputAccountId,
          dateFrom,
          dateTo,
          "credit",
        )
      : 0;
    const glInputTaxMovementMinor = taxInputAccountId
      ? await this.glMovement(
          tx,
          tenantId,
          legalEntityId,
          taxInputAccountId,
          dateFrom,
          dateTo,
          "debit",
        )
      : 0;

    const outputDifferenceMinor = outputTaxMinor - glOutputTaxMovementMinor;
    const inputDifferenceMinor = inputTaxMinor - glInputTaxMovementMinor;

    // Tax/VAT Phase 5 (proposal §8) — the additive multi-account
    // breakdown, derived from each line's own resolvedTaxAccountId
    // snapshot rather than current configuration.
    const outputTaxAccounts = await this.accountBreakdown(
      tx,
      tenantId,
      legalEntityId,
      dateFrom,
      dateTo,
      "customer_invoice_lines",
      "customer_invoices",
      "invoice_id",
      "invoice_date",
      "customer_credit_note_lines",
      "customer_credit_notes",
      "credit_note_id",
      "credit_note_date",
      taxOutputAccountId,
      "credit",
    );
    const inputTaxAccounts = await this.accountBreakdown(
      tx,
      tenantId,
      legalEntityId,
      dateFrom,
      dateTo,
      "supplier_bill_lines",
      "supplier_bills",
      "bill_id",
      "bill_date",
      "supplier_debit_note_lines",
      "supplier_debit_notes",
      "debit_note_id",
      "debit_note_date",
      taxInputAccountId,
      "debit",
    );

    return {
      taxOutputAccountId,
      glOutputTaxMovementMinor,
      outputDifferenceMinor,
      outputReconciled: outputDifferenceMinor === 0,
      taxInputAccountId,
      glInputTaxMovementMinor,
      inputDifferenceMinor,
      inputReconciled: inputDifferenceMinor === 0,
      outputTaxAccounts,
      inputTaxAccounts,
    };
  }

  /** Tax/VAT Phase 5 (proposal §8) — builds one direction's
   * (output/input) full multi-account breakdown: every distinct
   * resolvedTaxAccountId actually snapshotted on in-window POSTED
   * primary/contra lines (net = primary - contra, same reasoning as
   * `netByCode`), unioned with `singletonAccountId` (added at a zero
   * source-line total if it saw no lines this window, so the singleton
   * always appears even when every line resolved to a code-level
   * override instead). Each account's GL movement is computed with the
   * SAME `glMovement` helper/polarity the singleton cross-check above
   * already uses. */
  private async accountBreakdown(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    dateFrom: string,
    dateTo: string,
    primaryLineTable: string,
    primaryParentTable: string,
    primaryParentFk: string,
    primaryDateColumn: string,
    contraLineTable: string,
    contraParentTable: string,
    contraParentFk: string,
    contraDateColumn: string,
    singletonAccountId: string | null,
    normalSide: "debit" | "credit",
  ): Promise<VatPositionGlAccountBreakdown[]> {
    const primary = await this.resolvedAccountTax(
      tx,
      tenantId,
      legalEntityId,
      primaryLineTable,
      primaryParentTable,
      primaryParentFk,
      primaryDateColumn,
      dateFrom,
      dateTo,
    );
    const contra = await this.resolvedAccountTax(
      tx,
      tenantId,
      legalEntityId,
      contraLineTable,
      contraParentTable,
      contraParentFk,
      contraDateColumn,
      dateFrom,
      dateTo,
    );

    const net = new Map<string, number>(primary);
    for (const [accountId, taxMinor] of contra) {
      net.set(accountId, (net.get(accountId) ?? 0) - taxMinor);
    }
    if (singletonAccountId && !net.has(singletonAccountId)) {
      net.set(singletonAccountId, 0);
    }

    const breakdown: VatPositionGlAccountBreakdown[] = [];
    for (const accountId of [...net.keys()].sort()) {
      const sourceLineTaxMinor = net.get(accountId)!;
      const glMovementMinor = await this.glMovement(
        tx,
        tenantId,
        legalEntityId,
        accountId,
        dateFrom,
        dateTo,
        normalSide,
      );
      const differenceMinor = sourceLineTaxMinor - glMovementMinor;
      breakdown.push({
        accountId,
        sourceLineTaxMinor,
        glMovementMinor,
        differenceMinor,
        reconciled: differenceMinor === 0,
      });
    }
    return breakdown;
  }

  /** Per-account SUM of tax_amount_minor for one line table, restricted
   * to POSTED parents dated within [dateFrom, dateTo] and to lines that
   * actually carry a resolvedTaxAccountId — the historical-fact source
   * `accountBreakdown` nets primary against contra with. Same
   * fixed-internal-call-set `sql.raw` posture as `codeRows`/`totalTax`
   * above. */
  private async resolvedAccountTax(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lineTable: string,
    parentTable: string,
    parentFk: string,
    dateColumn: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<Map<string, number>> {
    const rows = (await tx.execute(sql`
      SELECT
        ln.resolved_tax_account_id AS account_id,
        COALESCE(SUM(ln.tax_amount_minor), 0) AS tax_minor
      FROM ${sql.raw(lineTable)} ln
      INNER JOIN ${sql.raw(parentTable)} doc ON doc.id = ln.${sql.raw(parentFk)}
      WHERE ln.tenant_id = ${tenantId}
        AND doc.tenant_id = ${tenantId}
        AND doc.legal_entity_id = ${legalEntityId}
        AND doc.status = 'POSTED'
        AND doc.${sql.raw(dateColumn)} >= ${dateFrom}::date
        AND doc.${sql.raw(dateColumn)} <= ${dateTo}::date
        AND ln.resolved_tax_account_id IS NOT NULL
      GROUP BY ln.resolved_tax_account_id
    `)) as unknown as Array<{ account_id: string; tax_minor: unknown }>;
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.account_id, this.toNumber(r.tax_minor));
    }
    return map;
  }

  /** Period MOVEMENT on one account (not a cumulative balance —
   * deliberately distinct from `ApReportsService.glLiabilityBalance`'s
   * point-in-time style, per the discovery's own §6.4 caution against
   * copying the wrong variant): `SUM(credit) - SUM(debit)` when
   * `normalSide: "credit"` (output tax), `SUM(debit) - SUM(credit)`
   * when `normalSide: "debit"` (input tax), over POSTED journal_lines
   * whose parent journal_entries.transaction_date falls within
   * [dateFrom, dateTo]. */
  private async glMovement(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string,
    dateTo: string,
    normalSide: "debit" | "credit",
  ): Promise<number> {
    const rows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(jl.debit_minor), 0) AS raw_debit,
        COALESCE(SUM(jl.credit_minor), 0) AS raw_credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId}
        AND jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND je.transaction_date >= ${dateFrom}::date
        AND je.transaction_date <= ${dateTo}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    return normalSide === "credit"
      ? rawCredit - rawDebit
      : rawDebit - rawCredit;
  }

  /** Identical shape/reasoning to every other report service's own
   * local `resolvePeriodInScope` (`FinancialStatementsService`,
   * `GeneralLedgerService`) — duplicated locally per this codebase's
   * established "duplicate the trivial single-table lookup" convention
   * rather than imported, since it isn't exported as a standalone
   * helper from either of those files. */
  private async resolvePeriodInScope(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    periodId: string,
  ) {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.id, periodId),
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!period) {
      throw new NotFoundException(
        `No accounting period found with id ${periodId}.`,
      );
    }
    return period;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to every other report
   * service's own local `resolveCurrency`, duplicated locally. */
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

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }

  /** Normalizes a raw driver value for a Postgres `date` column to a
   * plain `YYYY-MM-DD` string — identical helper/reasoning to
   * `GeneralLedgerService.dateOnly()` (general-ledger.service.ts),
   * duplicated locally per this codebase's established
   * duplicate-the-trivial-helper convention (see `resolvePeriodInScope`/
   * `resolveCurrency`'s own doc comments above) rather than imported;
   * `tx.execute()` bypasses Drizzle's own column-mode mapping, so a raw
   * `date` column needs this explicit normalization regardless of
   * whether the driver handed back a JS `Date` or an already-formatted
   * string. */
  private dateOnly(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "string") {
      return value.length >= 10 ? value.slice(0, 10) : value;
    }
    return String(value);
  }

  /** Tax/VAT Phase 7 (CONTRACT.md §13/§15) — resolves an explicitly
   * supplied `taxCodeId` within the caller's own tenant AND legal
   * entity, or 404s — identical "resolve or 404" shape to
   * `resolvePeriodInScope` immediately above (a tax code belonging to a
   * different legal entity of the same tenant, or a different tenant
   * entirely, must never silently narrow the result to zero rows; it
   * must be rejected explicitly, matching §13's "an id-based lookup must
   * never become an authorization bypass" invariant). */
  private async resolveTaxCodeInScope(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    taxCodeId: string,
  ): Promise<string> {
    const [taxCode] = await tx
      .select({ id: taxCodes.id })
      .from(taxCodes)
      .where(
        and(
          eq(taxCodes.id, taxCodeId),
          eq(taxCodes.tenantId, tenantId),
          eq(taxCodes.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!taxCode) {
      throw new NotFoundException(
        `No tax code found with id ${taxCodeId} for this legal entity.`,
      );
    }
    return taxCode.id;
  }

  /** Tax/VAT Phase 7 (CONTRACT.md §5/§6/§7/§9/§20/§21) — the row-grain
   * union of all five tax-bearing source types, built from the SAME
   * shared predicate helpers `codeRows()`/`totalTax()`/`manualTaxRows()`
   * call above — `apArClassifiedEligibilitySql()` for the four AP/AR
   * branches, `manualJournalEligibilitySql()` for the manual branch
   * (tenant + legal-entity + `status = 'POSTED'` + date-window +
   * `tax_code_id IS NOT NULL`; AP/AR's own-document reversal exclusion
   * via `journal_entries.reversed_by_journal_entry_id`; manual
   * journal's deliberate NON-exclusion, §7). §21 (FROZEN) requires this
   * be genuinely shared/factored, not merely hand-duplicated code that
   * happens to look the same — the two eligibility helpers are the
   * single place either predicate is expressed; changing one caller
   * without the other is no longer possible, and this file has no
   * second, independent copy of either predicate anywhere. Restated at
   * row grain instead of `SUM()`/`GROUP BY` grain. Combined with
   * `UNION ALL`, never bare `UNION`
   * (Hardening Requirement 12) — a bare `UNION` would silently
   * deduplicate two coincidentally-identical rows, violating §6's
   * one-row-per-source-line guarantee. Returns the inner subquery only
   * (no `taxCodeId` filter, no `ORDER BY`, no `LIMIT`/`OFFSET`) — every
   * caller wraps it for counting, paging, or reconciliation totals, all
   * three inside the same `REPORT_TX_CONFIG` transaction/snapshot. */
  private detailUnionSql(
    tenantId: string,
    legalEntityId: string,
    dateFrom: string,
    dateTo: string,
  ) {
    const apArBranch = (
      sourceType: string,
      direction: "INPUT" | "OUTPUT",
      contraSign: 1 | -1,
      lineTable: string,
      parentTable: string,
      parentFk: string,
      dateColumn: string,
    ) => sql`
      SELECT
        ${sourceType}::text AS source_type,
        doc.id AS source_document_id,
        ln.id AS source_line_id,
        doc.internal_reference AS source_document_reference,
        doc.${sql.raw(dateColumn)} AS source_document_date,
        tc.id AS tax_code_id,
        tc.code AS code,
        tc.name AS name,
        ${direction}::text AS direction,
        ${
          contraSign === 1
            ? sql`ln.tax_amount_minor`
            : sql`-ln.tax_amount_minor`
        } AS signed_tax_contribution_minor
      FROM ${sql.raw(lineTable)} ln
      INNER JOIN ${sql.raw(parentTable)} doc ON doc.id = ln.${sql.raw(parentFk)}
      INNER JOIN tax_codes tc ON tc.id = ln.tax_code_id
      WHERE ${this.apArClassifiedEligibilitySql(tenantId, legalEntityId, dateColumn, dateFrom, dateTo)}
    `;

    // §7 — deliberately NO reversal exclusion here: a manual reversal is
    // its own independent POSTED journal_lines row (same
    // tax_code_id/tax_direction, swapped debit/credit) and nets to zero
    // purely through this row's own signed arithmetic, exactly as
    // manualTaxRows() above already does at aggregate grain.
    const manualBranch = sql`
      SELECT
        'MANUAL_JOURNAL'::text AS source_type,
        je.id AS source_document_id,
        jl.id AS source_line_id,
        je.journal_number AS source_document_reference,
        je.transaction_date AS source_document_date,
        tc.id AS tax_code_id,
        tc.code AS code,
        tc.name AS name,
        jl.tax_direction::text AS direction,
        CASE
          WHEN jl.tax_direction = 'OUTPUT' THEN jl.credit_minor - jl.debit_minor
          WHEN jl.tax_direction = 'INPUT' THEN jl.debit_minor - jl.credit_minor
        END AS signed_tax_contribution_minor
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      INNER JOIN tax_codes tc ON tc.id = jl.tax_code_id
      WHERE ${this.manualJournalEligibilitySql(tenantId, legalEntityId, dateFrom, dateTo)}
    `;

    return sql.join(
      [
        apArBranch(
          "SUPPLIER_BILL",
          "INPUT",
          1,
          "supplier_bill_lines",
          "supplier_bills",
          "bill_id",
          "bill_date",
        ),
        apArBranch(
          "SUPPLIER_DEBIT_NOTE",
          "INPUT",
          -1,
          "supplier_debit_note_lines",
          "supplier_debit_notes",
          "debit_note_id",
          "debit_note_date",
        ),
        apArBranch(
          "CUSTOMER_INVOICE",
          "OUTPUT",
          1,
          "customer_invoice_lines",
          "customer_invoices",
          "invoice_id",
          "invoice_date",
        ),
        apArBranch(
          "CUSTOMER_CREDIT_NOTE",
          "OUTPUT",
          -1,
          "customer_credit_note_lines",
          "customer_credit_notes",
          "credit_note_id",
          "credit_note_date",
        ),
        manualBranch,
      ],
      sql` UNION ALL `,
    );
  }

  /** `COUNT(*)` over the filtered union — Hardening Requirement 7,
   * database-side, same transaction/snapshot as the page fetch and
   * reconciliation totals. */
  private async countDetailRows(
    tx: TxClient,
    unionSql: ReturnType<TaxReportsService["detailUnionSql"]>,
    taxCodeFilter: ReturnType<TaxReportsService["detailUnionSql"]>,
  ): Promise<number> {
    const rows = (await tx.execute(sql`
      SELECT COUNT(*) AS total
      FROM (${unionSql}) d
      ${taxCodeFilter}
    `)) as unknown as Array<{ total: unknown }>;
    return this.toNumber(rows[0]?.total);
  }

  /** One page of detail rows, ordered per CONTRACT.md §9's frozen total
   * order (`sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC`),
   * `LIMIT`/`OFFSET` applied at the database layer. */
  private async fetchDetailPage(
    tx: TxClient,
    unionSql: ReturnType<TaxReportsService["detailUnionSql"]>,
    taxCodeFilter: ReturnType<TaxReportsService["detailUnionSql"]>,
    pageSize: number,
    offset: number,
  ): Promise<VatPositionDetailRow[]> {
    const rows = (await tx.execute(sql`
      SELECT *
      FROM (${unionSql}) d
      ${taxCodeFilter}
      ORDER BY d.source_document_date ASC, d.source_type ASC, d.source_line_id ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `)) as unknown as RawDetailRow[];
    return rows.map((r) => ({
      sourceType: r.source_type as VatPositionDetailRow["sourceType"],
      sourceDocumentId: r.source_document_id,
      sourceLineId: r.source_line_id,
      sourceDocumentReference: r.source_document_reference,
      sourceDocumentDate: this.dateOnly(r.source_document_date),
      taxCodeId: r.tax_code_id,
      code: r.code,
      name: r.name,
      direction: r.direction as "INPUT" | "OUTPUT",
      signedTaxContributionMinor: this.toNumber(
        r.signed_tax_contribution_minor,
      ),
    }));
  }

  /** §11A (FROZEN) — one entry per `(taxCodeId, direction, code)` over
   * the COMPLETE filtered result (no `LIMIT`/`OFFSET`), same
   * transaction/snapshot as the page fetch above — never a client-side
   * sum of the returned page. */
  private async fetchReconciliationTotals(
    tx: TxClient,
    unionSql: ReturnType<TaxReportsService["detailUnionSql"]>,
    taxCodeFilter: ReturnType<TaxReportsService["detailUnionSql"]>,
  ): Promise<VatPositionReconciliationTotal[]> {
    const rows = (await tx.execute(sql`
      SELECT
        d.tax_code_id AS tax_code_id,
        d.code AS code,
        d.direction AS direction,
        COALESCE(SUM(d.signed_tax_contribution_minor), 0) AS net_tax_contribution_minor
      FROM (${unionSql}) d
      ${taxCodeFilter}
      GROUP BY d.tax_code_id, d.code, d.direction
      ORDER BY d.code ASC, d.direction ASC
    `)) as unknown as RawReconciliationRow[];
    return rows.map((r) => ({
      taxCodeId: r.tax_code_id,
      code: r.code,
      direction: r.direction as "INPUT" | "OUTPUT",
      netTaxContributionMinor: this.toNumber(r.net_tax_contribution_minor),
    }));
  }
}
