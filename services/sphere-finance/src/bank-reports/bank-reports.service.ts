import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "@noryx/db-core";
import {
  bankCashAccounts,
  bankReconciliationMatches,
  bankStatementLines,
  bankTransactions,
  chartOfAccounts,
  customerReceipts,
  supplierPayments,
  type BankCashAccount,
  type ChartOfAccount,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { REPORT_TX_CONFIG } from "../general-ledger/general-ledger.service";
import type { CashPositionQueryDto } from "./dto/cash-position-query.dto";
import type { BankCashAccountStatementQueryDto } from "./dto/bank-cash-account-statement-query.dto";
import type { UnreconciledTransactionsQueryDto } from "./dto/unreconciled-transactions-query.dto";

export interface CashPositionRow {
  bankCashAccountId: string;
  code: string;
  name: string;
  kind: BankCashAccount["kind"];
  currencyCode: string;
  glAccountId: string;
  balanceMinor: number;
}

export interface CashPositionMeta {
  asOf: string;
  legalEntityId: string;
  accountCount: number;
  totalsByCurrency: Record<string, number>;
}

export interface CashPositionResult {
  rows: CashPositionRow[];
  meta: CashPositionMeta;
}

export type StatementLineType =
  "BANK_TRANSACTION" | "SUPPLIER_PAYMENT" | "CUSTOMER_RECEIPT";

export interface BankStatementReportLine {
  type: StatementLineType;
  date: string;
  reference: string | null;
  description: string | null;
  amountMinor: number;
  runningBalanceMinor: number;
  bankTransactionId?: string;
  supplierPaymentId?: string;
  customerReceiptId?: string;
}

export interface BankCashAccountStatementMeta {
  bankCashAccountId: string;
  code: string;
  name: string;
  legalEntityId: string;
  dateFrom: string | null;
  dateTo: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  currencyCode: string;
}

export interface BankCashAccountStatementResult {
  rows: BankStatementReportLine[];
  meta: BankCashAccountStatementMeta;
}

export interface UnreconciledTransactionRow {
  bankTransactionId: string;
  internalReference: string | null;
  type: (typeof bankTransactions.$inferSelect)["type"];
  transactionDate: string;
  bankCashAccountId: string; // the leg this row represents.
  amountMinor: number;
  remainingMinor: number;
  reference: string | null;
  memo: string | null;
}

export interface UnreconciledTransactionsMeta {
  asOf: string;
  legalEntityId: string;
  bankCashAccountId: string | null;
  rowCount: number;
}

export interface UnreconciledTransactionsResult {
  rows: UnreconciledTransactionRow[];
  meta: UnreconciledTransactionsMeta;
}

/**
 * Banking-1d — Cash Position, Bank/Cash Account Statement, Unreconciled
 * Transactions. docs/finance-work-item-banking-1d-proposal.md §2.
 *
 * Read-only, full stop: no INSERT/UPDATE/DELETE anywhere in this file, no
 * audit-log writes (reads are never audited anywhere in this codebase).
 * Every method runs inside `withTenant(tenantId, ...)` with
 * `REPORT_TX_CONFIG` (REPEATABLE READ + READ ONLY, imported directly from
 * general-ledger.service.ts rather than duplicated) — the same one-
 * snapshot guarantee every other Finance read layer in this codebase
 * uses (GL, AP-1d, AR-1d).
 *
 * BOOK BALANCE (`glBookBalance` below) is always the Bank/Cash Account's
 * actual GL balance — SUM(debit)-SUM(credit) over POSTED
 * journal_lines/journal_entries against `bankCashAccounts.glAccountId` up
 * to a date — duplicated locally rather than imported, the identical
 * cross-module-coupling convention `BankReconciliationService.glBookBalance`/
 * `ArReportsService.glAssetBalance`/`ApReportsService.glLiabilityBalance`
 * already established in this codebase. **Never** a sum of
 * `bank_transactions` (locked, Banking-1c's own charter §1, restated
 * here because Cash Position makes the identical claim).
 *
 * No new tables, no new migration (proposal §2/§3) — every number here is
 * derived from bank_cash_accounts/bank_transactions/
 * bank_reconciliation_matches/bank_statement_lines/supplier_payments/
 * customer_receipts/journal_lines, all already written correctly by
 * Banking-1a/1b/1c/AP/AR.
 */
@Injectable()
export class BankReportsService {
  // -------------------------------------------------------------------
  // Cash Position
  // -------------------------------------------------------------------

  async getCashPosition(
    tenantId: string,
    legalEntityId: string,
    query: CashPositionQueryDto,
  ): Promise<CashPositionResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();

        const scope = eq(bankCashAccounts.legalEntityId, legalEntityId);
        const accounts = await tx
          .select()
          .from(bankCashAccounts)
          .where(
            query.includeInactive
              ? scope
              : and(scope, eq(bankCashAccounts.isActive, true)),
          );

        const rows: CashPositionRow[] = [];
        const totalsByCurrency: Record<string, number> = {};
        for (const account of accounts) {
          const balanceMinor = await this.glBookBalance(
            tx,
            tenantId,
            legalEntityId,
            account.glAccountId,
            asOf,
          );
          rows.push({
            bankCashAccountId: account.id,
            code: account.code,
            name: account.name,
            kind: account.kind,
            currencyCode: account.currencyCode,
            glAccountId: account.glAccountId,
            balanceMinor,
          });
          totalsByCurrency[account.currencyCode] =
            (totalsByCurrency[account.currencyCode] ?? 0) + balanceMinor;
        }
        rows.sort((a, b) => a.code.localeCompare(b.code));

        return {
          rows,
          meta: {
            asOf,
            legalEntityId,
            accountCount: rows.length,
            totalsByCurrency,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // -------------------------------------------------------------------
  // Bank/Cash Account Statement
  // -------------------------------------------------------------------

  async getStatement(
    tenantId: string,
    legalEntityId: string,
    bankCashAccountId: string,
    query: BankCashAccountStatementQueryDto,
  ): Promise<BankCashAccountStatementResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const account = await this.resolveBankCashAccountOrThrow(
          tx,
          legalEntityId,
          bankCashAccountId,
        );
        const dateFrom = query.dateFrom ?? null;
        const dateTo = query.dateTo ?? this.todayUtc();

        const openingBalanceMinor = dateFrom
          ? await this.glBookBalance(
              tx,
              tenantId,
              legalEntityId,
              account.glAccountId,
              dateFrom,
              true, // strict — strictly before dateFrom, same convention as AR-1d's own opening balance.
            )
          : 0;

        interface Unsorted {
          sortDate: string;
          sortRef: string;
          line: Omit<BankStatementReportLine, "runningBalanceMinor">;
        }
        const unsorted: Unsorted[] = [];

        // Bank Transactions (Banking-1b) — either leg, POSTED only.
        // Direction per the schema's own documented convention:
        // DEPOSIT/INTEREST = inflow; WITHDRAWAL/FEE = outflow; TRANSFER =
        // outflow on bankCashAccountId, inflow on
        // counterpartyBankCashAccountId.
        const btxConditions = [
          eq(bankTransactions.tenantId, tenantId),
          eq(bankTransactions.legalEntityId, legalEntityId),
          eq(bankTransactions.status, "POSTED"),
          lte(bankTransactions.transactionDate, dateTo),
        ];
        if (dateFrom) {
          btxConditions.push(gte(bankTransactions.transactionDate, dateFrom));
        }
        const allBtx = await tx
          .select()
          .from(bankTransactions)
          .where(and(...btxConditions));
        for (const btx of allBtx) {
          const isPrimaryLeg = btx.bankCashAccountId === bankCashAccountId;
          const isCounterpartyLeg =
            btx.counterpartyBankCashAccountId === bankCashAccountId;
          if (!isPrimaryLeg && !isCounterpartyLeg) continue;

          let amountMinor: number;
          if (btx.type === "TRANSFER") {
            amountMinor = isPrimaryLeg ? -btx.amountMinor : btx.amountMinor;
          } else if (btx.type === "DEPOSIT" || btx.type === "INTEREST") {
            amountMinor = btx.amountMinor;
          } else {
            amountMinor = -btx.amountMinor; // WITHDRAWAL/FEE.
          }
          unsorted.push({
            sortDate: btx.transactionDate,
            sortRef: btx.internalReference ?? "",
            line: {
              type: "BANK_TRANSACTION",
              date: btx.transactionDate,
              reference: btx.internalReference,
              description: btx.memo ?? btx.reference ?? btx.type,
              amountMinor,
              bankTransactionId: btx.id,
            },
          });
        }

        // Supplier Payments (AP) — always an outflow. Read-only join on
        // AP's existing bankCashAccountId column (a chart_of_accounts
        // FK, unchanged) against this account's own glAccountId — proposal
        // §2.2.
        const paymentConditions = [
          eq(supplierPayments.tenantId, tenantId),
          eq(supplierPayments.legalEntityId, legalEntityId),
          eq(supplierPayments.status, "POSTED"),
          eq(supplierPayments.bankCashAccountId, account.glAccountId),
          lte(supplierPayments.paymentDate, dateTo),
        ];
        if (dateFrom) {
          paymentConditions.push(gte(supplierPayments.paymentDate, dateFrom));
        }
        const payments = await tx
          .select()
          .from(supplierPayments)
          .where(and(...paymentConditions));
        for (const p of payments) {
          unsorted.push({
            sortDate: p.paymentDate,
            sortRef: p.internalReference ?? "",
            line: {
              type: "SUPPLIER_PAYMENT",
              date: p.paymentDate,
              reference: p.internalReference,
              description: p.memo ?? p.reference ?? "Supplier payment",
              amountMinor: -p.paymentAmountMinor,
              supplierPaymentId: p.id,
            },
          });
        }

        // Customer Receipts (AR) — always an inflow. Same read-only join
        // shape against this account's glAccountId.
        const receiptConditions = [
          eq(customerReceipts.tenantId, tenantId),
          eq(customerReceipts.legalEntityId, legalEntityId),
          eq(customerReceipts.status, "POSTED"),
          eq(customerReceipts.bankCashAccountId, account.glAccountId),
          lte(customerReceipts.receiptDate, dateTo),
        ];
        if (dateFrom) {
          receiptConditions.push(gte(customerReceipts.receiptDate, dateFrom));
        }
        const receipts = await tx
          .select()
          .from(customerReceipts)
          .where(and(...receiptConditions));
        for (const r of receipts) {
          unsorted.push({
            sortDate: r.receiptDate,
            sortRef: r.internalReference ?? "",
            line: {
              type: "CUSTOMER_RECEIPT",
              date: r.receiptDate,
              reference: r.internalReference,
              description: r.memo ?? r.reference ?? "Customer receipt",
              amountMinor: r.receiptAmountMinor,
              customerReceiptId: r.id,
            },
          });
        }

        // Chronological order, tie-broken by reference — BTX-/PAY-/RCT-
        // prefixes never collide; within one prefix, fixed-width
        // zero-padded numbering (each document type's own numbering
        // convention) keeps lexicographic order equal to numeric order —
        // the same reasoning AR-1d/AP-1d's own statement sort already
        // documents.
        unsorted.sort((a, b) => {
          if (a.sortDate !== b.sortDate)
            return a.sortDate < b.sortDate ? -1 : 1;
          if (a.sortRef < b.sortRef) return -1;
          if (a.sortRef > b.sortRef) return 1;
          return 0;
        });

        let running = openingBalanceMinor;
        const rows: BankStatementReportLine[] = unsorted.map(({ line }) => {
          running += line.amountMinor;
          return { ...line, runningBalanceMinor: running };
        });
        const closingBalanceMinor = running;

        return {
          rows,
          meta: {
            bankCashAccountId: account.id,
            code: account.code,
            name: account.name,
            legalEntityId,
            dateFrom,
            dateTo,
            openingBalanceMinor,
            closingBalanceMinor,
            currencyCode: account.currencyCode,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // -------------------------------------------------------------------
  // Unreconciled Transactions
  // -------------------------------------------------------------------

  async getUnreconciledTransactions(
    tenantId: string,
    legalEntityId: string,
    query: UnreconciledTransactionsQueryDto,
  ): Promise<UnreconciledTransactionsResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const asOf = query.asOf ?? this.todayUtc();
        const rows: UnreconciledTransactionRow[] = [];

        if (query.bankCashAccountId) {
          const account = await this.resolveBankCashAccountOrThrow(
            tx,
            legalEntityId,
            query.bankCashAccountId,
          );
          const candidates = await tx
            .select()
            .from(bankTransactions)
            .where(
              and(
                eq(bankTransactions.tenantId, tenantId),
                eq(bankTransactions.legalEntityId, legalEntityId),
                eq(bankTransactions.status, "POSTED"),
                lte(bankTransactions.transactionDate, asOf),
              ),
            );
          for (const btx of candidates) {
            const isPrimaryLeg = btx.bankCashAccountId === account.id;
            const isCounterpartyLeg =
              btx.counterpartyBankCashAccountId === account.id;
            if (!isPrimaryLeg && !isCounterpartyLeg) continue;
            const remaining = await this.remainingAmountForBankTransaction(
              tx,
              btx.id,
              btx.amountMinor,
              account.id,
            );
            if (remaining > 0) {
              rows.push(this.toUnreconciledRow(btx, account.id, remaining));
            }
          }
        } else {
          const candidates = await tx
            .select()
            .from(bankTransactions)
            .where(
              and(
                eq(bankTransactions.tenantId, tenantId),
                eq(bankTransactions.legalEntityId, legalEntityId),
                eq(bankTransactions.status, "POSTED"),
                lte(bankTransactions.transactionDate, asOf),
              ),
            );
          for (const btx of candidates) {
            // Primary leg — every bank transaction has exactly one.
            const primaryRemaining =
              await this.remainingAmountForBankTransaction(
                tx,
                btx.id,
                btx.amountMinor,
                btx.bankCashAccountId,
              );
            if (primaryRemaining > 0) {
              rows.push(
                this.toUnreconciledRow(
                  btx,
                  btx.bankCashAccountId,
                  primaryRemaining,
                ),
              );
            }
            // Counterparty leg — TRANSFER only (§2.3's double-leg design,
            // the same shape Banking-1c's own matching layer already
            // uses). A TRANSFER can appear as up to two rows here, one
            // per leg, each independently unmatched or not.
            if (btx.type === "TRANSFER" && btx.counterpartyBankCashAccountId) {
              const counterpartyRemaining =
                await this.remainingAmountForBankTransaction(
                  tx,
                  btx.id,
                  btx.amountMinor,
                  btx.counterpartyBankCashAccountId,
                );
              if (counterpartyRemaining > 0) {
                rows.push(
                  this.toUnreconciledRow(
                    btx,
                    btx.counterpartyBankCashAccountId,
                    counterpartyRemaining,
                  ),
                );
              }
            }
          }
        }

        rows.sort((a, b) =>
          a.transactionDate !== b.transactionDate
            ? a.transactionDate < b.transactionDate
              ? -1
              : 1
            : (a.internalReference ?? "").localeCompare(
                b.internalReference ?? "",
              ),
        );

        return {
          rows,
          meta: {
            asOf,
            legalEntityId,
            bankCashAccountId: query.bankCashAccountId ?? null,
            rowCount: rows.length,
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

  private toUnreconciledRow(
    btx: typeof bankTransactions.$inferSelect,
    legAccountId: string,
    remaining: number,
  ): UnreconciledTransactionRow {
    return {
      bankTransactionId: btx.id,
      internalReference: btx.internalReference,
      type: btx.type,
      transactionDate: btx.transactionDate,
      bankCashAccountId: legAccountId,
      amountMinor: btx.amountMinor,
      remainingMinor: remaining,
      reference: btx.reference,
      memo: btx.memo,
    };
  }

  /** Remaining (unallocated) amount for a bank transaction, scoped to
   * ONE leg — identical shape to
   * `BankReconciliationService.remainingAmountForBankTransaction`
   * (duplicated locally per this codebase's cross-module-coupling
   * convention, not imported — `BankReconciliationService` exports no
   * standalone helper for this). Required for TRANSFER's double-leg
   * design: a TRANSFER's single bank_transaction can be independently
   * matched (or not) on each of its two legs. */
  private async remainingAmountForBankTransaction(
    tx: TxClient,
    bankTransactionId: string,
    ownAmountMinor: number,
    legAccountId: string,
  ): Promise<number> {
    const rows = await tx
      .select({
        matchedAmountMinor: bankReconciliationMatches.matchedAmountMinor,
      })
      .from(bankReconciliationMatches)
      .innerJoin(
        bankStatementLines,
        eq(bankReconciliationMatches.statementLineId, bankStatementLines.id),
      )
      .where(
        and(
          eq(bankReconciliationMatches.bankTransactionId, bankTransactionId),
          eq(bankReconciliationMatches.status, "ACTIVE"),
          eq(bankStatementLines.bankCashAccountId, legAccountId),
        ),
      );
    const allocated = rows.reduce((sum, r) => sum + r.matchedAmountMinor, 0);
    return ownAmountMinor - allocated;
  }

  /** Scoped by (id, tenantId via RLS, legalEntityId), same as every other
   * Finance resource lookup. Deliberately never filters on isActive — a
   * deactivated Bank/Cash Account's historical statement remains fully
   * readable, mirroring `ArReportsService.resolveCustomer`/
   * `ApReportsService.resolveSupplier`'s identical posture for archived
   * resources. Cash Position (§2.1) is the one report that DOES filter
   * on isActive, via its own `includeInactive` query flag, not here. */
  private async resolveBankCashAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    bankCashAccountId: string,
  ): Promise<BankCashAccount> {
    const [account] = await tx
      .select()
      .from(bankCashAccounts)
      .where(
        and(
          eq(bankCashAccounts.id, bankCashAccountId),
          eq(bankCashAccounts.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!account) {
      throw new NotFoundException(
        `No Bank/Cash Account found with id ${bankCashAccountId}.`,
      );
    }
    return account;
  }

  /** The account's true GL balance — SUM(debit)-SUM(credit) over POSTED
   * journal_lines/journal_entries up to `asOf`, sign-adjusted by the
   * account's own normal-balance type. Identical query shape to
   * `BankReconciliationService.glBookBalance`/`ArReportsService
   * .glAssetBalance`, duplicated locally (this file's own top comment
   * explains why). `strict: true` uses `<` instead of `<=` — the
   * Statement's opening-balance semantics (§2.2), same as AR-1d's own
   * `asOfTotals(..., strict)`. */
  private async glBookBalance(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    asOf: string,
    strict: boolean = false,
  ): Promise<number> {
    const [account] = await tx
      .select({ type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, accountId))
      .limit(1);
    if (!account) {
      throw new NotFoundException(`No GL account found with id ${accountId}.`);
    }
    const cmp = strict ? sql`<` : sql`<=`;
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
        AND je.transaction_date ${cmp} ${asOf}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    const sign = this.signFor(account.type);
    return sign * (rawDebit - rawCredit);
  }

  /** Duplicated from GeneralLedgerService.signFor — see this file's top
   * comment for why. +1 for a DEBIT-normal type (ASSET, EXPENSE), -1 for
   * a CREDIT-normal type (LIABILITY, EQUITY, REVENUE). A Bank/Cash
   * Account's glAccountId is always ASSET (validated at
   * BankCashAccountsService.create/edit time), but this helper stays
   * general — identical shape to every other duplicate of this function
   * in the codebase. */
  private signFor(type: ChartOfAccount["type"]): 1 | -1 {
    return type === "ASSET" || type === "EXPENSE" ? 1 : -1;
  }

  /** Current UTC calendar date, computed once in application code — never
   * SQL CURRENT_DATE/NOW() — the same expression GL/AP-1d/AR-1d/
   * Banking-1c already use. */
  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }
}
