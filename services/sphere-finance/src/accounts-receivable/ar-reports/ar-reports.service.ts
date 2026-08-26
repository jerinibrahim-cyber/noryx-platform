import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, legalEntities, lte, sql } from "@noryx/db-core";
import {
  arSettings,
  customers,
  customerInvoices,
  customerReceipts,
  customerReceiptAllocations,
  type ArSettings,
  type Customer,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import { REPORT_TX_CONFIG } from "../../general-ledger/general-ledger.service";
import type { CustomerBalanceQueryDto } from "./dto/customer-balance-query.dto";
import type { CustomerStatementQueryDto } from "./dto/customer-statement-query.dto";
import type { ArAgeingQueryDto } from "./dto/ar-ageing-query.dto";
import type { ArReconciliationQueryDto } from "./dto/ar-reconciliation-query.dto";

export interface CustomerBalanceResult {
  customerId: string;
  customerCode: string;
  customerName: string;
  legalEntityId: string;
  asOfDate: string;
  totalInvoicedMinor: number;
  totalReceivedMinor: number;
  totalOutstandingMinor: number;
  currencyCode: string;
}

export interface StatementAllocation {
  invoiceId: string;
  invoiceReference: string | null;
  allocatedAmountMinor: number;
}

export interface StatementLine {
  type: "INVOICE" | "RECEIPT";
  date: string;
  reference: string | null;
  description: string | null;
  amountMinor: number;
  runningBalanceMinor: number;
  invoiceId?: string;
  receiptId?: string;
  allocations?: StatementAllocation[];
}

export interface CustomerStatementMeta {
  customerId: string;
  customerCode: string;
  customerName: string;
  legalEntityId: string;
  dateFrom: string | null;
  dateTo: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  currencyCode: string;
}

export interface CustomerStatementResult {
  rows: StatementLine[];
  meta: CustomerStatementMeta;
}

type AgeingBucket =
  "current" | "d1to30" | "d31to60" | "d61to90" | "d91to120" | "d120plus";

export interface CustomerAgeingRow {
  customerId: string;
  customerCode: string;
  customerName: string;
  currentMinor: number;
  days1to30Minor: number;
  days31to60Minor: number;
  days61to90Minor: number;
  days91to120Minor: number;
  days120PlusMinor: number;
  totalOutstandingMinor: number;
}

export interface ArAgeingMeta {
  asOf: string;
  legalEntityId: string;
  customerId: string | null;
  customerCount: number;
  totalCurrentMinor: number;
  total1to30Minor: number;
  total31to60Minor: number;
  total61to90Minor: number;
  total91to120Minor: number;
  total120PlusMinor: number;
  totalOutstandingMinor: number;
}

export interface ArAgeingResult {
  rows: CustomerAgeingRow[];
  meta: ArAgeingMeta;
}

export interface ArReconciliationResult {
  asOf: string;
  legalEntityId: string;
  arControlAccountId: string;
  subLedgerTotalOutstandingMinor: number;
  glArControlAccountBalanceMinor: number;
  differenceMinor: number;
  reconciled: boolean;
}

interface Totals {
  totalInvoicedMinor: number;
  totalReceivedMinor: number;
}

/**
 * AR-1d — Customer Balance, Customer Statement, AR Ageing, AR/GL
 * Reconciliation. docs/finance-work-item-1d-ar-reports-proposal.md.
 * Mirrors ap-reports.service.ts's structure/conventions exactly, with
 * every query rewritten against AR's own tables and — critically — the
 * AR control account's flipped, DEBIT-normal (ASSET) sign convention
 * (§9.2; see `glAssetBalance` below, the one place this file cannot
 * mirror AP-1d verbatim).
 *
 * Read-only, full stop: no INSERT/UPDATE/DELETE anywhere in this file,
 * no audit-log writes (reads are never audited anywhere in this
 * codebase), no `SELECT ... FOR UPDATE`. Every method runs inside
 * `withTenant(tenantId, ...)` with `REPORT_TX_CONFIG` (REPEATABLE READ +
 * READ ONLY, imported directly from general-ledger.service.ts rather
 * than duplicated) — every multi-statement report here needs the same
 * one-snapshot guarantee GL's/AP-1d's read layer already established.
 *
 * No new tables, no new migration (proposal §12) — every number here is
 * derived from customers/ar_settings/customer_invoices/
 * customer_receipts/customer_receipt_allocations/journal_lines, all
 * already written correctly by AR-1a/1b/1c.
 *
 * Reconciliation mode dispatch (current vs. as-of) is on parameter
 * presence alone, NEVER a comparison of `asOf` against today (§9.1's
 * CTO correction) — see `getArReconciliation`/`getCustomerBalance`
 * below, both of which use `query.asOf ? asOfTotals(...) :
 * currentTotals(...)`, exactly AP-1d's own dispatch shape.
 */
@Injectable()
export class ArReportsService {
  async getCustomerBalance(
    tenantId: string,
    legalEntityId: string,
    customerId: string,
    query: CustomerBalanceQueryDto,
  ): Promise<CustomerBalanceResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const customer = await this.resolveCustomer(
          tx,
          tenantId,
          legalEntityId,
          customerId,
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
              customerId,
              asOfDate,
            )
          : await this.currentTotals(tx, tenantId, legalEntityId, customerId);

        return {
          customerId: customer.id,
          customerCode: customer.code,
          customerName: customer.name,
          legalEntityId,
          asOfDate,
          totalInvoicedMinor: totals.totalInvoicedMinor,
          totalReceivedMinor: totals.totalReceivedMinor,
          totalOutstandingMinor:
            totals.totalInvoicedMinor - totals.totalReceivedMinor,
          currencyCode,
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getCustomerStatement(
    tenantId: string,
    legalEntityId: string,
    customerId: string,
    query: CustomerStatementQueryDto,
  ): Promise<CustomerStatementResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const customer = await this.resolveCustomer(
          tx,
          tenantId,
          legalEntityId,
          customerId,
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
              customerId,
              dateFrom,
              true,
            )
          : { totalInvoicedMinor: 0, totalReceivedMinor: 0 };
        const openingBalanceMinor =
          opening.totalInvoicedMinor - opening.totalReceivedMinor;

        const invoiceConditions = [
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.legalEntityId, legalEntityId),
          eq(customerInvoices.customerId, customerId),
          eq(customerInvoices.status, "POSTED"),
          lte(customerInvoices.invoiceDate, dateTo),
        ];
        if (dateFrom)
          invoiceConditions.push(gte(customerInvoices.invoiceDate, dateFrom));
        const invoices = await tx
          .select()
          .from(customerInvoices)
          .where(and(...invoiceConditions));

        const receiptConditions = [
          eq(customerReceipts.tenantId, tenantId),
          eq(customerReceipts.legalEntityId, legalEntityId),
          eq(customerReceipts.customerId, customerId),
          eq(customerReceipts.status, "POSTED"),
          lte(customerReceipts.receiptDate, dateTo),
        ];
        if (dateFrom) {
          receiptConditions.push(gte(customerReceipts.receiptDate, dateFrom));
        }
        const receipts = await tx
          .select()
          .from(customerReceipts)
          .where(and(...receiptConditions));

        const receiptIds = receipts.map((r) => r.id);
        const allocationRows =
          receiptIds.length > 0
            ? await tx
                .select({
                  receiptId: customerReceiptAllocations.receiptId,
                  invoiceId: customerReceiptAllocations.invoiceId,
                  allocatedAmountMinor:
                    customerReceiptAllocations.allocatedAmountMinor,
                  invoiceReference: customerInvoices.internalReference,
                })
                .from(customerReceiptAllocations)
                .innerJoin(
                  customerInvoices,
                  eq(customerInvoices.id, customerReceiptAllocations.invoiceId),
                )
                .where(
                  inArray(customerReceiptAllocations.receiptId, receiptIds),
                )
            : [];
        const allocationsByReceipt = new Map<string, StatementAllocation[]>();
        for (const a of allocationRows) {
          const list = allocationsByReceipt.get(a.receiptId) ?? [];
          list.push({
            invoiceId: a.invoiceId,
            invoiceReference: a.invoiceReference,
            allocatedAmountMinor: a.allocatedAmountMinor,
          });
          allocationsByReceipt.set(a.receiptId, list);
        }

        interface Unsorted {
          sortDate: string;
          sortRef: string;
          line: Omit<StatementLine, "runningBalanceMinor">;
        }
        const unsorted: Unsorted[] = [];
        for (const inv of invoices) {
          unsorted.push({
            sortDate: inv.invoiceDate,
            sortRef: inv.internalReference ?? "",
            line: {
              type: "INVOICE",
              date: inv.invoiceDate,
              reference: inv.internalReference,
              // AR-specific adaptation (proposal §7, §14 decision 1):
              // customer_invoices has no external-number field
              // analogous to supplierBillNumber, so a memo fallback is
              // used instead of AP-1d's `Bill ${supplierBillNumber}`.
              description: inv.memo ?? "Invoice",
              amountMinor: inv.totalMinor,
              invoiceId: inv.id,
            },
          });
        }
        for (const rec of receipts) {
          unsorted.push({
            sortDate: rec.receiptDate,
            sortRef: rec.internalReference ?? "",
            line: {
              type: "RECEIPT",
              date: rec.receiptDate,
              reference: rec.internalReference,
              // §14 decision 1: prefer the human-written memo, then the
              // free-text external reference, then a generic label —
              // both memo and reference exist on customer_receipts,
              // unlike AP-1d's PAYMENT row (`p.reference ?? "Payment"`).
              description: rec.memo ?? rec.reference ?? "Receipt",
              // Correct because a POSTED AR-1c receipt is always fully
              // allocated by invariant (proposal §7's secondary
              // clarification, CTO-required) — no "receipt on account"
              // exists today, so -receiptAmountMinor always equals
              // -SUM(this receipt's own allocations).
              amountMinor: -rec.receiptAmountMinor,
              receiptId: rec.id,
              allocations: allocationsByReceipt.get(rec.id) ?? [],
            },
          });
        }
        // Chronological order, tie-broken by internalReference — INV-/
        // RCT- prefixes never collide, and each is zero-padded/
        // fixed-width within its own series (AR-1b/1c's numbering
        // convention), so lexicographic order matches numeric order —
        // the identical reasoning AP-1d's own statement uses for its
        // BILL-/PAY- sort (proposal §7).
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
            customerId: customer.id,
            customerCode: customer.code,
            customerName: customer.name,
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

  async getArAgeing(
    tenantId: string,
    legalEntityId: string,
    query: ArAgeingQueryDto,
  ): Promise<ArAgeingResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();

        const conditions = [
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.legalEntityId, legalEntityId),
          eq(customerInvoices.status, "POSTED"),
        ];
        if (query.customerId) {
          conditions.push(eq(customerInvoices.customerId, query.customerId));
        }

        const openInvoices = await tx
          .select({
            customerId: customerInvoices.customerId,
            customerCode: customers.code,
            customerName: customers.name,
            dueDate: customerInvoices.dueDate,
            totalMinor: customerInvoices.totalMinor,
            paidMinor: customerInvoices.paidMinor,
          })
          .from(customerInvoices)
          .innerJoin(customers, eq(customers.id, customerInvoices.customerId))
          .where(and(...conditions));

        const byCustomer = new Map<
          string,
          { code: string; name: string; buckets: Record<AgeingBucket, number> }
        >();
        for (const invoice of openInvoices) {
          // Only POSTED invoices are queried at all (DRAFT is
          // structurally excluded above); a fully-settled invoice
          // (outstanding <= 0) is skipped entirely rather than
          // appearing in every bucket at zero — proposal §8.
          const outstanding = invoice.totalMinor - invoice.paidMinor;
          if (outstanding <= 0) continue;

          const bucket = this.bucketFor(invoice.dueDate, asOf);
          const entry = byCustomer.get(invoice.customerId) ?? {
            code: invoice.customerCode,
            name: invoice.customerName,
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
          byCustomer.set(invoice.customerId, entry);
        }

        const rows: CustomerAgeingRow[] = [];
        const totals: Record<AgeingBucket, number> = {
          current: 0,
          d1to30: 0,
          d31to60: 0,
          d61to90: 0,
          d91to120: 0,
          d120plus: 0,
        };
        for (const [customerId, entry] of byCustomer) {
          const b = entry.buckets;
          const totalOutstandingMinor =
            b.current +
            b.d1to30 +
            b.d31to60 +
            b.d61to90 +
            b.d91to120 +
            b.d120plus;
          rows.push({
            customerId,
            customerCode: entry.code,
            customerName: entry.name,
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
        rows.sort((a, b) => a.customerCode.localeCompare(b.customerCode));

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
            customerId: query.customerId ?? null,
            customerCount: rows.length,
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

  /**
   * `/ar/reconciliation` — always legal-entity-wide, deliberately no
   * `customerId` parameter (§9.3, §14 decision 3, resolved: the GL
   * doesn't sub-account the AR control account per customer, so a
   * customer-filtered sub-ledger total would have no meaningful GL-side
   * figure to compare against).
   *
   * Mode dispatch is `query.asOf ? asOfTotals(...) : currentTotals(...)`
   * — parameter presence only, exactly AP-1d's own `getApReconciliation`
   * shape, never a comparison of `asOf` to today (§9.1's CTO
   * correction: `paid_minor` updates at receipt-posting time regardless
   * of the receipt's own `receipt_date`, so an explicit `asOf` at or
   * after today must still use the allocation-join reconstruction, not
   * the `paid_minor` fast path, whenever a later-dated-but-already-
   * POSTED receipt exists).
   */
  async getArReconciliation(
    tenantId: string,
    legalEntityId: string,
    query: ArReconciliationQueryDto,
  ): Promise<ArReconciliationResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();
        const settings = await this.loadArSettingsOrThrow(
          tx,
          tenantId,
          legalEntityId,
        );

        const subLedger = query.asOf
          ? await this.asOfTotals(tx, tenantId, legalEntityId, null, asOf)
          : await this.currentTotals(tx, tenantId, legalEntityId, null);
        const subLedgerTotalOutstandingMinor =
          subLedger.totalInvoicedMinor - subLedger.totalReceivedMinor;

        const glArControlAccountBalanceMinor = await this.glAssetBalance(
          tx,
          tenantId,
          legalEntityId,
          settings.arControlAccountId,
          asOf,
        );

        const differenceMinor =
          subLedgerTotalOutstandingMinor - glArControlAccountBalanceMinor;

        return {
          asOf,
          legalEntityId,
          arControlAccountId: settings.arControlAccountId,
          subLedgerTotalOutstandingMinor,
          glArControlAccountBalanceMinor,
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

  /** Scoped by (id, tenantId, legalEntityId), same as every other
   * Finance resource lookup. Deliberately never filters on isActive —
   * a deactivated customer's historical balance/statement remains
   * fully readable, mirroring GeneralLedgerService.resolveAccount's/
   * ApReportsService.resolveSupplier's identical posture for archived
   * resources. */
  private async resolveCustomer(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    customerId: string,
  ): Promise<Customer> {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.tenantId, tenantId),
          eq(customers.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!customer) {
      throw new NotFoundException(`No customer found with id ${customerId}.`);
    }
    return customer;
  }

  /** Loads ar_settings for this legal entity — a report can't identify
   * the AR control account without it. 404, not 422: unlike
   * posting-time re-validation (CustomerReceiptsService's own AR
   * settings load), this is a read precondition, same posture as
   * ArSettingsService.findOne / ApReportsService.loadApSettingsOrThrow. */
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
      throw new NotFoundException(
        "AR settings have not been configured for this legal entity.",
      );
    }
    return rows[0]!;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * ApReportsService.resolveCurrency, duplicated locally. */
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

  /** Current-mode totals (proposal §6) — summed directly from
   * customer_invoices' own stored total_minor/paid_minor for POSTED
   * invoices. `customerId: null` aggregates across the whole legal
   * entity (used by AR/GL reconciliation, proposal §9). Selected
   * whenever the caller supplies no `asOf` query parameter at all —
   * never by any date comparison (§9.1). */
  private async currentTotals(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    customerId: string | null,
  ): Promise<Totals> {
    const customerFilter = customerId
      ? sql`AND customer_id = ${customerId}`
      : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(total_minor), 0) AS total_invoiced,
        COALESCE(SUM(paid_minor), 0) AS total_received
      FROM customer_invoices
      WHERE tenant_id = ${tenantId}
        AND legal_entity_id = ${legalEntityId}
        AND status = 'POSTED'
        ${customerFilter}
    `)) as unknown as Array<{
      total_invoiced: unknown;
      total_received: unknown;
    }>;
    return {
      totalInvoicedMinor: this.toNumber(rows[0]?.total_invoiced),
      totalReceivedMinor: this.toNumber(rows[0]?.total_received),
    };
  }

  /** As-of-mode totals (proposal §6/§7/§9) — a historical reconstruction
   * using invoice_date/receipt_date instead of today's stored
   * paid_minor: an invoice counts toward totalInvoiced only if its
   * invoice_date qualifies against `cutoffDate`, and a receipt
   * allocation counts toward totalReceived only if BOTH its receipt's
   * receipt_date AND its invoice's invoice_date qualify. `strict: false`
   * (default) uses `<=` (Balance/Reconciliation's as-of semantics — "as
   * of this date" includes that date); `strict: true` uses `<`
   * (Statement's opening-balance semantics — strictly before the window
   * starts, the same convention GeneralLedgerService.getLedger/AP-1d
   * use for their own opening balance). `customerId: null` aggregates
   * across the whole legal entity (reconciliation's as-of mode).
   *
   * Selected for ANY explicit `asOf` value the caller supplies —
   * whether before, equal to, or after today (§9.1's CTO correction).
   * This does NOT rely on `paid_minor`'s current value at all — that is
   * exactly why it is correct even when a receipt has already POSTED
   * with a `receipt_date` after the requested `asOf`: such a receipt's
   * allocation is excluded here by the `receipt_date <= cutoffDate`
   * predicate below, regardless of what `paid_minor` currently holds. */
  private async asOfTotals(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    customerId: string | null,
    cutoffDate: string,
    strict: boolean = false,
  ): Promise<Totals> {
    const cmp = strict ? sql`<` : sql`<=`;
    const invoiceCustomerFilter = customerId
      ? sql`AND ci.customer_id = ${customerId}`
      : sql``;
    const receiptCustomerFilter = customerId
      ? sql`AND cr.customer_id = ${customerId}`
      : sql``;

    const rows = (await tx.execute(sql`
      SELECT
        COALESCE((
          SELECT SUM(ci.total_minor)
          FROM customer_invoices ci
          WHERE ci.tenant_id = ${tenantId}
            AND ci.legal_entity_id = ${legalEntityId}
            AND ci.status = 'POSTED'
            AND ci.invoice_date ${cmp} ${cutoffDate}::date
            ${invoiceCustomerFilter}
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(cra.allocated_amount_minor)
          FROM customer_receipt_allocations cra
          INNER JOIN customer_receipts cr ON cr.id = cra.receipt_id
          INNER JOIN customer_invoices ci2 ON ci2.id = cra.invoice_id
          WHERE cra.tenant_id = ${tenantId}
            AND cr.tenant_id = ${tenantId}
            AND cr.legal_entity_id = ${legalEntityId}
            AND cr.status = 'POSTED'
            AND cr.receipt_date ${cmp} ${cutoffDate}::date
            AND ci2.tenant_id = ${tenantId}
            AND ci2.legal_entity_id = ${legalEntityId}
            AND ci2.status = 'POSTED'
            AND ci2.invoice_date ${cmp} ${cutoffDate}::date
            ${receiptCustomerFilter}
        ), 0) AS total_received
    `)) as unknown as Array<{
      total_invoiced: unknown;
      total_received: unknown;
    }>;
    return {
      totalInvoicedMinor: this.toNumber(rows[0]?.total_invoiced),
      totalReceivedMinor: this.toNumber(rows[0]?.total_received),
    };
  }

  /** The GL side of the reconciliation invariant (proposal §9.2) — the
   * AR control account's own closing balance, computed the same way
   * GeneralLedgerService.getBalance computes any asset account's
   * balance: debit-normal sign, SUM(debit) - SUM(credit) over every
   * POSTED journal_lines row for that account up to `asOf`. This is the
   * one place AP-1d's own `glLiabilityBalance` cannot be copied
   * verbatim — AR's control account is validated ASSET-only
   * (ArSettingsService.upsert), the opposite normal-balance sign from
   * AP's LIABILITY-only control account. Written locally (not imported
   * from GeneralLedgerService, whose balance method isn't exported as a
   * standalone helper) but the identical query shape that file already
   * documents — same tables, same status = 'POSTED' filter, no second
   * accounting mechanism invented. */
  private async glAssetBalance(
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
    // AR control account is always ASSET (validated at
    // ArSettingsService.upsert time) — debit-normal.
    return rawDebit - rawCredit;
  }

  /** Bucket assignment for AR Ageing (proposal §8) — asOf only changes
   * which bucket an invoice's due_date falls into, never the
   * outstanding amount itself. A null due_date (schema allows it —
   * AR-1b never requires one) is bucketed as "current": with no due
   * date there is no defensible overdue determination to make. */
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

  /** Current UTC calendar date, computed once in application code —
   * never SQL CURRENT_DATE/NOW() — the same expression
   * general-ledger.service.ts/ap-reports.service.ts use. */
  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }
}
