import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, legalEntities, sql } from "@noryx/db-core";
import { apSettings, arSettings, accountingPeriods } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { REPORT_TX_CONFIG } from "../general-ledger/general-ledger.service";
import type { VatPositionQueryDto } from "./dto/vat-position-query.dto";

export interface VatPositionCodeRow {
  taxCodeId: string;
  code: string;
  name: string;
  treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  netSupplyValueMinor: number;
  netTaxMinor: number;
  netCalculatedTaxMinor: number;
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
  glCrossCheck: VatPositionGlCrossCheck;
}

export interface VatPositionResult {
  outputByTaxCode: VatPositionCodeRow[];
  inputByTaxCode: VatPositionCodeRow[];
  meta: VatPositionMeta;
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
 * No new schema, no new table, no new migration (discovery §4) — every
 * column this report reads already exists, written correctly by
 * Tax/VAT Phases 1-3. No dependency on `TaxConfigurationModule`/
 * `TaxRatesService` at all (discovery §5) — this report only ever reads
 * already-snapshotted `tax_code_id`/`tax_rate_id`/`tax_amount_minor`
 * values off posted lines, never resolves a rate itself.
 *
 * Central architectural fact this file is built on (discovery §3.2,
 * confirmed by direct read of `CustomerInvoicesService.post()`/
 * `SupplierBillsService.post()` this session): posting writes ONE
 * aggregate tax `journal_lines` row per document, summed across every
 * tax code on it. `journal_lines` carries no `tax_code_id` at all, so a
 * per-tax-code breakdown is structurally impossible from the General
 * Ledger — every `*ByTaxCode` figure here is read from the four
 * document line tables directly (`supplier_bill_lines`,
 * `supplier_debit_note_lines`, `customer_invoice_lines`,
 * `customer_credit_note_lines`), never from `journal_lines`. The GL
 * read layer is used only for the coarser, optional `glCrossCheck`
 * section (§6.3/§6.4 of the discovery) — a movement-sum sanity check
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
        const outputByTaxCode = this.netByCode(invoiceRows, creditNoteRows);

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
        const inputByTaxCode = this.netByCode(billRows, debitNoteRows);

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
        const outputTaxMinor = totalInvoiceTax - totalCreditNoteTax;
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
        const inputTaxMinor = totalBillTax - totalDebitNoteTax;
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
            glCrossCheck,
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

  /** Per-tax-code SUM of supply value / tax / calculated tax for one
   * line table, restricted to POSTED parents dated within [dateFrom,
   * dateTo] and to lines that actually carry a taxCodeId — the
   * classified slice only (discovery §6.4's core query shape). Table/
   * column names are passed as plain strings from a fixed internal call
   * set (never user input), so `sql.raw` on the identifier is safe here
   * — the same posture every other report service's raw-SQL helpers
   * already take with their own fixed table names. */
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
      WHERE ln.tenant_id = ${tenantId}
        AND doc.tenant_id = ${tenantId}
        AND doc.legal_entity_id = ${legalEntityId}
        AND doc.status = 'POSTED'
        AND doc.${sql.raw(dateColumn)} >= ${dateFrom}::date
        AND doc.${sql.raw(dateColumn)} <= ${dateTo}::date
        AND ln.tax_code_id IS NOT NULL
      GROUP BY tc.id, tc.code, tc.name, tc.treatment
    `)) as unknown as RawCodeRow[];
    return rows;
  }

  /** Total tax (classified + unclassified) for one line table, same
   * POSTED/date-window scoping as `codeRows` but with no `tax_code_id`
   * filter — the always-correct headline figure `codeRows`'s
   * classified breakdown is reconciled against (discovery §7). */
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
      WHERE ln.tenant_id = ${tenantId}
        AND doc.tenant_id = ${tenantId}
        AND doc.legal_entity_id = ${legalEntityId}
        AND doc.status = 'POSTED'
        AND doc.${sql.raw(dateColumn)} >= ${dateFrom}::date
        AND doc.${sql.raw(dateColumn)} <= ${dateTo}::date
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
        });
      }
    }
    return Array.from(byCode.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }

  /** Optional GL cross-check (discovery §6.3/§6.4) — a coarse,
   * period-movement sanity check against the two singleton tax
   * accounts, NOT a source of per-tax-code data (journal_lines has no
   * tax_code_id at all — discovery §3.2). Polarity confirmed by direct
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

    return {
      taxOutputAccountId,
      glOutputTaxMovementMinor,
      outputDifferenceMinor,
      outputReconciled: outputDifferenceMinor === 0,
      taxInputAccountId,
      glInputTaxMovementMinor,
      inputDifferenceMinor,
      inputReconciled: inputDifferenceMinor === 0,
    };
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
}
