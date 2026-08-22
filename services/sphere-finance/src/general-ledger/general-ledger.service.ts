import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql, type PgTransactionConfig } from "@noryx/db-core";
import type { LedgerMeta } from "@noryx/shared-types";
import {
  accountingPeriods,
  chartOfAccounts,
  type AccountingPeriod,
  type ChartOfAccount,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { LedgerQueryDto } from "./dto/ledger-query.dto";
import type { AccountBalanceQueryDto } from "./dto/account-balance-query.dto";
import type { TrialBalanceQueryDto } from "./dto/trial-balance-query.dto";

/** Every multi-statement read report in this file (getLedger, getBalance,
 * getTrialBalance) opts into REPEATABLE READ + READ ONLY instead of the
 * codebase's default READ COMMITTED — a single financial report is built
 * from several separate SQL statements (resolve account, opening
 * balance, page fetch, page-boundary predecessor, movement, ...), and
 * under READ COMMITTED each statement gets its own MVCC snapshot, so a
 * journal entry posted concurrently, between two of those statements,
 * could be reflected in one but not the other — producing a response
 * whose displayed rows and computed balances don't actually reconcile
 * (confirmed empirically: a throwaway repro against a live Postgres
 * instance showed a second statement in the same READ COMMITTED
 * transaction observing a row committed after the transaction's first
 * statement had already run; REPEATABLE READ eliminated it). REPEATABLE
 * READ gives the whole transaction one snapshot taken at its first
 * statement, which is exactly "every statement in this report sees the
 * same point-in-time data" — no row locks, no `FOR UPDATE`, no change to
 * the accounting model. READ ONLY is additionally correct because these
 * methods never write. See `withTenantScoped`'s doc comment
 * (packages/db-core/src/generic-client.ts) for the passthrough mechanism
 * — every other Finance service (Accounts, AccountingPeriods,
 * JournalEntries) keeps calling `withTenant` with no config and is
 * unaffected. */
export const REPORT_TX_CONFIG: PgTransactionConfig = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
};

export interface LedgerLine {
  journalEntryId: string;
  journalNumber: string;
  transactionDate: string;
  memo: string | null;
  lineDescription: string | null;
  debitMinor: number;
  creditMinor: number;
  runningBalanceMinor: number;
  reversalOfJournalEntryId: string | null;
  reversedByJournalEntryId: string | null;
}

export interface LedgerResult {
  rows: LedgerLine[];
  meta: LedgerMeta;
}

export interface AccountBalanceResult {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  normalBalance: "DEBIT" | "CREDIT";
  effectiveDateFrom: string | null;
  effectiveDateTo: string;
  openingBalanceMinor: number;
  periodMovementMinor: number;
  closingBalanceMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
}

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  normalBalance: "DEBIT" | "CREDIT";
  isActive: boolean;
  debitMinor: number;
  creditMinor: number;
}

export interface TrialBalanceMetaResult {
  asOf: string;
  periodId: string | null;
  legalEntityId: string;
  totalDebitMinor: number;
  totalCreditMinor: number;
  accountCount: number;
  includeZeroBalance: boolean;
}

export interface TrialBalanceResult {
  rows: TrialBalanceRow[];
  meta: TrialBalanceMetaResult;
}

interface RawTotals {
  rawDebit: number;
  rawCredit: number;
}

/**
 * 2d — General Ledger read layer: Account Ledger, Account Balance,
 * Trial Balance. docs/finance-2d-general-ledger-read-layer-proposal.md
 * (approved for implementation, §0.1/§0.2).
 *
 * Read-only, full stop: no INSERT/UPDATE/DELETE anywhere in this file,
 * no audit-log writes (reads are never audited anywhere in this
 * codebase, §1/§8 of the proposal), no `SELECT ... FOR UPDATE` (Postgres
 * MVCC means a read never blocks on or is blocked by a writer's row
 * lock — §8). Every method runs inside `withTenant(tenantId, ...)`
 * exactly like every other Finance service, and every query carries an
 * explicit `legalEntityId` predicate in addition to RLS, same
 * tenant+legal-entity isolation convention as AccountsService and
 * JournalEntriesService (§9).
 *
 * Account resolution deliberately never filters on `isActive` — an
 * archived account's ledger/balance/trial-balance contribution remains
 * fully readable (§2.1.1/§4.6), mirroring AccountsService.findOne's own
 * behavior.
 *
 * Several aggregate queries here (opening balance, page-boundary
 * running-balance predecessor sum, account-balance movement, trial
 * balance per-account grouping) use `tx.execute(sql\`...\`)` rather than
 * the Drizzle query builder — the same deliberate choice
 * `JournalEntriesService.allocateJournalNumber` already made for a
 * statement the builder cannot cleanly express (here: a tuple/row-value
 * ordering comparison for §2.1.6's page-boundary algorithm, and a
 * pre-filtered-subquery `GROUP BY` for Trial Balance). RLS still applies
 * to every raw statement — it runs on the same `tx` that already had
 * `SET LOCAL app.current_tenant_id` set by `withTenant()`, exactly like
 * `allocateJournalNumber`'s raw INSERT does today. `journal_lines`'
 * `debit_minor`/`credit_minor` are `bigint` columns (`SUM` over them
 * comes back from Postgres as `numeric`, which the driver returns as a
 * string) — every raw aggregate result is passed through `toNumber()`
 * below, consistent with the schema's own `bigint({ mode: "number" })`
 * choice for these columns everywhere else in this codebase.
 */
@Injectable()
export class GeneralLedgerService {
  async getLedger(
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    query: LedgerQueryDto,
  ): Promise<LedgerResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const account = await this.resolveAccount(
          tx,
          tenantId,
          legalEntityId,
          accountId,
        );
        const sign = this.signFor(account.type);

        let effectiveDateFrom: string | null;
        let effectiveDateTo: string;
        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          effectiveDateFrom = period.startDate;
          effectiveDateTo = period.endDate;
        } else {
          effectiveDateFrom = query.dateFrom ?? null;
          effectiveDateTo = query.dateTo ?? this.todayUtc();
        }

        const openingBalanceMinor = effectiveDateFrom
          ? sign *
            (
              await this.rawTotalsBefore(
                tx,
                tenantId,
                legalEntityId,
                accountId,
                effectiveDateFrom,
              )
            ).netDelta
          : 0;

        const totalItems = await this.countLedgerLines(
          tx,
          tenantId,
          legalEntityId,
          accountId,
          effectiveDateFrom,
          effectiveDateTo,
        );

        const offset = (query.page - 1) * query.pageSize;
        const rows = await this.fetchLedgerPage(
          tx,
          tenantId,
          legalEntityId,
          accountId,
          effectiveDateFrom,
          effectiveDateTo,
          query.pageSize,
          offset,
        );

        let pageStartingBalance = openingBalanceMinor;
        if (rows.length > 0 && query.page > 1) {
          const first = rows[0]!;
          const predecessor = await this.rawTotalsBeforeTuple(
            tx,
            tenantId,
            legalEntityId,
            accountId,
            effectiveDateFrom,
            effectiveDateTo,
            first,
          );
          pageStartingBalance =
            openingBalanceMinor + sign * predecessor.netDelta;
        }

        let running = pageStartingBalance;
        const lines: LedgerLine[] = rows.map((r) => {
          running += sign * (r.debitMinor - r.creditMinor);
          return {
            journalEntryId: r.journalEntryId,
            journalNumber: r.journalNumber,
            transactionDate: r.transactionDate,
            memo: r.memo,
            lineDescription: r.lineDescription,
            debitMinor: r.debitMinor,
            creditMinor: r.creditMinor,
            runningBalanceMinor: running,
            reversalOfJournalEntryId: r.reversalOfJournalEntryId,
            reversedByJournalEntryId: r.reversedByJournalEntryId,
          };
        });

        return {
          rows: lines,
          meta: {
            page: query.page,
            pageSize: query.pageSize,
            totalItems,
            totalPages: Math.ceil(totalItems / query.pageSize),
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            accountType: account.type,
            normalBalance: sign === 1 ? "DEBIT" : "CREDIT",
            openingBalanceMinor,
            effectiveDateFrom,
            effectiveDateTo,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getBalance(
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    query: AccountBalanceQueryDto,
  ): Promise<AccountBalanceResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        const account = await this.resolveAccount(
          tx,
          tenantId,
          legalEntityId,
          accountId,
        );
        const sign = this.signFor(account.type);

        let effectiveDateFrom: string | null;
        let effectiveDateTo: string;
        const isRangeMode =
          query.periodId !== undefined ||
          query.dateFrom !== undefined ||
          query.dateTo !== undefined;

        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          effectiveDateFrom = period.startDate;
          effectiveDateTo = period.endDate;
        } else if (isRangeMode) {
          effectiveDateFrom = query.dateFrom ?? null;
          effectiveDateTo = query.dateTo ?? this.todayUtc();
        } else {
          // asOf mode (explicit asOf, or the §4.8 today-default when
          // neither asOf nor any range input is given) — §3.1.1:
          // openingBalanceMinor is 0, periodMovementMinor is the full
          // life-to-date balance, closingBalanceMinor equals it.
          effectiveDateFrom = null;
          effectiveDateTo = query.asOf ?? this.todayUtc();
        }

        const openingBalanceMinor = effectiveDateFrom
          ? sign *
            (
              await this.rawTotalsBefore(
                tx,
                tenantId,
                legalEntityId,
                accountId,
                effectiveDateFrom,
              )
            ).netDelta
          : 0;

        const movement = await this.rawTotalsWithinRange(
          tx,
          tenantId,
          legalEntityId,
          accountId,
          effectiveDateFrom,
          effectiveDateTo,
        );
        const periodMovementMinor = sign * movement.netDelta;
        const closingBalanceMinor = openingBalanceMinor + periodMovementMinor;

        return {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          normalBalance: sign === 1 ? "DEBIT" : "CREDIT",
          effectiveDateFrom,
          effectiveDateTo,
          openingBalanceMinor,
          periodMovementMinor,
          closingBalanceMinor,
          totalDebitMinor: movement.rawDebit,
          totalCreditMinor: movement.rawCredit,
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  async getTrialBalance(
    tenantId: string,
    legalEntityId: string,
    query: TrialBalanceQueryDto,
  ): Promise<TrialBalanceResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let asOf: string;
        let resolvedPeriodId: string | null;
        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          asOf = period.endDate;
          resolvedPeriodId = period.id;
        } else if (query.asOf) {
          asOf = query.asOf;
          resolvedPeriodId = null;
        } else {
          asOf = this.todayUtc();
          resolvedPeriodId = null;
        }

        const raw = (await tx.execute(sql`
        SELECT
          coa.id AS account_id,
          coa.code AS account_code,
          coa.name AS account_name,
          coa.type AS account_type,
          coa.is_active AS is_active,
          COALESCE(SUM(pl.debit_minor), 0) AS raw_debit,
          COALESCE(SUM(pl.credit_minor), 0) AS raw_credit
        FROM chart_of_accounts coa
        LEFT JOIN (
          SELECT jl.account_id, jl.debit_minor, jl.credit_minor
          FROM journal_lines jl
          INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.tenant_id = ${tenantId}
            AND je.tenant_id = ${tenantId}
            AND je.legal_entity_id = ${legalEntityId}
            AND je.status = 'POSTED'
            AND je.transaction_date <= ${asOf}::date
        ) pl ON pl.account_id = coa.id
        WHERE coa.tenant_id = ${tenantId}
          AND coa.legal_entity_id = ${legalEntityId}
        GROUP BY coa.id, coa.code, coa.name, coa.type, coa.is_active
        ORDER BY coa.code ASC
      `)) as unknown as Array<{
          account_id: string;
          account_code: string;
          account_name: string;
          account_type: ChartOfAccount["type"];
          is_active: boolean;
          raw_debit: unknown;
          raw_credit: unknown;
        }>;

        const rows: TrialBalanceRow[] = [];
        let totalDebitMinor = 0;
        let totalCreditMinor = 0;
        for (const r of raw) {
          const rawDebit = this.toNumber(r.raw_debit);
          const rawCredit = this.toNumber(r.raw_credit);
          const netMinor = rawDebit - rawCredit;
          if (netMinor === 0 && !query.includeZeroBalance) continue;

          const sign = this.signFor(r.account_type);
          const debitMinor = netMinor > 0 ? netMinor : 0;
          const creditMinor = netMinor < 0 ? -netMinor : 0;
          totalDebitMinor += debitMinor;
          totalCreditMinor += creditMinor;

          rows.push({
            accountId: r.account_id,
            accountCode: r.account_code,
            accountName: r.account_name,
            accountType: r.account_type,
            normalBalance: sign === 1 ? "DEBIT" : "CREDIT",
            isActive: r.is_active,
            debitMinor,
            creditMinor,
          });
        }

        // §5.1.6's internal defensive assertion — this must always hold by
        // construction (§4.3's proof, resting on 2b's deferred balance
        // trigger); a mismatch here is a bug worth surfacing loudly, not
        // silently shipping a non-reconciling trial balance.
        if (totalDebitMinor !== totalCreditMinor) {
          throw new Error(
            `Trial balance failed to reconcile: total debits (${totalDebitMinor}) != total credits (${totalCreditMinor}). This should be impossible given 2b's balance invariant trigger — surfacing as a hard failure rather than returning a wrong report.`,
          );
        }

        return {
          rows,
          meta: {
            asOf,
            periodId: resolvedPeriodId,
            legalEntityId,
            totalDebitMinor,
            totalCreditMinor,
            accountCount: rows.length,
            includeZeroBalance: query.includeZeroBalance,
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

  /** §4.1's normal-balance-by-type mapping, as a sign: +1 for a
   * DEBIT-normal account (ASSET, EXPENSE — debitMinor - creditMinor),
   * -1 for a CREDIT-normal account (LIABILITY, EQUITY, REVENUE —
   * creditMinor - debitMinor). */
  private signFor(type: ChartOfAccount["type"]): 1 | -1 {
    return type === "ASSET" || type === "EXPENSE" ? 1 : -1;
  }

  /** §4.8's deterministic "today": current UTC calendar date, computed
   * once in application code — never SQL `CURRENT_DATE`/`NOW()` — the
   * same expression 2c-2 already uses for reversal's default
   * transactionDate (journal-entries.service.ts). */
  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }

  /** §2.1.1/§3.1's account resolution — scoped by (tenantId,
   * legalEntityId), never filtered on isActive. 404 for a nonexistent id
   * or one belonging to a different tenant/legal entity, matching every
   * other resource lookup's information-disclosure convention (§9). */
  private async resolveAccount(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
  ): Promise<ChartOfAccount> {
    const [account] = await tx
      .select()
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!account) {
      throw new NotFoundException(`No account found with id ${accountId}.`);
    }
    return account;
  }

  /** `periodId` resolution shared by Ledger/Account Balance/Trial
   * Balance — scoped by (tenantId, legalEntityId), 404 if out of scope
   * (§2.1.2/§3.1.1/§5.1.2/§9). A period's OPEN/CLOSED status never
   * affects whether this resolves — read access never depends on
   * postability (§2.1.2/§4.4/§5.1.2). Read-only: unlike
   * JournalEntriesService.resolveAndLockOpenPeriod, this never locks the
   * row (§8 — 2d introduces no new concurrency controls). */
  private async resolvePeriodInScope(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    periodId: string,
  ): Promise<AccountingPeriod> {
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

  /** Raw (unsigned) debit/credit totals, plus their plain difference
   * (`rawDebit - rawCredit`, i.e. a DEBIT-normal-sign delta the caller
   * multiplies by their own account's sign — §4.1), for every qualifying
   * POSTED line strictly before `beforeDate` — §2.1.5's opening-balance
   * definition, reused by both Ledger and Account Balance. */
  private async rawTotalsBefore(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    beforeDate: string,
  ): Promise<RawTotals & { netDelta: number }> {
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
        AND je.transaction_date < ${beforeDate}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    return { rawDebit, rawCredit, netDelta: rawDebit - rawCredit };
  }

  /** Same shape as rawTotalsBefore, but over an inclusive
   * `[dateFrom, dateTo]` window (dateFrom may be null — "from account
   * inception") — Account Balance's periodMovementMinor (§3.1.1). */
  private async rawTotalsWithinRange(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string | null,
    dateTo: string,
  ): Promise<RawTotals & { netDelta: number }> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
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
        ${lowerBound}
        AND je.transaction_date <= ${dateTo}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    return { rawDebit, rawCredit, netDelta: rawDebit - rawCredit };
  }

  /** §2.1.6 step 3's page-boundary predecessor sum: every qualifying
   * line within `[dateFrom, dateTo]` strictly before `beforeTuple`'s
   * `(transactionDate, journalNumber, lineNumber)` ordering position —
   * the exact §2.1.4 deterministic order, compared as a Postgres
   * row-value (tuple) comparison. `journalNumber` is compared as a
   * string here — valid because every value shares the same
   * `JE-{n:06d}` zero-padded prefix and width (§2.1.4's documented,
   * relied-upon 2c-2 invariant), so lexicographic order matches numeric
   * order. */
  private async rawTotalsBeforeTuple(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string | null,
    dateTo: string,
    beforeTuple: {
      transactionDate: string;
      journalNumber: string;
      lineNumber: number;
    },
  ): Promise<RawTotals & { netDelta: number }> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
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
        ${lowerBound}
        AND je.transaction_date <= ${dateTo}::date
        AND (je.transaction_date, je.journal_number, jl.line_number)
          < (${beforeTuple.transactionDate}::date, ${beforeTuple.journalNumber}, ${beforeTuple.lineNumber})
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    return { rawDebit, rawCredit, netDelta: rawDebit - rawCredit };
  }

  private async countLedgerLines(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string | null,
    dateTo: string,
  ): Promise<number> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const rows = (await tx.execute(sql`
      SELECT COUNT(*) AS total
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId}
        AND jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        ${lowerBound}
        AND je.transaction_date <= ${dateTo}::date
    `)) as unknown as Array<{ total: unknown }>;
    return this.toNumber(rows[0]?.total);
  }

  private async fetchLedgerPage(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string | null,
    dateTo: string,
    pageSize: number,
    offset: number,
  ): Promise<
    Array<{
      journalEntryId: string;
      journalNumber: string;
      transactionDate: string;
      memo: string | null;
      lineNumber: number;
      lineDescription: string | null;
      debitMinor: number;
      creditMinor: number;
      reversalOfJournalEntryId: string | null;
      reversedByJournalEntryId: string | null;
    }>
  > {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        je.id AS journal_entry_id,
        je.journal_number AS journal_number,
        je.transaction_date AS transaction_date,
        je.memo AS memo,
        jl.line_number AS line_number,
        jl.description AS line_description,
        jl.debit_minor AS debit_minor,
        jl.credit_minor AS credit_minor,
        je.reversal_of_journal_entry_id AS reversal_of_journal_entry_id,
        je.reversed_by_journal_entry_id AS reversed_by_journal_entry_id
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId}
        AND jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        ${lowerBound}
        AND je.transaction_date <= ${dateTo}::date
      ORDER BY je.transaction_date ASC, je.journal_number ASC, jl.line_number ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `)) as unknown as Array<{
      journal_entry_id: string;
      journal_number: string;
      transaction_date: unknown;
      memo: string | null;
      line_number: number;
      line_description: string | null;
      debit_minor: unknown;
      credit_minor: unknown;
      reversal_of_journal_entry_id: string | null;
      reversed_by_journal_entry_id: string | null;
    }>;

    return rows.map((r) => ({
      journalEntryId: r.journal_entry_id,
      journalNumber: r.journal_number,
      transactionDate: this.dateOnly(r.transaction_date),
      memo: r.memo,
      lineNumber: r.line_number,
      lineDescription: r.line_description,
      debitMinor: this.toNumber(r.debit_minor),
      creditMinor: this.toNumber(r.credit_minor),
      reversalOfJournalEntryId: r.reversal_of_journal_entry_id,
      reversedByJournalEntryId: r.reversed_by_journal_entry_id,
    }));
  }

  /** Normalizes a raw driver value for a Postgres `date` column to a
   * plain `YYYY-MM-DD` string, regardless of whether the underlying
   * driver handed back a JS `Date` (postgres.js's default `date` type
   * parser) or an already-formatted string — `tx.execute()` bypasses
   * Drizzle's own column-mode mapping (`date(..)` defaults to
   * `mode: "string"` for the query-builder path, schema.ts), so raw
   * results need this explicit normalization to stay consistent with
   * every other date this API returns. */
  private dateOnly(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "string") {
      return value.length >= 10 ? value.slice(0, 10) : value;
    }
    return String(value);
  }
}
