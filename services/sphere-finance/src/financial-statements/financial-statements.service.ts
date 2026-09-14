import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "@noryx/db-core";
import { REPORT_TX_CONFIG } from "../general-ledger/general-ledger.service";
import {
  accountingPeriods,
  type AccountingPeriod,
  type ChartOfAccount,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { ProfitAndLossQueryDto } from "./dto/profit-and-loss-query.dto";
import type { BalanceSheetQueryDto } from "./dto/balance-sheet-query.dto";
import type { CashFlowQueryDto } from "./dto/cash-flow-query.dto";

/**
 * Financial Statements — Profit & Loss, Balance Sheet.
 * docs/finance-work-item-financial-statements-proposal.md (CTO-approved
 * "APPROVAL — IMPLEMENT FINANCIAL STATEMENTS").
 *
 * Pure read layer: no INSERT/UPDATE/DELETE anywhere in this file, no new
 * schema, no change to any posting path. Reuses `REPORT_TX_CONFIG`
 * (REPEATABLE READ / READ ONLY, exported from `GeneralLedgerService`,
 * already shared with AP-1d/AR-1d) so every multi-statement report here
 * sees one consistent snapshot — identical reasoning to that file's own
 * top comment.
 *
 * Sign convention (§6.3/§8.2/§9.2 of the proposal) — reused verbatim
 * from `GeneralLedgerService.signFor`, duplicated here rather than
 * imported, matching this codebase's established convention of small
 * per-service helpers over cross-module coupling for these (cf.
 * AP-1d/AR-1d's own `glLiabilityBalance`/`glAssetBalance`, which do the
 * same rather than reaching into `GeneralLedgerService`): `+1` for
 * `ASSET`/`EXPENSE` (debit-normal), `-1` for `LIABILITY`/`EQUITY`/
 * `REVENUE` (credit-normal). Every `ownBalanceMinor`/`totalMinor` below
 * is this signed quantity — a normal balance is always a positive
 * number, an abnormal balance a negative one, identical convention to
 * every other report in this codebase.
 */
@Injectable()
export class FinancialStatementsService {
  // -------------------------------------------------------------------
  // Profit & Loss — §6 of the proposal. A MOVEMENT statement: only
  // activity strictly within [dateFrom, dateTo] counts, never
  // cumulative-since-inception (that distinction is deliberate — see
  // §6.2/§9.1's contrast in the proposal).
  // -------------------------------------------------------------------
  async getProfitAndLoss(
    tenantId: string,
    legalEntityId: string,
    query: ProfitAndLossQueryDto,
  ): Promise<ProfitAndLossResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let dateFrom: string | null;
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
        } else {
          dateFrom = query.dateFrom ?? null;
          dateTo = query.dateTo ?? this.todayUtc();
          periodId = null;
        }

        const revenueRows = await this.fetchTypeBalancesWithinRange(
          tx,
          tenantId,
          legalEntityId,
          "REVENUE",
          dateFrom,
          dateTo,
        );
        const expenseRows = await this.fetchTypeBalancesWithinRange(
          tx,
          tenantId,
          legalEntityId,
          "EXPENSE",
          dateFrom,
          dateTo,
        );

        const revenueSection = this.buildSection(revenueRows, "P&L Revenue");
        const expenseSection = this.buildSection(expenseRows, "P&L Expense");

        return {
          dateFrom,
          dateTo,
          periodId,
          legalEntityId,
          revenue: {
            roots: this.applyZeroBalanceFilter(
              revenueSection.roots,
              query.includeZeroBalance,
            ),
            totalMinor: revenueSection.totalMinor,
          },
          expense: {
            roots: this.applyZeroBalanceFilter(
              expenseSection.roots,
              query.includeZeroBalance,
            ),
            totalMinor: expenseSection.totalMinor,
          },
          // §6.4 — Revenue minus Expense, both already the section's
          // signed-normal (positive-for-normal-balance) total.
          netIncomeMinor: revenueSection.totalMinor - expenseSection.totalMinor,
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // -------------------------------------------------------------------
  // Balance Sheet — §8/§9 of the proposal. A point-in-time snapshot:
  // Asset/Liability/Equity balances and cumulative Revenue/Expense are
  // all life-to-date through `asOf`, never a movement window.
  // -------------------------------------------------------------------
  async getBalanceSheet(
    tenantId: string,
    legalEntityId: string,
    query: BalanceSheetQueryDto,
  ): Promise<BalanceSheetResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let asOf: string;
        let periodId: string | null;
        let periodStartDate: string | null;
        if (query.periodId) {
          const period = await this.resolvePeriodInScope(
            tx,
            tenantId,
            legalEntityId,
            query.periodId,
          );
          asOf = period.endDate;
          periodId = period.id;
          periodStartDate = period.startDate;
        } else {
          asOf = query.asOf ?? this.todayUtc();
          periodId = null;
          periodStartDate = null;
        }

        const assetRows = await this.fetchTypeBalancesAsOf(
          tx,
          tenantId,
          legalEntityId,
          "ASSET",
          asOf,
        );
        const liabilityRows = await this.fetchTypeBalancesAsOf(
          tx,
          tenantId,
          legalEntityId,
          "LIABILITY",
          asOf,
        );
        const equityRows = await this.fetchTypeBalancesAsOf(
          tx,
          tenantId,
          legalEntityId,
          "EQUITY",
          asOf,
        );

        const assetsSection = this.buildSection(
          assetRows,
          "Balance Sheet Assets",
        );
        const liabilitiesSection = this.buildSection(
          liabilityRows,
          "Balance Sheet Liabilities",
        );
        const equitySection = this.buildSection(
          equityRows,
          "Balance Sheet Equity",
        );

        // §9.1/§9.2 — cumulative (life-to-date through asOf) Revenue and
        // Expense, the direct input to the accumulated-earnings identity.
        // Deliberately NOT hierarchy-grouped for this purpose (only the
        // scalar cumulative net income figure is needed here; the P&L
        // endpoint is where Revenue/Expense get their own hierarchy).
        const cumulativeRevenueRows = await this.fetchTypeBalancesAsOf(
          tx,
          tenantId,
          legalEntityId,
          "REVENUE",
          asOf,
        );
        const cumulativeExpenseRows = await this.fetchTypeBalancesAsOf(
          tx,
          tenantId,
          legalEntityId,
          "EXPENSE",
          asOf,
        );
        const cumulativeRevenueMinor = this.sumOwnBalance(
          cumulativeRevenueRows,
        );
        const cumulativeExpenseMinor = this.sumOwnBalance(
          cumulativeExpenseRows,
        );
        const cumulativeNetIncomeMinor =
          cumulativeRevenueMinor - cumulativeExpenseMinor;

        // §9.3 — prior-period/current-period split, only when periodId
        // resolves an actual period boundary to split on.
        let priorPeriodsMinor: number | null = null;
        let currentPeriodMinor: number | null = null;
        if (periodId && periodStartDate) {
          const priorRevenueRows = await this.fetchTypeBalancesBefore(
            tx,
            tenantId,
            legalEntityId,
            "REVENUE",
            periodStartDate,
          );
          const priorExpenseRows = await this.fetchTypeBalancesBefore(
            tx,
            tenantId,
            legalEntityId,
            "EXPENSE",
            periodStartDate,
          );
          priorPeriodsMinor =
            this.sumOwnBalance(priorRevenueRows) -
            this.sumOwnBalance(priorExpenseRows);

          const currentRevenueRows = await this.fetchTypeBalancesWithinRange(
            tx,
            tenantId,
            legalEntityId,
            "REVENUE",
            periodStartDate,
            asOf,
          );
          const currentExpenseRows = await this.fetchTypeBalancesWithinRange(
            tx,
            tenantId,
            legalEntityId,
            "EXPENSE",
            periodStartDate,
            asOf,
          );
          currentPeriodMinor =
            this.sumOwnBalance(currentRevenueRows) -
            this.sumOwnBalance(currentExpenseRows);

          // §9.3's additive-decomposition proof, checked defensively at
          // runtime — same "should be impossible by construction,
          // surface loudly rather than ship a wrong report" convention
          // as GeneralLedgerService.getTrialBalance's own assertion.
          if (
            priorPeriodsMinor + currentPeriodMinor !==
            cumulativeNetIncomeMinor
          ) {
            throw new Error(
              `Accumulated earnings split failed to reconcile: priorPeriods (${priorPeriodsMinor}) + currentPeriod (${currentPeriodMinor}) != cumulative (${cumulativeNetIncomeMinor}). This should be impossible given additive date-range decomposition — surfacing as a hard failure rather than returning a wrong report.`,
            );
          }
        }

        const recordedEquityMinor = equitySection.totalMinor;
        // §8.4 — accumulated/unclosed earnings is a computed presentation
        // line only, never a chart_of_accounts row, never written to the
        // database. Standard Balance Sheet convention folds it into
        // Total Equity while keeping it separately labeled from actual
        // posted Equity-type account balances.
        const totalEquityMinor = recordedEquityMinor + cumulativeNetIncomeMinor;

        const assetsMinor = assetsSection.totalMinor;
        const liabilitiesPlusEquityMinor =
          liabilitiesSection.totalMinor + totalEquityMinor;
        const differenceMinor = assetsMinor - liabilitiesPlusEquityMinor;

        // §9.2/§9.5 — the accounting identity itself, derived directly
        // from the DB-enforced balance trigger (drizzle/constraints/
        // 002_balance_invariant_trigger.sql). Provably true by
        // construction; a mismatch here is a bug worth surfacing loudly,
        // not silently shipping a non-reconciling Balance Sheet — same
        // convention as GeneralLedgerService.getTrialBalance's own
        // defensive assertion.
        if (differenceMinor !== 0) {
          throw new Error(
            `Balance Sheet failed to reconcile: assets (${assetsMinor}) != liabilities + equity (${liabilitiesPlusEquityMinor}), difference ${differenceMinor}. This should be impossible given the DB balance-invariant trigger — surfacing as a hard failure rather than returning a wrong report.`,
          );
        }

        return {
          asOf,
          periodId,
          legalEntityId,
          assets: {
            roots: this.applyZeroBalanceFilter(
              assetsSection.roots,
              query.includeZeroBalance,
            ),
            totalMinor: assetsSection.totalMinor,
          },
          liabilities: {
            roots: this.applyZeroBalanceFilter(
              liabilitiesSection.roots,
              query.includeZeroBalance,
            ),
            totalMinor: liabilitiesSection.totalMinor,
          },
          equity: {
            roots: this.applyZeroBalanceFilter(
              equitySection.roots,
              query.includeZeroBalance,
            ),
            // `totalMinor` is the hierarchy-tree total for the roots
            // above — i.e. the recorded EQUITY-type accounts only, the
            // same shape as `assets.totalMinor`/`liabilities.totalMinor`
            // — deliberately equal to `recordedEquityMinor` (§8.4: the
            // two names exist because `totalMinor` matches every other
            // section's shape, while `recordedEquityMinor` is the
            // domain-specific name used alongside `totalEquityMinor`).
            totalMinor: recordedEquityMinor,
            recordedEquityMinor,
            accumulatedEarnings: {
              priorPeriodsMinor,
              currentPeriodMinor,
              cumulativeMinor: cumulativeNetIncomeMinor,
            },
            totalEquityMinor,
          },
          identity: {
            assetsMinor,
            liabilitiesPlusEquityMinor,
            differenceMinor,
            reconciled: differenceMinor === 0,
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // -------------------------------------------------------------------
  // Cash Flow Statement (indirect method) — docs/finance-work-item-
  // cash-flow-statement-proposal.md. A MOVEMENT statement, same DTO
  // shape as Profit & Loss (no `asOf`). Approved architecture (proposal
  // §5): account-level `cashFlowCategory` classification, gated by a
  // computed, unstored, entry-level "reconciling vs. pure non-cash
  // reclassification" eligibility test — an entry contributes to
  // Operating/Investing/Financing only if at least one of its lines
  // touches a cash account (§8) or a REVENUE/EXPENSE account; a pure
  // non-cash reclassification entry (neither) contributes to none of
  // the three and is instead surfaced in `nonCashReclassifications`
  // (proposal §15.3, IAS 7.43). Proven in the proposal (§5.2) that
  // excluding such entries changes nothing about the aggregate
  // reconciling identity — both hard-failure checks below are therefore
  // expected to always hold, exactly like Balance Sheet's own identity
  // check, and are implemented the same way: `throw` rather than
  // silently ship a wrong report.
  // -------------------------------------------------------------------
  async getCashFlow(
    tenantId: string,
    legalEntityId: string,
    query: CashFlowQueryDto,
  ): Promise<CashFlowResult> {
    return withTenant(
      tenantId,
      async (tx: TxClient) => {
        let dateFrom: string | null;
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
        } else {
          dateFrom = query.dateFrom ?? null;
          dateTo = query.dateTo ?? this.todayUtc();
          periodId = null;
        }

        // §5's cash-account identification (proposal §8) — ALL
        // bank_cash_accounts rows for the legal entity, regardless of
        // `isActive` (a reversible toggle, not a deletion — filtering on
        // it would silently drop real historical cash movement from any
        // window predating a deactivation, proposal §8).
        const cashAccountIds = await this.fetchCashAccountIds(
          tx,
          tenantId,
          legalEntityId,
        );

        // Opening/closing cash are independently queried (not merely
        // derived by addition) so the identity check below is a genuine
        // cross-check, matching Balance Sheet's own independent-query
        // identity pattern rather than a tautology.
        const openingCashMinor = dateFrom
          ? await this.fetchCashTotalBefore(
              tx,
              tenantId,
              legalEntityId,
              cashAccountIds,
              dateFrom,
            )
          : 0;
        const netCashMovementMinor = await this.fetchCashTotalWithinRange(
          tx,
          tenantId,
          legalEntityId,
          cashAccountIds,
          dateFrom,
          dateTo,
        );
        const closingCashMinor = await this.fetchCashTotalAsOf(
          tx,
          tenantId,
          legalEntityId,
          cashAccountIds,
          dateTo,
        );

        if (openingCashMinor + netCashMovementMinor !== closingCashMinor) {
          throw new Error(
            `Cash Flow Statement failed to reconcile: opening cash (${openingCashMinor}) + net cash movement (${netCashMovementMinor}) != closing cash (${closingCashMinor}). This should be impossible given the DB balance-invariant trigger — surfacing as a hard failure rather than returning a wrong report.`,
          );
        }

        // Net income — reused exactly, unrestricted (proposal §5.1: any
        // entry touching REVENUE/EXPENSE is automatically a reconciling
        // entry, so no additional filtering is needed or correct here).
        const revenueRows = await this.fetchTypeBalancesWithinRange(
          tx,
          tenantId,
          legalEntityId,
          "REVENUE",
          dateFrom,
          dateTo,
        );
        const expenseRows = await this.fetchTypeBalancesWithinRange(
          tx,
          tenantId,
          legalEntityId,
          "EXPENSE",
          dateFrom,
          dateTo,
        );
        const netIncomeMinor =
          this.sumOwnBalance(revenueRows) - this.sumOwnBalance(expenseRows);

        // Working-capital movement per non-cash ASSET/LIABILITY/EQUITY
        // account, restricted to reconciling entries (proposal §5.1/§17).
        const workingCapitalRows = await this.fetchCashFlowWorkingCapital(
          tx,
          tenantId,
          legalEntityId,
          cashAccountIds,
          dateFrom,
          dateTo,
        );

        let operatingMinor = netIncomeMinor;
        let investingMinor = 0;
        let financingMinor = 0;
        let unclassifiedMinor = 0;
        const unclassifiedAccounts: CashFlowUnclassifiedAccount[] = [];
        for (const row of workingCapitalRows) {
          // contribution(a) = -signedDelta for ASSET, +signedDelta for
          // LIABILITY/EQUITY — algebraically equal to (credit - debit)
          // uniformly across all three types (proposal's `contribution()`
          // formula, simplified: sign(ASSET)=+1 so -signedDelta =
          // -(debit-credit) = credit-debit; sign(LIABILITY/EQUITY)=-1 so
          // +signedDelta = -(debit-credit) = credit-debit too).
          const contribution =
            row.reconcilingCreditMinor - row.reconcilingDebitMinor;
          switch (row.cashFlowCategory) {
            case "OPERATING":
              operatingMinor += contribution;
              break;
            case "INVESTING":
              investingMinor += contribution;
              break;
            case "FINANCING":
              financingMinor += contribution;
              break;
            default:
              unclassifiedMinor += contribution;
              if (contribution !== 0) {
                unclassifiedAccounts.push({
                  accountId: row.accountId,
                  code: row.accountCode,
                  name: row.accountName,
                  type: row.accountType,
                  movementMinor: contribution,
                });
              }
          }
        }
        unclassifiedAccounts.sort(
          (a, b) => Math.abs(b.movementMinor) - Math.abs(a.movementMinor),
        );

        const bucketSumMinor =
          operatingMinor + investingMinor + financingMinor + unclassifiedMinor;
        if (bucketSumMinor !== netCashMovementMinor) {
          throw new Error(
            `Cash Flow Statement failed to reconcile: Operating (${operatingMinor}) + Investing (${investingMinor}) + Financing (${financingMinor}) + Unclassified (${unclassifiedMinor}) = ${bucketSumMinor} != net cash movement (${netCashMovementMinor}). This should be impossible given the reconciling-entry construction (proposal §5.2) — surfacing as a hard failure rather than returning a wrong report.`,
          );
        }

        // Non-cash reclassifications (proposal §5.1/§15.3, IAS 7.43) —
        // the itemized disclosure of every pure non-cash reclassification
        // entry's lines, excluded from all four buckets above.
        const reclassLines = await this.fetchNonCashReclassificationLines(
          tx,
          tenantId,
          legalEntityId,
          cashAccountIds,
          dateFrom,
          dateTo,
        );
        const entriesByJournalEntryId = new Map<
          string,
          CashFlowNonCashReclassificationEntry
        >();
        let reclassNetSumMinor = 0;
        let reclassGrossAbsSumMinor = 0;
        for (const line of reclassLines) {
          const amountMinor = line.creditMinor - line.debitMinor;
          reclassNetSumMinor += amountMinor;
          reclassGrossAbsSumMinor += Math.abs(amountMinor);
          let entry = entriesByJournalEntryId.get(line.journalEntryId);
          if (!entry) {
            entry = {
              journalEntryId: line.journalEntryId,
              journalNumber: line.journalNumber,
              transactionDate: line.transactionDate,
              lines: [],
            };
            entriesByJournalEntryId.set(line.journalEntryId, entry);
          }
          entry.lines.push({
            accountId: line.accountId,
            code: line.accountCode,
            name: line.accountName,
            type: line.accountType,
            cashFlowCategory: line.cashFlowCategory,
            amountMinor,
          });
        }

        // §5.2's proof, checked defensively at runtime (proposal §13) —
        // every pure non-cash reclassification entry's own lines sum to
        // exactly zero by construction (the entry balances and touches
        // no cash/income account), so the total across every such entry
        // in the window must also be exactly zero. A nonzero result here
        // indicates the query itself is miswritten, not a business
        // condition — same "should be impossible, surface loudly"
        // convention as every other identity check in this file.
        if (reclassNetSumMinor !== 0) {
          throw new Error(
            `Non-cash reclassifications failed to net to zero: total (${reclassNetSumMinor}). This should be impossible by construction (proposal §5.2) — surfacing as a hard failure rather than returning a wrong report.`,
          );
        }

        return {
          dateFrom,
          dateTo,
          periodId,
          legalEntityId,
          openingCashMinor,
          netCashMovementMinor,
          closingCashMinor,
          operatingMinor,
          investingMinor,
          financingMinor,
          unclassifiedMinor,
          hasUnclassifiedAccounts: unclassifiedAccounts.length > 0,
          unclassifiedAccountCount: unclassifiedAccounts.length,
          unclassifiedAccounts,
          reconciled: true,
          nonCashReclassifications: {
            // Each dollar of a reclassification appears once on each
            // (paired) side of the entries that make it up (proposal
            // §15.3) — dividing the summed absolute contribution by 2
            // yields the at-a-glance magnitude figure without double-
            // counting the two legs of the same reclassification.
            totalGrossMinor: reclassGrossAbsSumMinor / 2,
            entries: Array.from(entriesByJournalEntryId.values()),
          },
        };
      },
      undefined,
      REPORT_TX_CONFIG,
    );
  }

  // ---------------------------------------------------------------------
  // Chart-of-accounts hierarchy — §7 of the proposal, shared by both
  // statements. Operates on a single-type row set at a time (§7.2/§8.3/
  // §18: each of ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE gets its own
  // independent forest — a mismatched-type child always promotes into
  // the forest matching ITS OWN type, never a differently-typed parent's,
  // so P&L's Revenue and Expense are built as two independent forests
  // exactly like Balance Sheet's three sections, never combined into one
  // set where a REVENUE row could attach under an EXPENSE parent).
  // ---------------------------------------------------------------------

  /** §7.2/§7.3/§7.4 — builds the forest for one type's row set and
   * returns it together with the flat (non-hierarchical) total, having
   * defensively verified the two agree (§7.4's proof, checked at
   * runtime). `sectionLabel` is only used in the (should-be-impossible)
   * error message. */
  private buildSection(
    rows: RawAccountRow[],
    sectionLabel: string,
  ): { roots: StatementNode[]; totalMinor: number } {
    const roots = this.buildForest(rows);
    const flatTotalMinor = this.sumOwnBalance(rows);
    const rootTotalMinor = roots.reduce((sum, n) => sum + n.subtotalMinor, 0);
    if (flatTotalMinor !== rootTotalMinor) {
      throw new Error(
        `${sectionLabel} hierarchy rollup failed to reconcile: flat total (${flatTotalMinor}) != hierarchical root total (${rootTotalMinor}). This should be impossible by construction (§7.4) — surfacing as a hard failure rather than returning a wrong report.`,
      );
    }
    return { roots, totalMinor: flatTotalMinor };
  }

  /** §7.2 — tree construction with the type-mismatch promotion rule, and
   * §7.3's bottom-up (post-order) subtotal computation. A `visiting` set
   * guards against a cycle that §2.3 of the proposal already proves is
   * structurally impossible (parentId can only ever reference an account
   * that already existed before this one was created, and no endpoint
   * ever mutates parentId post-creation) — a defensive hard failure
   * rather than an infinite loop, matching this codebase's "surface an
   * invariant violation loudly" convention. */
  private buildForest(rows: RawAccountRow[]): StatementNode[] {
    const nodeById = new Map<string, StatementNode>();
    for (const r of rows) {
      nodeById.set(r.accountId, {
        accountId: r.accountId,
        accountCode: r.accountCode,
        accountName: r.accountName,
        accountType: r.accountType,
        isActive: r.isActive,
        ownBalanceMinor: r.ownBalanceMinor,
        subtotalMinor: r.ownBalanceMinor,
        children: [],
      });
    }

    const roots: StatementNode[] = [];
    for (const r of rows) {
      const node = nodeById.get(r.accountId)!;
      // §7.2: attach as a child only when the account's true parentId
      // is present in THIS single-type row set. A null parentId, or a
      // parentId pointing at an account of a different type (§2.4 —
      // structurally possible, currently unused in production data),
      // both promote the account to a root of its own type's forest —
      // never dropped, never attached under a differently-typed parent,
      // never counted twice.
      if (r.parentId && nodeById.has(r.parentId)) {
        nodeById.get(r.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const visiting = new Set<string>();
    const computeSubtotal = (node: StatementNode): number => {
      if (visiting.has(node.accountId)) {
        throw new Error(
          `Chart of accounts hierarchy cycle detected at account ${node.accountId} — this should be structurally impossible (parentId can only reference an already-existing account and is never mutated after creation).`,
        );
      }
      visiting.add(node.accountId);
      node.subtotalMinor =
        node.ownBalanceMinor +
        node.children.reduce((sum, child) => sum + computeSubtotal(child), 0);
      visiting.delete(node.accountId);
      return node.subtotalMinor;
    };
    roots.forEach(computeSubtotal);

    return roots;
  }

  /** §7.5 — a node is kept if its own balance is nonzero, if
   * `includeZeroBalance` is true, or if it is a necessary structural
   * ancestor of a kept descendant. Applied AFTER `subtotalMinor` is
   * already computed on the full unfiltered tree (`buildSection`) — this
   * filter only affects what is displayed, never any total. */
  private applyZeroBalanceFilter(
    roots: StatementNode[],
    includeZeroBalance: boolean,
  ): StatementNode[] {
    if (includeZeroBalance) return roots;
    const filterNode = (node: StatementNode): StatementNode | null => {
      const children = node.children
        .map(filterNode)
        .filter((c): c is StatementNode => c !== null);
      if (node.ownBalanceMinor === 0 && children.length === 0) return null;
      return { ...node, children };
    };
    return roots.map(filterNode).filter((n): n is StatementNode => n !== null);
  }

  private sumOwnBalance(rows: RawAccountRow[]): number {
    return rows.reduce((sum, r) => sum + r.ownBalanceMinor, 0);
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /** §6.3/§8.2/§9.2's normal-balance-by-type mapping, as a sign: +1 for
   * a DEBIT-normal type (ASSET, EXPENSE — debitMinor - creditMinor), -1
   * for a CREDIT-normal type (LIABILITY, EQUITY, REVENUE — creditMinor -
   * debitMinor). Duplicated from GeneralLedgerService.signFor — see this
   * file's top comment for why. */
  private signFor(type: ChartOfAccount["type"]): 1 | -1 {
    return type === "ASSET" || type === "EXPENSE" ? 1 : -1;
  }

  /** Deterministic "today": current UTC calendar date, computed once in
   * application code — never SQL CURRENT_DATE/NOW() — same convention as
   * GeneralLedgerService.todayUtc and every other report in this
   * codebase. */
  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }

  /** §5.1/§5.2's periodId resolution — scoped by (tenantId,
   * legalEntityId), 404 if out of scope. A period's OPEN/CLOSED status
   * never affects whether this resolves — read access never depends on
   * postability (§2.7/§9.4 of the proposal), identical convention to
   * GeneralLedgerService.resolvePeriodInScope, duplicated here for the
   * same cross-module-coupling reasoning as signFor above. */
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

  private mapRawRows(
    raw: Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      is_active: boolean;
      parent_id: string | null;
      raw_debit: unknown;
      raw_credit: unknown;
    }>,
    type: ChartOfAccount["type"],
  ): RawAccountRow[] {
    const sign = this.signFor(type);
    return raw.map((r) => ({
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type,
      isActive: r.is_active,
      parentId: r.parent_id,
      ownBalanceMinor:
        sign * (this.toNumber(r.raw_debit) - this.toNumber(r.raw_credit)),
    }));
  }

  /** Cumulative (life-to-date, no lower bound) balance per account of
   * `type`, through `asOf` inclusive — Balance Sheet's own query shape
   * (§8.2/§9.1), the same `<= asOf` shape `GeneralLedgerService.
   * getTrialBalance` already uses, generalized from "every type" to one
   * `type` at a time and additionally carrying `parent_id` for §7's
   * hierarchy. */
  private async fetchTypeBalancesAsOf(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    type: ChartOfAccount["type"],
    asOf: string,
  ): Promise<RawAccountRow[]> {
    const raw = (await tx.execute(sql`
      SELECT
        coa.id AS account_id,
        coa.code AS account_code,
        coa.name AS account_name,
        coa.type AS account_type,
        coa.is_active AS is_active,
        coa.parent_id AS parent_id,
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
        AND coa.type = ${type}
      GROUP BY coa.id, coa.code, coa.name, coa.type, coa.is_active, coa.parent_id
      ORDER BY coa.code ASC
    `)) as unknown as Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      is_active: boolean;
      parent_id: string | null;
      raw_debit: unknown;
      raw_credit: unknown;
    }>;
    return this.mapRawRows(raw, type);
  }

  /** Balance per account of `type`, strictly before `beforeDate` (no
   * lower bound) — §9.3's `priorPeriodsMinor`, the exact query shape of
   * `GeneralLedgerService.rawTotalsBefore`, generalized from one
   * `accountId` to a per-type `GROUP BY`. */
  private async fetchTypeBalancesBefore(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    type: ChartOfAccount["type"],
    beforeDate: string,
  ): Promise<RawAccountRow[]> {
    const raw = (await tx.execute(sql`
      SELECT
        coa.id AS account_id,
        coa.code AS account_code,
        coa.name AS account_name,
        coa.type AS account_type,
        coa.is_active AS is_active,
        coa.parent_id AS parent_id,
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
          AND je.transaction_date < ${beforeDate}::date
      ) pl ON pl.account_id = coa.id
      WHERE coa.tenant_id = ${tenantId}
        AND coa.legal_entity_id = ${legalEntityId}
        AND coa.type = ${type}
      GROUP BY coa.id, coa.code, coa.name, coa.type, coa.is_active, coa.parent_id
      ORDER BY coa.code ASC
    `)) as unknown as Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      is_active: boolean;
      parent_id: string | null;
      raw_debit: unknown;
      raw_credit: unknown;
    }>;
    return this.mapRawRows(raw, type);
  }

  /** Balance per account of `type`, within the inclusive
   * `[dateFrom, dateTo]` window (`dateFrom` may be null — "from account
   * inception") — P&L's own movement window (§6.2) and §9.3's
   * `currentPeriodMinor`, the exact query shape of
   * `GeneralLedgerService.rawTotalsWithinRange`, generalized from one
   * `accountId` to a per-type `GROUP BY`. */
  private async fetchTypeBalancesWithinRange(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    type: ChartOfAccount["type"],
    dateFrom: string | null,
    dateTo: string,
  ): Promise<RawAccountRow[]> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const raw = (await tx.execute(sql`
      SELECT
        coa.id AS account_id,
        coa.code AS account_code,
        coa.name AS account_name,
        coa.type AS account_type,
        coa.is_active AS is_active,
        coa.parent_id AS parent_id,
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
          ${lowerBound}
          AND je.transaction_date <= ${dateTo}::date
      ) pl ON pl.account_id = coa.id
      WHERE coa.tenant_id = ${tenantId}
        AND coa.legal_entity_id = ${legalEntityId}
        AND coa.type = ${type}
      GROUP BY coa.id, coa.code, coa.name, coa.type, coa.is_active, coa.parent_id
      ORDER BY coa.code ASC
    `)) as unknown as Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      is_active: boolean;
      parent_id: string | null;
      raw_debit: unknown;
      raw_credit: unknown;
    }>;
    return this.mapRawRows(raw, type);
  }

  // ---------------------------------------------------------------------
  // Cash Flow Statement helpers — docs/finance-work-item-cash-flow-
  // statement-proposal.md §5/§8/§17.
  // ---------------------------------------------------------------------

  /** §8 — the authoritative set of cash/bank GL account ids for a legal
   * entity: every `bank_cash_accounts` row's `glAccountId`, regardless of
   * `isActive` (a reversible toggle, not a deletion — filtering on it
   * would silently drop real historical cash movement from any window
   * predating a deactivation). `bank_cash_accounts_gl_account_unique`
   * guarantees this is a clean set, never ambiguous. */
  private async fetchCashAccountIds(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string[]> {
    const raw = (await tx.execute(sql`
      SELECT DISTINCT gl_account_id AS account_id
      FROM bank_cash_accounts
      WHERE tenant_id = ${tenantId} AND legal_entity_id = ${legalEntityId}
    `)) as unknown as Array<{ account_id: string }>;
    return raw.map((r) => r.account_id);
  }

  /** Builds a `uuid[]`-typed SQL fragment from `cashAccountIds`, safe to
   * splice directly into `ANY(...)`/set-membership predicates below.
   *
   * NOT `sql\`${cashAccountIds}::uuid[]\`` — drizzle-orm's postgres.js
   * driver does not serialize a plain JS array parameter as a Postgres
   * array literal the way the `postgres` package's OWN tagged-template
   * does; passed through `db.execute()` it instead reaches Postgres as
   * an anonymous composite (`record`), and `record::uuid[]` is not a
   * valid cast — every call site that did this failed at the database
   * with `cannot cast type record to uuid[]` (caught during this work
   * item's own e2e verification, fixed here). Building the array
   * explicitly via `ARRAY[$1::uuid, $2::uuid, ...]` (through
   * `sql.join`) sidesteps the driver's array-serialization gap
   * entirely — each element is bound as an ordinary scalar parameter,
   * which the driver already serializes correctly. An empty
   * `cashAccountIds` (a legal entity with zero configured Bank/Cash
   * Accounts) needs its own explicit `ARRAY[]::uuid[]` literal —
   * `ARRAY[]` with no elements has no type Postgres can infer on its
   * own. */
  private cashAccountIdsFragment(cashAccountIds: string[]) {
    if (cashAccountIds.length === 0) {
      return sql`ARRAY[]::uuid[]`;
    }
    return sql`ARRAY[${sql.join(
      cashAccountIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
  }

  /** Aggregate cash movement across every id in `cashAccountIds`,
   * strictly before `beforeDate` — the exact `fetchTypeBalancesBefore`
   * query shape, generalized from "every account of a type" to "every
   * account in an explicit id set." Cash/bank accounts are always
   * `ASSET`-typed (validated at `bank_cash_accounts` create/update time),
   * so the sign is unconditionally `+1` (debit-normal) — no per-row
   * `signFor` branching is needed here, unlike `fetchTypeBalancesBefore`. */
  private async fetchCashTotalBefore(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    cashAccountIds: string[],
    beforeDate: string,
  ): Promise<number> {
    const raw = (await tx.execute(sql`
      SELECT COALESCE(SUM(jl.debit_minor), 0) AS raw_debit,
             COALESCE(SUM(jl.credit_minor), 0) AS raw_credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND jl.account_id = ANY(${this.cashAccountIdsFragment(cashAccountIds)})
        AND je.transaction_date < ${beforeDate}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    return this.toNumber(raw[0]?.raw_debit) - this.toNumber(raw[0]?.raw_credit);
  }

  /** Aggregate cash movement across `cashAccountIds`, within the
   * inclusive `[dateFrom, dateTo]` window (`dateFrom` may be null —
   * "from account inception") — the exact `fetchTypeBalancesWithinRange`
   * query shape, generalized to an explicit id set. */
  private async fetchCashTotalWithinRange(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    cashAccountIds: string[],
    dateFrom: string | null,
    dateTo: string,
  ): Promise<number> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const raw = (await tx.execute(sql`
      SELECT COALESCE(SUM(jl.debit_minor), 0) AS raw_debit,
             COALESCE(SUM(jl.credit_minor), 0) AS raw_credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND jl.account_id = ANY(${this.cashAccountIdsFragment(cashAccountIds)})
        ${lowerBound}
        AND je.transaction_date <= ${dateTo}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    return this.toNumber(raw[0]?.raw_debit) - this.toNumber(raw[0]?.raw_credit);
  }

  /** Aggregate cash movement across `cashAccountIds`, cumulative (no
   * lower bound) through `asOf` inclusive — the exact
   * `fetchTypeBalancesAsOf` query shape, generalized to an explicit id
   * set. Used for `closingCashMinor`, independently of
   * `openingCashMinor + netCashMovementMinor`, so the identity check in
   * `getCashFlow` is a genuine cross-check (matching Balance Sheet's own
   * independent-query identity), not a tautology. */
  private async fetchCashTotalAsOf(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    cashAccountIds: string[],
    asOf: string,
  ): Promise<number> {
    const raw = (await tx.execute(sql`
      SELECT COALESCE(SUM(jl.debit_minor), 0) AS raw_debit,
             COALESCE(SUM(jl.credit_minor), 0) AS raw_credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND jl.account_id = ANY(${this.cashAccountIdsFragment(cashAccountIds)})
        AND je.transaction_date <= ${asOf}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    return this.toNumber(raw[0]?.raw_debit) - this.toNumber(raw[0]?.raw_credit);
  }

  /** Proposal §5.1/§17 — per non-cash ASSET/LIABILITY/EQUITY account,
   * within `[dateFrom, dateTo]`, the debit/credit sum restricted to
   * lines belonging to a "reconciling entry" (has ≥1 cash line, per
   * `cashAccountIds`, or ≥1 REVENUE/EXPENSE line) — lines belonging to a
   * pure non-cash reclassification entry are excluded here (they are
   * fetched separately by `fetchNonCashReclassificationLines`). One
   * additional CTE pass over the same window's `journal_lines` rows
   * already being scanned (§17's performance analysis) — not a new
   * per-account re-scan. `entry_flags` computes, once per journal entry
   * in the window, whether it has a cash line and/or an income line;
   * the outer query then sums only the lines of entries where at least
   * one of those is true, via `FILTER`. */
  private async fetchCashFlowWorkingCapital(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    cashAccountIds: string[],
    dateFrom: string | null,
    dateTo: string,
  ): Promise<CashFlowWorkingCapitalRow[]> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const raw = (await tx.execute(sql`
      WITH window_lines AS (
        SELECT jl.journal_entry_id, jl.account_id, jl.debit_minor, jl.credit_minor
        FROM journal_lines jl
        INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.tenant_id = ${tenantId}
          AND je.tenant_id = ${tenantId}
          AND je.legal_entity_id = ${legalEntityId}
          AND je.status = 'POSTED'
          ${lowerBound}
          AND je.transaction_date <= ${dateTo}::date
      ),
      entry_flags AS (
        SELECT wl.journal_entry_id,
               BOOL_OR(wl.account_id = ANY(${this.cashAccountIdsFragment(cashAccountIds)})) AS has_cash_line,
               BOOL_OR(coa.type IN ('REVENUE', 'EXPENSE')) AS has_income_line
        FROM window_lines wl
        INNER JOIN chart_of_accounts coa ON coa.id = wl.account_id
        GROUP BY wl.journal_entry_id
      )
      SELECT
        coa.id AS account_id,
        coa.code AS account_code,
        coa.name AS account_name,
        coa.type AS account_type,
        coa.cash_flow_category AS cash_flow_category,
        COALESCE(SUM(wl.debit_minor) FILTER (WHERE ef.has_cash_line OR ef.has_income_line), 0) AS reconciling_debit,
        COALESCE(SUM(wl.credit_minor) FILTER (WHERE ef.has_cash_line OR ef.has_income_line), 0) AS reconciling_credit
      FROM chart_of_accounts coa
      LEFT JOIN window_lines wl ON wl.account_id = coa.id
      LEFT JOIN entry_flags ef ON ef.journal_entry_id = wl.journal_entry_id
      WHERE coa.tenant_id = ${tenantId}
        AND coa.legal_entity_id = ${legalEntityId}
        AND coa.type IN ('ASSET', 'LIABILITY', 'EQUITY')
        AND NOT (coa.id = ANY(${this.cashAccountIdsFragment(cashAccountIds)}))
      GROUP BY coa.id, coa.code, coa.name, coa.type, coa.cash_flow_category
      ORDER BY coa.code ASC
    `)) as unknown as Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      cash_flow_category: "OPERATING" | "INVESTING" | "FINANCING" | null;
      reconciling_debit: unknown;
      reconciling_credit: unknown;
    }>;
    return raw.map((r) => ({
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type,
      cashFlowCategory: r.cash_flow_category,
      reconcilingDebitMinor: this.toNumber(r.reconciling_debit),
      reconcilingCreditMinor: this.toNumber(r.reconciling_credit),
    }));
  }

  /** Proposal §5.1/§15.3 — every line of every pure non-cash
   * reclassification entry (zero cash lines, zero REVENUE/EXPENSE lines)
   * within `[dateFrom, dateTo]`, for the itemized `nonCashReclassifications`
   * disclosure. Same `entry_flags` CTE shape as
   * `fetchCashFlowWorkingCapital`, but selecting the OPPOSITE entry set
   * (`NOT has_cash_line AND NOT has_income_line`) and every line of each
   * (not just ASSET/LIABILITY/EQUITY lines summed per account — by
   * definition a pure reclassification entry has no REVENUE/EXPENSE or
   * cash lines to exclude anyway). */
  private async fetchNonCashReclassificationLines(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    cashAccountIds: string[],
    dateFrom: string | null,
    dateTo: string,
  ): Promise<CashFlowReclassificationRawLine[]> {
    const lowerBound = dateFrom
      ? sql`AND je.transaction_date >= ${dateFrom}::date`
      : sql``;
    const raw = (await tx.execute(sql`
      WITH window_entries AS (
        SELECT je.id, je.journal_number, je.transaction_date
        FROM journal_entries je
        WHERE je.tenant_id = ${tenantId}
          AND je.legal_entity_id = ${legalEntityId}
          AND je.status = 'POSTED'
          ${lowerBound}
          AND je.transaction_date <= ${dateTo}::date
      ),
      entry_flags AS (
        SELECT jl.journal_entry_id,
               BOOL_OR(jl.account_id = ANY(${this.cashAccountIdsFragment(cashAccountIds)})) AS has_cash_line,
               BOOL_OR(coa.type IN ('REVENUE', 'EXPENSE')) AS has_income_line
        FROM journal_lines jl
        INNER JOIN window_entries we ON we.id = jl.journal_entry_id
        INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE jl.tenant_id = ${tenantId}
        GROUP BY jl.journal_entry_id
      )
      SELECT
        we.id AS journal_entry_id,
        we.journal_number,
        we.transaction_date,
        jl.account_id,
        coa.code AS account_code,
        coa.name AS account_name,
        coa.type AS account_type,
        coa.cash_flow_category AS cash_flow_category,
        jl.debit_minor,
        jl.credit_minor
      FROM entry_flags ef
      INNER JOIN window_entries we ON we.id = ef.journal_entry_id
      INNER JOIN journal_lines jl ON jl.journal_entry_id = ef.journal_entry_id
      INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE ef.has_cash_line = false
        AND ef.has_income_line = false
        AND jl.tenant_id = ${tenantId}
      ORDER BY we.transaction_date ASC, we.journal_number ASC, jl.line_number ASC
    `)) as unknown as Array<{
      journal_entry_id: string;
      journal_number: string | null;
      transaction_date: string;
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: ChartOfAccount["type"];
      cash_flow_category: "OPERATING" | "INVESTING" | "FINANCING" | null;
      debit_minor: unknown;
      credit_minor: unknown;
    }>;
    return raw.map((r) => ({
      journalEntryId: r.journal_entry_id,
      journalNumber: r.journal_number,
      transactionDate: r.transaction_date,
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type,
      cashFlowCategory: r.cash_flow_category,
      debitMinor: this.toNumber(r.debit_minor),
      creditMinor: this.toNumber(r.credit_minor),
    }));
  }
}

// ---------------------------------------------------------------------
// Result shapes — §5/§8.5 of the proposal.
// ---------------------------------------------------------------------

interface RawAccountRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  isActive: boolean;
  parentId: string | null;
  ownBalanceMinor: number;
}

export interface StatementNode {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  isActive: boolean;
  ownBalanceMinor: number;
  subtotalMinor: number;
  children: StatementNode[];
}

export interface StatementSection {
  roots: StatementNode[];
  totalMinor: number;
}

export interface ProfitAndLossResult {
  dateFrom: string | null;
  dateTo: string;
  periodId: string | null;
  legalEntityId: string;
  revenue: StatementSection;
  expense: StatementSection;
  netIncomeMinor: number;
}

export interface AccumulatedEarnings {
  priorPeriodsMinor: number | null;
  currentPeriodMinor: number | null;
  cumulativeMinor: number;
}

export interface BalanceSheetEquitySection extends StatementSection {
  recordedEquityMinor: number;
  accumulatedEarnings: AccumulatedEarnings;
  totalEquityMinor: number;
}

export interface BalanceSheetIdentity {
  assetsMinor: number;
  liabilitiesPlusEquityMinor: number;
  differenceMinor: number;
  reconciled: boolean;
}

export interface BalanceSheetResult {
  asOf: string;
  periodId: string | null;
  legalEntityId: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: BalanceSheetEquitySection;
  identity: BalanceSheetIdentity;
}

// ---------------------------------------------------------------------
// Cash Flow Statement result shapes — docs/finance-work-item-cash-flow-
// statement-proposal.md §15.2.
// ---------------------------------------------------------------------

interface CashFlowWorkingCapitalRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null;
  reconcilingDebitMinor: number;
  reconcilingCreditMinor: number;
}

interface CashFlowReclassificationRawLine {
  journalEntryId: string;
  journalNumber: string | null;
  transactionDate: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: ChartOfAccount["type"];
  cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null;
  debitMinor: number;
  creditMinor: number;
}

export interface CashFlowUnclassifiedAccount {
  accountId: string;
  code: string;
  name: string;
  type: ChartOfAccount["type"];
  movementMinor: number;
}

export interface CashFlowReclassificationLine {
  accountId: string;
  code: string;
  name: string;
  type: ChartOfAccount["type"];
  cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null;
  amountMinor: number;
}

export interface CashFlowNonCashReclassificationEntry {
  journalEntryId: string;
  journalNumber: string | null;
  transactionDate: string;
  lines: CashFlowReclassificationLine[];
}

export interface CashFlowNonCashReclassifications {
  totalGrossMinor: number;
  entries: CashFlowNonCashReclassificationEntry[];
}

export interface CashFlowResult {
  dateFrom: string | null;
  dateTo: string;
  periodId: string | null;
  legalEntityId: string;
  openingCashMinor: number;
  netCashMovementMinor: number;
  closingCashMinor: number;
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  unclassifiedMinor: number;
  hasUnclassifiedAccounts: boolean;
  unclassifiedAccountCount: number;
  unclassifiedAccounts: CashFlowUnclassifiedAccount[];
  reconciled: boolean;
  nonCashReclassifications: CashFlowNonCashReclassifications;
}
