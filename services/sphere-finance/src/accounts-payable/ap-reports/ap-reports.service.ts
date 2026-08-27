import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, legalEntities, lte, sql } from "@noryx/db-core";
import {
  apSettings,
  suppliers,
  supplierBills,
  supplierPayments,
  supplierPaymentAllocations,
  supplierDebitNotes,
  supplierDebitNoteAllocations,
  type ApSettings,
  type Supplier,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import { REPORT_TX_CONFIG } from "../../general-ledger/general-ledger.service";
import type { SupplierBalanceQueryDto } from "./dto/supplier-balance-query.dto";
import type { SupplierStatementQueryDto } from "./dto/supplier-statement-query.dto";
import type { ApAgeingQueryDto } from "./dto/ap-ageing-query.dto";
import type { ApReconciliationQueryDto } from "./dto/ap-reconciliation-query.dto";

export interface SupplierBalanceResult {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  legalEntityId: string;
  asOfDate: string;
  totalBilledMinor: number;
  totalPaidMinor: number;
  totalOutstandingMinor: number;
  currencyCode: string;
}

export interface StatementAllocation {
  billId: string;
  billReference: string | null;
  allocatedAmountMinor: number;
}

export interface StatementLine {
  type: "BILL" | "PAYMENT" | "DEBIT_NOTE";
  date: string;
  reference: string | null;
  description: string | null;
  amountMinor: number;
  runningBalanceMinor: number;
  billId?: string;
  paymentId?: string;
  debitNoteId?: string;
  allocations?: StatementAllocation[];
}

export interface SupplierStatementMeta {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  legalEntityId: string;
  dateFrom: string | null;
  dateTo: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  currencyCode: string;
}

export interface SupplierStatementResult {
  rows: StatementLine[];
  meta: SupplierStatementMeta;
}

type AgeingBucket =
  "current" | "d1to30" | "d31to60" | "d61to90" | "d91to120" | "d120plus";

export interface SupplierAgeingRow {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  currentMinor: number;
  days1to30Minor: number;
  days31to60Minor: number;
  days61to90Minor: number;
  days91to120Minor: number;
  days120PlusMinor: number;
  totalOutstandingMinor: number;
}

export interface ApAgeingMeta {
  asOf: string;
  legalEntityId: string;
  supplierId: string | null;
  supplierCount: number;
  totalCurrentMinor: number;
  total1to30Minor: number;
  total31to60Minor: number;
  total61to90Minor: number;
  total91to120Minor: number;
  total120PlusMinor: number;
  totalOutstandingMinor: number;
}

export interface ApAgeingResult {
  rows: SupplierAgeingRow[];
  meta: ApAgeingMeta;
}

export interface ApReconciliationResult {
  asOf: string;
  legalEntityId: string;
  apControlAccountId: string;
  subLedgerTotalOutstandingMinor: number;
  glApControlAccountBalanceMinor: number;
  differenceMinor: number;
  reconciled: boolean;
}

interface Totals {
  totalBilledMinor: number;
  totalPaidMinor: number;
}

/**
 * AP-1d — Supplier Balance, Supplier Statement, AP Ageing, AP/GL
 * Reconciliation. docs/finance-work-item-1d-supplier-balance-statement-
 * ageing-proposal.md.
 *
 * Read-only, full stop: no INSERT/UPDATE/DELETE anywhere in this file, no
 * audit-log writes (reads are never audited anywhere in this codebase,
 * same convention general-ledger.service.ts documents for its own read
 * layer), no `SELECT ... FOR UPDATE`. Every method runs inside
 * `withTenant(tenantId, ...)` with `REPORT_TX_CONFIG` (REPEATABLE READ +
 * READ ONLY, imported directly from general-ledger.service.ts rather than
 * duplicated — it is already exported specifically for cross-file reuse,
 * see test/general-ledger-concurrency.e2e-spec.ts's own import of it) —
 * every multi-statement report here needs the same one-snapshot guarantee
 * GL's read layer already established (§8 of the proposal).
 *
 * No new tables, no new migration (proposal §3) — every number here is
 * derived from supplier_bills/supplier_payments/supplier_payment_
 * allocations/journal_lines, all already written correctly by AP-1a/1b/1c.
 *
 * Extended by the Credit/Debit Notes work item
 * (docs/finance-work-item-credit-debit-notes-proposal.md §9a,
 * CTO-approved): `asOfTotals()` additionally unions in
 * `supplier_debit_note_allocations`/`supplier_debit_notes` (§9a.1), and
 * `getSupplierStatement()` additionally emits `DEBIT_NOTE` rows (§9a.2).
 * `currentTotals()`/`getApAgeing()`/`getApReconciliation()`'s
 * current-mode path are deliberately untouched — see §9a.3.
 */
@Injectable()
export class ApReportsService {
  async getSupplierBalance(
    tenantId: string,
    legalEntityId: string,
    supplierId: string,
    query: SupplierBalanceQueryDto,
  ): Promise<SupplierBalanceResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const supplier = await this.resolveSupplier(
          tx,
          tenantId,
          legalEntityId,
          supplierId,
        );
        const currencyCode = await this.resolveCurrency(
          tx,
          tenantId,
          legalEntityId,
        );
        const asOfDate = query.asOf ?? this.todayUtc();

        const totals = query.asOf
          ? await this.asOfTotals(
              tx,
              tenantId,
              legalEntityId,
              supplierId,
              asOfDate,
            )
          : await this.currentTotals(tx, tenantId, legalEntityId, supplierId);

        return {
          supplierId: supplier.id,
          supplierCode: supplier.code,
          supplierName: supplier.name,
          legalEntityId,
          asOfDate,
          totalBilledMinor: totals.totalBilledMinor,
          totalPaidMinor: totals.totalPaidMinor,
          totalOutstandingMinor:
            totals.totalBilledMinor - totals.totalPaidMinor,
          currencyCode,
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getSupplierStatement(
    tenantId: string,
    legalEntityId: string,
    supplierId: string,
    query: SupplierStatementQueryDto,
  ): Promise<SupplierStatementResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const supplier = await this.resolveSupplier(
          tx,
          tenantId,
          legalEntityId,
          supplierId,
        );
        const currencyCode = await this.resolveCurrency(
          tx,
          tenantId,
          legalEntityId,
        );
        const dateFrom = query.dateFrom ?? null;
        const dateTo = query.dateTo ?? this.todayUtc();

        const opening = dateFrom
          ? await this.asOfTotals(
              tx,
              tenantId,
              legalEntityId,
              supplierId,
              dateFrom,
              true,
            )
          : { totalBilledMinor: 0, totalPaidMinor: 0 };
        const openingBalanceMinor =
          opening.totalBilledMinor - opening.totalPaidMinor;

        const billConditions = [
          eq(supplierBills.tenantId, tenantId),
          eq(supplierBills.legalEntityId, legalEntityId),
          eq(supplierBills.supplierId, supplierId),
          eq(supplierBills.status, "POSTED"),
          lte(supplierBills.billDate, dateTo),
        ];
        if (dateFrom)
          billConditions.push(gte(supplierBills.billDate, dateFrom));
        const bills = await tx
          .select()
          .from(supplierBills)
          .where(and(...billConditions));

        const paymentConditions = [
          eq(supplierPayments.tenantId, tenantId),
          eq(supplierPayments.legalEntityId, legalEntityId),
          eq(supplierPayments.supplierId, supplierId),
          eq(supplierPayments.status, "POSTED"),
          lte(supplierPayments.paymentDate, dateTo),
        ];
        if (dateFrom) {
          paymentConditions.push(gte(supplierPayments.paymentDate, dateFrom));
        }
        const payments = await tx
          .select()
          .from(supplierPayments)
          .where(and(...paymentConditions));

        const paymentIds = payments.map((p) => p.id);
        const allocationRows =
          paymentIds.length > 0
            ? await tx
                .select({
                  paymentId: supplierPaymentAllocations.paymentId,
                  billId: supplierPaymentAllocations.billId,
                  allocatedAmountMinor:
                    supplierPaymentAllocations.allocatedAmountMinor,
                  billReference: supplierBills.internalReference,
                })
                .from(supplierPaymentAllocations)
                .innerJoin(
                  supplierBills,
                  eq(supplierBills.id, supplierPaymentAllocations.billId),
                )
                .where(
                  inArray(supplierPaymentAllocations.paymentId, paymentIds),
                )
            : [];
        const allocationsByPayment = new Map<string, StatementAllocation[]>();
        for (const a of allocationRows) {
          const list = allocationsByPayment.get(a.paymentId) ?? [];
          list.push({
            billId: a.billId,
            billReference: a.billReference,
            allocatedAmountMinor: a.allocatedAmountMinor,
          });
          allocationsByPayment.set(a.paymentId, list);
        }

        // §9a.2 (Credit/Debit Notes work item, CTO-approved) — structured
        // identically to the PAYMENT block above: POSTED debit notes for
        // this supplier dated within [dateFrom, dateTo], plus their
        // allocations for the `allocations: StatementAllocation[]` field,
        // reusing that existing interface unchanged.
        const debitNoteConditions = [
          eq(supplierDebitNotes.tenantId, tenantId),
          eq(supplierDebitNotes.legalEntityId, legalEntityId),
          eq(supplierDebitNotes.supplierId, supplierId),
          eq(supplierDebitNotes.status, "POSTED"),
          lte(supplierDebitNotes.debitNoteDate, dateTo),
        ];
        if (dateFrom) {
          debitNoteConditions.push(
            gte(supplierDebitNotes.debitNoteDate, dateFrom),
          );
        }
        const debitNotes = await tx
          .select()
          .from(supplierDebitNotes)
          .where(and(...debitNoteConditions));

        const debitNoteIds = debitNotes.map((d) => d.id);
        const debitNoteAllocationRows =
          debitNoteIds.length > 0
            ? await tx
                .select({
                  debitNoteId: supplierDebitNoteAllocations.debitNoteId,
                  billId: supplierDebitNoteAllocations.billId,
                  allocatedAmountMinor:
                    supplierDebitNoteAllocations.allocatedAmountMinor,
                  billReference: supplierBills.internalReference,
                })
                .from(supplierDebitNoteAllocations)
                .innerJoin(
                  supplierBills,
                  eq(supplierBills.id, supplierDebitNoteAllocations.billId),
                )
                .where(
                  inArray(
                    supplierDebitNoteAllocations.debitNoteId,
                    debitNoteIds,
                  ),
                )
            : [];
        const allocationsByDebitNote = new Map<string, StatementAllocation[]>();
        for (const a of debitNoteAllocationRows) {
          const list = allocationsByDebitNote.get(a.debitNoteId) ?? [];
          list.push({
            billId: a.billId,
            billReference: a.billReference,
            allocatedAmountMinor: a.allocatedAmountMinor,
          });
          allocationsByDebitNote.set(a.debitNoteId, list);
        }

        interface Unsorted {
          sortDate: string;
          sortRef: string;
          line: Omit<StatementLine, "runningBalanceMinor">;
        }
        const unsorted: Unsorted[] = [];
        for (const b of bills) {
          unsorted.push({
            sortDate: b.billDate,
            sortRef: b.internalReference ?? "",
            line: {
              type: "BILL",
              date: b.billDate,
              reference: b.internalReference,
              description: `Bill ${b.supplierBillNumber}`,
              amountMinor: b.totalMinor,
              billId: b.id,
            },
          });
        }
        for (const p of payments) {
          unsorted.push({
            sortDate: p.paymentDate,
            sortRef: p.internalReference ?? "",
            line: {
              type: "PAYMENT",
              date: p.paymentDate,
              reference: p.internalReference,
              description: p.reference ?? "Payment",
              amountMinor: -p.paymentAmountMinor,
              paymentId: p.id,
              allocations: allocationsByPayment.get(p.id) ?? [],
            },
          });
        }
        for (const dn of debitNotes) {
          unsorted.push({
            sortDate: dn.debitNoteDate,
            sortRef: dn.internalReference ?? "",
            line: {
              type: "DEBIT_NOTE",
              date: dn.debitNoteDate,
              reference: dn.internalReference,
              // §9a.2: prefer the debit note's own `reason` field,
              // falling back to a generic label — mirroring PAYMENT's
              // `reference ?? "Payment"` fallback chain.
              description: dn.reason ?? "Debit note",
              // Signed the same direction as a payment (negative — it
              // reduces the supplier's balance). A POSTED debit note is
              // always fully allocated by invariant (proposal §9,
              // full-allocation-required-to-post), so -totalMinor always
              // equals -SUM(this debit note's own allocations).
              amountMinor: -dn.totalMinor,
              debitNoteId: dn.id,
              allocations: allocationsByDebitNote.get(dn.id) ?? [],
            },
          });
        }
        // Chronological order, tie-broken by internalReference — BILL-/
        // PAY-/DBN- prefixes never collide, and each is zero-padded/
        // fixed-width within its own series (AP-1b/1c/Credit-Debit-Notes'
        // numbering convention), so lexicographic order matches numeric
        // order — the identical reasoning general-ledger.service.ts's doc
        // comment gives for sorting journal_number as a string (proposal
        // §6.2).
        unsorted.sort((a, b) => {
          if (a.sortDate !== b.sortDate)
            return a.sortDate < b.sortDate ? -1 : 1;
          if (a.sortRef < b.sortRef) return -1;
          if (a.sortRef > b.sortRef) return 1;
          return 0;
        });

        let running = openingBalanceMinor;
        const rows: StatementLine[] = unsorted.map(({ line }) => {
          running += line.amountMinor;
          return { ...line, runningBalanceMinor: running };
        });
        const closingBalanceMinor = running;

        return {
          rows,
          meta: {
            supplierId: supplier.id,
            supplierCode: supplier.code,
            supplierName: supplier.name,
            legalEntityId,
            dateFrom,
            dateTo,
            openingBalanceMinor,
            closingBalanceMinor,
            currencyCode,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getApAgeing(
    tenantId: string,
    legalEntityId: string,
    query: ApAgeingQueryDto,
  ): Promise<ApAgeingResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();

        const conditions = [
          eq(supplierBills.tenantId, tenantId),
          eq(supplierBills.legalEntityId, legalEntityId),
          eq(supplierBills.status, "POSTED"),
        ];
        if (query.supplierId) {
          conditions.push(eq(supplierBills.supplierId, query.supplierId));
        }

        const openBills = await tx
          .select({
            supplierId: supplierBills.supplierId,
            supplierCode: suppliers.code,
            supplierName: suppliers.name,
            dueDate: supplierBills.dueDate,
            totalMinor: supplierBills.totalMinor,
            paidMinor: supplierBills.paidMinor,
          })
          .from(supplierBills)
          .innerJoin(suppliers, eq(suppliers.id, supplierBills.supplierId))
          .where(and(...conditions));

        const bySupplier = new Map<
          string,
          { code: string; name: string; buckets: Record<AgeingBucket, number> }
        >();
        for (const bill of openBills) {
          // Only POSTED bills are queried at all (DRAFT is structurally
          // excluded above); a fully-settled bill (outstanding <= 0) is
          // skipped entirely rather than appearing in every bucket at zero
          // — proposal §6.3.
          const outstanding = bill.totalMinor - bill.paidMinor;
          if (outstanding <= 0) continue;

          const bucket = this.bucketFor(bill.dueDate, asOf);
          const entry = bySupplier.get(bill.supplierId) ?? {
            code: bill.supplierCode,
            name: bill.supplierName,
            buckets: {
              current: 0,
              d1to30: 0,
              d31to60: 0,
              d61to90: 0,
              d91to120: 0,
              d120plus: 0,
            },
          };
          entry.buckets[bucket] += outstanding;
          bySupplier.set(bill.supplierId, entry);
        }

        const rows: SupplierAgeingRow[] = [];
        const totals: Record<AgeingBucket, number> = {
          current: 0,
          d1to30: 0,
          d31to60: 0,
          d61to90: 0,
          d91to120: 0,
          d120plus: 0,
        };
        for (const [supplierId, entry] of bySupplier) {
          const b = entry.buckets;
          const totalOutstandingMinor =
            b.current +
            b.d1to30 +
            b.d31to60 +
            b.d61to90 +
            b.d91to120 +
            b.d120plus;
          rows.push({
            supplierId,
            supplierCode: entry.code,
            supplierName: entry.name,
            currentMinor: b.current,
            days1to30Minor: b.d1to30,
            days31to60Minor: b.d31to60,
            days61to90Minor: b.d61to90,
            days91to120Minor: b.d91to120,
            days120PlusMinor: b.d120plus,
            totalOutstandingMinor,
          });
          totals.current += b.current;
          totals.d1to30 += b.d1to30;
          totals.d31to60 += b.d31to60;
          totals.d61to90 += b.d61to90;
          totals.d91to120 += b.d91to120;
          totals.d120plus += b.d120plus;
        }
        rows.sort((a, b) => a.supplierCode.localeCompare(b.supplierCode));

        const totalOutstandingMinor =
          totals.current +
          totals.d1to30 +
          totals.d31to60 +
          totals.d61to90 +
          totals.d91to120 +
          totals.d120plus;

        return {
          rows,
          meta: {
            asOf,
            legalEntityId,
            supplierId: query.supplierId ?? null,
            supplierCount: rows.length,
            totalCurrentMinor: totals.current,
            total1to30Minor: totals.d1to30,
            total31to60Minor: totals.d31to60,
            total61to90Minor: totals.d61to90,
            total91to120Minor: totals.d91to120,
            total120PlusMinor: totals.d120plus,
            totalOutstandingMinor,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getApReconciliation(
    tenantId: string,
    legalEntityId: string,
    query: ApReconciliationQueryDto,
  ): Promise<ApReconciliationResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();
        const settings = await this.loadApSettingsOrThrow(
          tx,
          tenantId,
          legalEntityId,
        );

        const subLedger = query.asOf
          ? await this.asOfTotals(tx, tenantId, legalEntityId, null, asOf)
          : await this.currentTotals(tx, tenantId, legalEntityId, null);
        const subLedgerTotalOutstandingMinor =
          subLedger.totalBilledMinor - subLedger.totalPaidMinor;

        const glApControlAccountBalanceMinor = await this.glLiabilityBalance(
          tx,
          tenantId,
          legalEntityId,
          settings.apControlAccountId,
          asOf,
        );

        const differenceMinor =
          subLedgerTotalOutstandingMinor - glApControlAccountBalanceMinor;

        return {
          asOf,
          legalEntityId,
          apControlAccountId: settings.apControlAccountId,
          subLedgerTotalOutstandingMinor,
          glApControlAccountBalanceMinor,
          differenceMinor,
          reconciled: differenceMinor === 0,
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /** Scoped by (id, tenantId, legalEntityId), same as every other Finance
   * resource lookup. Deliberately never filters on isActive — a
   * deactivated supplier's historical balance/statement remains fully
   * readable, mirroring GeneralLedgerService.resolveAccount's identical
   * posture for archived accounts. */
  private async resolveSupplier(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    supplierId: string,
  ): Promise<Supplier> {
    const [supplier] = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.tenantId, tenantId),
          eq(suppliers.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!supplier) {
      throw new NotFoundException(`No supplier found with id ${supplierId}.`);
    }
    return supplier;
  }

  /** Loads ap_settings for this legal entity — a report can't identify
   * the AP control account without it. 404, not 422: unlike posting-time
   * re-validation (SupplierPaymentsService.loadApSettingsOrThrow), this is
   * a read precondition, same posture as ApSettingsService.findOne. */
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
      throw new NotFoundException(
        "AP settings have not been configured for this legal entity.",
      );
    }
    return rows[0]!;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * SupplierPaymentsService.resolveCurrency, duplicated locally. */
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

  /** Current-mode totals (proposal §6.1) — summed directly from
   * supplier_bills' own stored total_minor/paid_minor for POSTED bills.
   * `supplierId: null` aggregates across the whole legal entity (used by
   * AP/GL reconciliation, proposal §6.4). */
  private async currentTotals(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    supplierId: string | null,
  ): Promise<Totals> {
    const supplierFilter = supplierId
      ? sql`AND supplier_id = ${supplierId}`
      : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(total_minor), 0) AS total_billed,
        COALESCE(SUM(paid_minor), 0) AS total_paid
      FROM supplier_bills
      WHERE tenant_id = ${tenantId}
        AND legal_entity_id = ${legalEntityId}
        AND status = 'POSTED'
        ${supplierFilter}
    `)) as unknown as Array<{ total_billed: unknown; total_paid: unknown }>;
    return {
      totalBilledMinor: this.toNumber(rows[0]?.total_billed),
      totalPaidMinor: this.toNumber(rows[0]?.total_paid),
    };
  }

  /** As-of-mode totals (proposal §6.1/§6.2/§6.4) — a historical
   * reconstruction using bill_date/payment_date instead of today's stored
   * paid_minor: a bill counts toward totalBilled only if its bill_date
   * qualifies against `cutoffDate`, and a payment allocation counts
   * toward totalPaid only if BOTH its payment's payment_date AND its
   * bill's bill_date qualify. `strict: false` (default) uses `<=`
   * (Balance/Reconciliation's as-of semantics — "as of this date"
   * includes that date); `strict: true` uses `<` (Statement's opening-
   * balance semantics — strictly before the window starts, the same
   * convention GeneralLedgerService.getLedger uses for its own opening
   * balance). `supplierId: null` aggregates across the whole legal entity
   * (reconciliation's as-of mode).
   *
   * §9a.1 (Credit/Debit Notes work item, CTO-approved) — `totalPaid` is
   * now the SUM of two unioned subqueries: the pre-existing payment-
   * allocation subquery above, plus a second subquery over
   * `supplier_debit_note_allocations` joined to `supplier_debit_notes`/
   * `supplier_bills`, applying the identical predicate shape (the debit
   * note's own `status = 'POSTED'` and `debit_note_date` qualifying
   * against `cutoffDate` under the same `cmp`/`strict` flag, plus the
   * same tenant/legal-entity/optional-supplier filters). This is
   * additive only — the payment subquery itself is untouched. */
  private async asOfTotals(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    supplierId: string | null,
    cutoffDate: string,
    strict: boolean = false,
  ): Promise<Totals> {
    const cmp = strict ? sql`<` : sql`<=`;
    const billSupplierFilter = supplierId
      ? sql`AND b.supplier_id = ${supplierId}`
      : sql``;
    const paymentSupplierFilter = supplierId
      ? sql`AND sp.supplier_id = ${supplierId}`
      : sql``;
    // §9a.1 (Credit/Debit Notes work item, CTO-approved) — same optional
    // supplier filter, applied to the debit note itself rather than the
    // bill it's allocated against, identical shape to
    // paymentSupplierFilter above.
    const debitNoteSupplierFilter = supplierId
      ? sql`AND sdn.supplier_id = ${supplierId}`
      : sql``;

    const rows = (await tx.execute(sql`
      SELECT
        COALESCE((
          SELECT SUM(b.total_minor)
          FROM supplier_bills b
          WHERE b.tenant_id = ${tenantId}
            AND b.legal_entity_id = ${legalEntityId}
            AND b.status = 'POSTED'
            AND b.bill_date ${cmp} ${cutoffDate}::date
            ${billSupplierFilter}
        ), 0) AS total_billed,
        COALESCE((
          SELECT SUM(spa.allocated_amount_minor)
          FROM supplier_payment_allocations spa
          INNER JOIN supplier_payments sp ON sp.id = spa.payment_id
          INNER JOIN supplier_bills b2 ON b2.id = spa.bill_id
          WHERE spa.tenant_id = ${tenantId}
            AND sp.tenant_id = ${tenantId}
            AND sp.legal_entity_id = ${legalEntityId}
            AND sp.status = 'POSTED'
            AND sp.payment_date ${cmp} ${cutoffDate}::date
            AND b2.tenant_id = ${tenantId}
            AND b2.legal_entity_id = ${legalEntityId}
            AND b2.status = 'POSTED'
            AND b2.bill_date ${cmp} ${cutoffDate}::date
            ${paymentSupplierFilter}
        ), 0)
        +
        COALESCE((
          SELECT SUM(sdna.allocated_amount_minor)
          FROM supplier_debit_note_allocations sdna
          INNER JOIN supplier_debit_notes sdn ON sdn.id = sdna.debit_note_id
          INNER JOIN supplier_bills b3 ON b3.id = sdna.bill_id
          WHERE sdna.tenant_id = ${tenantId}
            AND sdn.tenant_id = ${tenantId}
            AND sdn.legal_entity_id = ${legalEntityId}
            AND sdn.status = 'POSTED'
            AND sdn.debit_note_date ${cmp} ${cutoffDate}::date
            AND b3.tenant_id = ${tenantId}
            AND b3.legal_entity_id = ${legalEntityId}
            AND b3.status = 'POSTED'
            AND b3.bill_date ${cmp} ${cutoffDate}::date
            ${debitNoteSupplierFilter}
        ), 0) AS total_paid
    `)) as unknown as Array<{ total_billed: unknown; total_paid: unknown }>;
    return {
      totalBilledMinor: this.toNumber(rows[0]?.total_billed),
      totalPaidMinor: this.toNumber(rows[0]?.total_paid),
    };
  }

  /** The GL side of the reconciliation invariant (proposal §6.4) — the AP
   * control account's own closing balance, computed the same way
   * GeneralLedgerService.getBalance computes any liability account's
   * balance: credit-normal sign, SUM(credit) - SUM(debit) over every
   * POSTED journal_lines row for that account up to `asOf`. Written
   * locally (not imported from GeneralLedgerService, whose balance method
   * isn't exported as a standalone helper) but the identical query shape
   * and sign convention that file already documents — same tables, same
   * status = 'POSTED' filter, no second accounting mechanism invented. */
  private async glLiabilityBalance(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    asOf: string,
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
        AND je.transaction_date <= ${asOf}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    // AP control account is always LIABILITY (validated at
    // ApSettingsService.upsert time) — credit-normal.
    return rawCredit - rawDebit;
  }

  /** Bucket assignment for AP Ageing (proposal §6.3) — asOf only changes
   * which bucket a bill's due_date falls into, never the outstanding
   * amount itself. A null due_date (schema allows it — AP-1b never
   * requires one) is bucketed as "current": with no due date there is no
   * defensible overdue determination to make. */
  private bucketFor(dueDate: string | null, asOf: string): AgeingBucket {
    if (!dueDate) return "current";
    const dueMs = new Date(`${dueDate}T00:00:00Z`).getTime();
    const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
    const daysPastDue = Math.floor((asOfMs - dueMs) / 86_400_000);
    if (daysPastDue <= 0) return "current";
    if (daysPastDue <= 30) return "d1to30";
    if (daysPastDue <= 60) return "d31to60";
    if (daysPastDue <= 90) return "d61to90";
    if (daysPastDue <= 120) return "d91to120";
    return "d120plus";
  }

  /** §4.8-equivalent deterministic "today": current UTC calendar date,
   * computed once in application code — never SQL CURRENT_DATE/NOW() —
   * the same expression general-ledger.service.ts uses. */
  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }
}
