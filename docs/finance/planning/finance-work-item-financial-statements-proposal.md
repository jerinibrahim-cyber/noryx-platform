# Finance Work Item — Financial Statements: Profit &amp; Loss and Balance Sheet

Status: **PROPOSAL — awaiting CTO review.** No implementation, schema, migration, test, commit, or push has occurred in producing this document. Repository baseline: HEAD `91b9d47`.

Per CTO decision "PROCEED TO FINANCIAL STATEMENTS PROPOSAL": this document is a design proposal only, produced after direct inspection of the actual repository (not assumption from the prior reassessment). Every open question the CTO's message asked this proposal to address (§8 items A–J) is resolved below by inspection where the repository could answer it; §11 lists what, if anything, is left.

---

## 1. Problem Statement

Sphere Finance can post transactions (Accounting Core), reconcile two full subledgers to the general ledger (AP-1d, AR-1d), and produce a Trial Balance and per-account Ledger/Balance (2d, `general-ledger`). It cannot yet answer the two questions every other Finance stakeholder needs answered: _did the business make money, and what does it own versus owe._ There is no Profit & Loss statement and no Balance Sheet anywhere in the repository. Per the CTO-approved reassessment, this is now the next Finance work item.

The central design difficulty is not the aggregation arithmetic — Trial Balance already proves the codebase can group `journal_lines` by account and by type. It is two things the CTO's decision explicitly called out: (1) presenting the result through the chart of accounts' parent/child hierarchy without double-counting or losing GL totals, and (2) presenting an accumulated-earnings/equity figure that is correct across multiple periods **without** inventing a closing-entry mechanism that does not exist today. Both are resolved below directly from what the repository already proves, not by adding new posting semantics.

---

## 2. Actual Repository Findings (HEAD `91b9d47`)

Everything in this section was confirmed by reading the live schema, service, and constraint source in this pass — not carried over from the prior reassessment.

**2.1 — `chart_of_accounts` (`schema.ts` lines 58–98).**
`type: accountTypeEnum` (`ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE`), `parentId: uuid` nullable, self-referential, **not a Postgres FK** (app-validated in `AccountsService`, same cross-boundary-vs-in-service-table reasoning documented in the schema file — here it's in-service, so a real FK would have been possible, but the team deliberately chose app validation "so a bad parentId is a clean 400 rather than a raw constraint-violation error," per the schema comment). No `updatedAt`-driving update endpoint exists beyond `archive` (`isActive → false`) — accounts, including `parentId`, are **immutable post-creation**.

**2.2 — `AccountsService.create()` (`accounts.service.ts`).** The only validation on `parentId` is that it resolves to an existing account **in the same legal entity**. There is **no check that a child's `type` matches its parent's `type`**, and **no cycle check**. Confirmed by reading the full file and its DTO (`create-account.dto.ts`) — `parentId` is a bare `@IsUUID()`, nothing else.

**2.3 — Structural proof that the CoA graph is acyclic (a forest).** Because (a) `parentId` must reference an account that already exists at the moment the child is created (§2.2), (b) no endpoint ever mutates an existing account's `parentId` (§2.1), and (c) a new row's own `id` cannot be known before the insert completes, self-reference and every other cycle are structurally impossible — not merely untested. A child is always created strictly "after" its parent in insertion order, so the graph is provably a forest of trees rooted at accounts with `parentId = null`. This resolves the "prevent double-counting" and "no infinite recursion" concerns directly, without adding a new constraint.

**2.4 — Type mismatch between parent and child is possible but unused.** Grepped every AP/AR/Core test fixture and source file in the repository (`grep -rn "parentId"`): the only place `parentId` is exercised at all today is one cross-legal-entity-rejection test in `accounts.e2e-spec.ts`. No AP, AR, or Core fixture anywhere sets it. The hierarchy is a designed, schema-level capability that is currently a green field in practice. §7 defines the (safe, inferable) behavior for the type-mismatch edge case explicitly, since nothing in the existing system either exercises or forbids it.

**2.5 — A parent account can itself receive direct postings.** `journal_lines.accountId` is a plain FK into `chart_of_accounts` (`schema.ts` line 296) with no constraint that the referenced account is a leaf. Nothing in `JournalEntriesService`'s posting path checks whether an account has children before allowing a posting against it. §7's algorithm accounts for this explicitly (own-balance + subtree, not one or the other).

**2.6 — The double-entry balance invariant is DB-enforced, unconditionally, per entry.** `drizzle/constraints/002_balance_invariant_trigger.sql`: a deferred constraint trigger on both `journal_lines` and `journal_entries` calls `assert_journal_entry_balanced()`, which raises a hard Postgres exception if any `POSTED` entry's `SUM(debit_minor) <> SUM(credit_minor)`, or has fewer than 2 lines. This is unconditional — it holds for **every** posted entry, not just ones a report happens to check. §9 derives the Balance Sheet identity directly from this trigger, not from an assumption.

**2.7 — Accounting-period closure has zero effect on ledger data.** `AccountingPeriodsService.close()` (`accounting-periods.service.ts`) performs exactly one write: an atomic conditional `UPDATE accounting_periods SET status='CLOSED', closed_at=..., closed_by=...`. It never touches `journal_entries` or `journal_lines`, posts no entry, and zeroes no balance. `GeneralLedgerService`'s own doc comment independently confirms: "A period's OPEN/CLOSED status never affects whether \[a period lookup\] resolves — read access never depends on postability." §10 relies on this directly: closing a period changes what can be posted **into** it, never what a report **computes** from data already posted.

**2.8 — `GeneralLedgerService` (`general-ledger.service.ts`) is the direct structural template.** Confirmed by reading the full file:

- `REPORT_TX_CONFIG` (`{ isolationLevel: "repeatable read", accessMode: "read only" }`), exported from this file, already reused verbatim by AP-1d and AR-1d — the established pattern for any multi-statement financial report that must see one consistent snapshot.
- `signFor(type)`: `+1` for `ASSET`/`EXPENSE` (debit-normal), `-1` for `LIABILITY`/`EQUITY`/`REVENUE` (credit-normal) — the exact sign convention this proposal reuses for both statements.
- `getTrialBalance()`'s raw SQL is a single `GROUP BY coa.id` query over all `chart_of_accounts` rows for the legal entity, left-joined to a pre-filtered `journal_lines`/`journal_entries` subquery (`status = 'POSTED' AND transaction_date <= asOf`), with a **defensive runtime assertion** (`totalDebitMinor !== totalCreditMinor → throw`) before returning. This proposal's Balance Sheet reuses the identical query shape (point-in-time, no lower date bound) and adds an analogous defensive identity assertion (§9).
- `getBalance()`'s range/period/asOf query-mode selection (`isRangeMode` check, `periodId` → resolve `startDate`/`endDate`; else `dateFrom`/`dateTo`; else asOf-only) is the direct template for this proposal's P&L query modes (§6) and Balance Sheet query modes (§8).
- All three GL methods enforce tenant+legal-entity scoping via `requireTenantContext()` plus an explicit `legalEntityId` predicate in every query (never RLS alone) — reused unchanged (§12).

**2.9 — AP-1d/AR-1d's `glLiabilityBalance`/`glAssetBalance` pattern.** Both duplicate (not share) a small `signFor`-equivalent private helper and a control-account balance query, rather than importing from `GeneralLedgerService`. This proposal follows the same established convention: a new, independent service, not a refactor of `GeneralLedgerService` (§14).

**2.10 — Route/DTO conventions confirmed from `general-ledger/dto/*.ts`.** `LedgerQueryDto` and `AccountBalanceQueryDto` use custom `ValidatorConstraint`s to enforce mutual exclusion between `periodId` and an explicit date range, and (for Account Balance) between `asOf` and any range input. `TrialBalanceQueryDto` enforces `asOf` mutually exclusive with `periodId`, and deliberately has no date-range mode at all. §6/§8 reuse these exact patterns.

**2.11 — Module wiring confirmed from `app.module.ts`.** `GeneralLedgerModule` is imported directly into `AppModule` as a top-level sibling of `AccountsPayableModule`/`AccountsReceivableModule` — not nested under either. The new module in this proposal follows the same shape (§14).

**2.12 — `route-role-matrix.spec.ts`** currently discovers exactly 64 routes across 14 controllers (confirmed by reading the file's `describe` block and controller list). This proposal adds 1 controller / 2 routes, bringing the expected counts to **66 routes / 15 controllers**.

---

## 3. Explicit Non-Scope

- Cash Flow Statement (direct or indirect method) — explicitly deferred per CTO decision 4. No cash-flow tables, classification models, or APIs.
- Management reporting, consolidated/multi-entity reporting, comparative (prior-period or budget-vs-actual) columns, and export formats (PDF/Excel) — none of these are built.
- Any schema, migration, RLS, or constraint change. This is a pure read layer, confirmed necessary and sufficient by §2 — every input it needs already exists.
- Any change to AP, AR, or Accounting Core **posting** paths, including `AccountsService`, `JournalEntriesService`, and `AccountingPeriodsService`. This proposal reads their output only.
- A year-end closing-entry / period-close automation engine. Explicitly ruled out by CTO decision 3 and unnecessary per §9/§10's identity proof.
- Any change to `AccountsService.create()`'s `parentId` validation (e.g., adding a type-consistency or depth check). §7 handles the current, unconstrained hierarchy defensively at read time instead of proposing a write-side change, which would be out of scope for a read-layer work item.

---

## 4. Proposed APIs

Both routes are read-only, legal-entity-scoped, and open to all three finance roles — identical reasoning to `GeneralLedgerController`'s own doc comment ("no mutation route exists here, so there is no write-side RBAC distinction to make").

```
GET /v1/finance/financial-statements/profit-and-loss
GET /v1/finance/financial-statements/balance-sheet
```

Controller shape mirrors `GeneralLedgerController` exactly: `@Controller()` with no class-level prefix, full path on each `@Get(...)`, `@UseGuards(JwtAuthGuard, RolesGuard)`, `@Roles("finance.viewer", "finance.poster", "finance.admin")` per route, `tenantId`/`legalEntityId` resolved via `requireTenantContext(user, ...)`, never from a request param/body.

---

## 5. DTOs

**5.1 — `ProfitAndLossQueryDto`** (`financial-statements/dto/profit-and-loss-query.dto.ts`)

```ts
export class ProfitAndLossQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string; // open-ended (from inception) if omitted

  @IsOptional()
  @IsDateString()
  @IsSameOrAfterDate("dateFrom")
  dateTo?: string; // defaults to today (UTC) if omitted

  @IsOptional()
  @IsUUID()
  @Validate(PeriodIdExcludesDateRangeConstraint)
  periodId?: string; // mutually exclusive with dateFrom/dateTo — resolves both
}
```

Mirrors `LedgerQueryDto`'s exact `periodId`-excludes-date-range constraint and `dateFrom`/`dateTo` defaulting convention (§2.10). No `asOf` mode — a P&L is inherently a period statement, never a single point in time (this is the one place this proposal deliberately does _not_ offer an `asOf` mode, because there is no coherent single-point P&L, unlike Account Balance/Trial Balance/Balance Sheet).

**5.2 — `BalanceSheetQueryDto`** (`financial-statements/dto/balance-sheet-query.dto.ts`)

```ts
export class BalanceSheetQueryDto {
  @IsOptional()
  @IsDateString()
  @Validate(AsOfExcludesPeriodIdConstraint)
  asOf?: string; // point-in-time snapshot; defaults to today (UTC) if both are omitted

  @IsOptional()
  @IsUUID()
  periodId?: string; // mutually exclusive with asOf — resolves asOf = period.endDate AND enables the prior/current earnings split (§9.3)
}
```

Mirrors `TrialBalanceQueryDto`'s exact `asOf`-excludes-`periodId` constraint (§2.10) — a Balance Sheet, like a Trial Balance, is always a point-in-time snapshot, never a range.

Both DTOs get a `.dto.spec.ts` in the same shape as every existing report DTO spec in this codebase.

---

## 6. Profit &amp; Loss — Calculation Semantics

**6.1 — Scope.** Accounts of type `REVENUE` and `EXPENSE` only, for the resolved `[dateFrom, dateTo]` window (`periodId` resolves both from `accounting_periods`; otherwise `dateFrom` defaults to `null`/open-ended, `dateTo` defaults to today UTC — identical defaulting to `GeneralLedgerService.getLedger`).

**6.2 — Per-account movement.** For every `REVENUE`/`EXPENSE` account in the legal entity, compute `rawDebit`/`rawCredit` over `POSTED` lines with `transaction_date` inside `[dateFrom, dateTo]` (inclusive both ends) — the exact query shape of `GeneralLedgerService.rawTotalsWithinRange`, generalized from one `accountId` to a `GROUP BY coa.id` over the whole type set (same generalization Trial Balance already makes from `rawTotalsBefore` to a grouped point-in-time query, §2.8). This is a **movement window**, not a cumulative-since-inception balance — unlike Trial Balance/Balance Sheet, prior periods' revenue/expense activity must **not** leak into this period's P&L.

**6.3 — Signed balance per account.** `signedBalance = sign(type) * (rawDebit - rawCredit)`, `sign(REVENUE) = -1`, `sign(EXPENSE) = +1` (§2.8's `signFor`, reused verbatim). A positive `signedBalance` for `REVENUE` means net revenue recognized in the window; a positive `signedBalance` for `EXPENSE` means net expense incurred.

**6.4 — Net income.** `netIncomeMinor = revenueTotalMinor - expenseTotalMinor`, where `revenueTotalMinor`/`expenseTotalMinor` are each type's grand total after hierarchy rollup (§7) — algebraically identical to summing every individual account's `signedBalance` across both types, since the hierarchy rollup is a pure partition (§7.4).

**6.5 — Hierarchy.** Grouped per §7, restricted to the `{REVENUE, EXPENSE}` type set.

---

## 7. Chart-of-Accounts Hierarchy Algorithm (used by both statements)

This is the direct answer to CTO decision 2 and reassessment items A, H, and I.

**7.1 — Input.** For a given type set (`{REVENUE, EXPENSE}` for P&L, `{ASSET, LIABILITY, EQUITY}` for Balance Sheet) and a given legal entity, fetch every `chart_of_accounts` row of a type in the set, plus its computed `ownBalanceMinor` for the statement's date window (§6.2 for P&L, §9.2 for Balance Sheet) — one query per statement, `GROUP BY coa.id`, same shape as Trial Balance's existing query (§2.8). `isActive` is never filtered (matches Ledger/Balance/Trial Balance's existing convention, §2.8) — an archived account's historical contribution remains reportable.

**7.2 — Tree construction.** For each fetched account, look at its (unfiltered, real) `parentId`:

- If `parentId` is `null`, or `parentId` refers to an account **not present in this statement's type set** (i.e. a genuine type mismatch, §2.4 — structurally possible, currently unused), the account becomes a **root** of this statement's forest.
- Otherwise, it is attached as a child of that parent node, which is guaranteed already present in the fetched set (same type set membership).

This "promote to root when the true parent is out-of-set" rule is what makes the algorithm safe under the unenforced type-mismatch case from §2.4 without needing a write-side fix: a mismatched-type child is never silently dropped, never merged under a differently-typed parent, and never duplicated — it simply becomes its own top-level line in the statement it actually belongs to by its own `type`.

**7.3 — Per-node balances.** Each node carries two figures:

- `ownBalanceMinor` — that account's own direct postings only (§2.5 — a parent can have its own lines).
- `subtotalMinor` — `ownBalanceMinor + Σ(children's subtotalMinor)`, computed bottom-up (post-order).

**7.4 — Why this cannot double-count or lose GL totals.** §2.3 already proves the underlying `parentId` graph is a forest (acyclic). §7.2's promotion rule extends that guarantee to each statement's filtered subset: every fetched account appears in **exactly one** position in exactly one forest — either as a root, or as a child of exactly one other fetched account. Since `subtotalMinor` is a strict post-order sum with no node visited twice, `Σ(root subtotals) = Σ(ownBalanceMinor over every fetched account)` **by construction** — which is definitionally the same flat total Trial Balance's existing `GROUP BY` query would produce for that type set. §9.5/§15 make this an explicit, independently-checked test assertion, not just an algebraic claim.

**7.5 — Zero-balance filtering.** Mirrors `TrialBalanceQueryDto`'s existing `includeZeroBalance` flag (default `false`, §2.10) on **both** new DTOs. A node is included in the response if `ownBalanceMinor !== 0`, or `includeZeroBalance` is true, or it is a **necessary ancestor** of an included descendant (i.e., structural grouping labels are never suppressed just because the parent itself happens to have no direct postings). This is a straightforward post-order "keep if self qualifies or any kept child exists" filter, applied after `subtotalMinor` is already computed on the full unfiltered tree — the total is never affected by this display-only filter.

---

## 8. Balance Sheet — Calculation Semantics

**8.1 — Scope.** Accounts of type `ASSET`, `LIABILITY`, and `EQUITY` only, as of a single point in time (§5.2's `asOf`/`periodId` modes).

**8.2 — Per-account balance.** Life-to-date, exactly Trial Balance's own query shape (§2.8): `POSTED` lines with `transaction_date <= asOf`, no lower bound. `signedBalance = sign(type) * (rawDebit - rawCredit)`, `sign(ASSET) = +1`, `sign(LIABILITY) = -1`, `sign(EQUITY) = -1`.

**8.3 — Hierarchy.** Three independent forests (one per type), built per §7, restricted to `{ASSET}`, `{LIABILITY}`, `{EQUITY}` respectively — a mismatched-type child (§2.4/§7.2) always promotes into the forest matching **its own** type, never the parent's.

**8.4 — Accumulated earnings — presented, not recorded.** §9 derives this figure and its exact accounting meaning. It is **not** a `chart_of_accounts` row and carries no `accountId` — it is a computed report line, returned as its own explicit field (`accumulatedEarnings`, §8.5), not folded silently into any real Equity account's balance. Standard financial-statement convention places accumulated/retained earnings inside the Equity section of the Balance Sheet total, so `totalEquityMinor` (the figure the identity check in §9.5 uses) is `recordedEquityMinor + accumulatedEarningsMinor` — but the response keeps the two numbers separately labeled so a client can always tell which part came from actual posted Equity-type accounts versus which part is derived from cumulative Revenue/Expense activity (§9.1's requirement, restated).

**8.5 — Response shape** (illustrative — see §15 for the full response contract):

```jsonc
{
  "asOf": "2026-08-26",
  "periodId": null,
  "legalEntityId": "...",
  "assets": { "roots": [/* §7 tree */], "totalMinor": 500000 },
  "liabilities": { "roots": [/* §7 tree */], "totalMinor": 120000 },
  "equity": {
    "roots": [/* §7 tree, recorded EQUITY accounts only */],
    "recordedEquityMinor": 100000,
    "accumulatedEarnings": {
      "priorPeriodsMinor": 30000, // null when periodId is not supplied (§9.3)
      "currentPeriodMinor": 250000, // equals the full life-to-date figure when periodId is not supplied
      "cumulativeMinor": 280000,
    },
    "totalEquityMinor": 380000,
  },
  "identity": {
    // §9.5's independent check, always included
    "assetsMinor": 500000,
    "liabilitiesPlusEquityMinor": 500000,
    "differenceMinor": 0,
    "reconciled": true,
  },
}
```

---

## 9. Retained Earnings / Accumulated Earnings — Exact Accounting Identity

This directly answers CTO decision 3 in full: the identity is derived from the repository's own enforced invariant (§2.6), not asserted.

**9.1 — Starting point: the global balance invariant.** §2.6's DB trigger guarantees, for every single `POSTED` journal entry, `Σ debit_minor = Σ credit_minor` across that entry's lines. Because this holds per-entry, it trivially holds summed over **any** subset of `POSTED` entries — in particular, every entry with `transaction_date <= asOf`, for a fixed tenant and legal entity. So, for any `asOf`:

```
Σ_ASSET rawNet + Σ_LIABILITY rawNet + Σ_EQUITY rawNet + Σ_REVENUE rawNet + Σ_EXPENSE rawNet = 0
```

where `rawNet(account) = rawDebit(account) - rawCredit(account)` (the unsigned quantity every existing GL query already computes, e.g. `rawTotalsBefore`'s `netDelta`, §2.8).

**9.2 — Substituting each type's normal sign** (`signFor`, §2.8: `ASSET`/`EXPENSE = +1`, `LIABILITY`/`EQUITY`/`REVENUE = -1`, so `rawNet = sign * signedBalance` and thus `signedBalance = sign * rawNet`):

```
signedBalance(ASSET) − signedBalance(LIABILITY) − signedBalance(EQUITY) − signedBalance(REVENUE) + signedBalance(EXPENSE) = 0
```

Rearranged, defining `NetIncome(asOf) := signedBalance(REVENUE, asOf) − signedBalance(EXPENSE, asOf)` (life-to-date revenue minus life-to-date expense, matching intuitive P&L sign — a growing, profitable business has a positive `NetIncome`):

```
        Assets(asOf) = Liabilities(asOf) + Equity_recorded(asOf) + NetIncome(asOf)
```

This is **the** Balance Sheet identity this work item implements. It holds at every `asOf`, for any tenant/legal entity, **unconditionally** — it is a direct algebraic consequence of §2.6's DB-enforced constraint, not a property that depends on AP, AR, or any particular transaction shape. It requires no closing-entry step to be true today.

**9.3 — Prior-period vs. current-period split (CTO decision 3's items c/d).** When `periodId` is supplied (§5.2), the same additive decomposition `GeneralLedgerService.getBalance` already performs for a single account (§2.8's `isRangeMode`/`periodId` branch) is generalized to the `NetIncome` aggregate:

```
priorPeriodsMinor  = NetIncome computed strictly BEFORE period.startDate   (rawTotalsBefore's own query shape, §2.8, generalized across REVENUE+EXPENSE)
currentPeriodMinor = NetIncome computed WITHIN [period.startDate, period.endDate]  (rawTotalsWithinRange's shape, §2.8, same generalization)
cumulativeMinor    = priorPeriodsMinor + currentPeriodMinor  =  NetIncome(period.endDate)   — exact by additivity over disjoint, contiguous date ranges
```

When only `asOf` is supplied (no `periodId`), there is no period boundary to split on, so only `cumulativeMinor` (= `NetIncome(asOf)`) is reported and `priorPeriodsMinor`/`currentPeriodMinor` are `null` — this mirrors `AccountBalanceQueryDto`'s own asOf-mode, which likewise reports no `periodMovementMinor`-vs-`openingBalanceMinor` split unless a range/period is given.

**9.4 — Item (e): closed vs. open periods.** Per §2.7, closing a period changes nothing about what has already been posted. `NetIncome(asOf)` and the identity in §9.2 are **computed identically** whether the periods the underlying entries fall in are `OPEN` or `CLOSED` — closure affects only future postability, never any report's arithmetic. No special-casing for period status is needed or proposed anywhere in this design.

**9.5 — Independent verification, at both the service and the response level.** Mirroring `getTrialBalance`'s existing defensive assertion (§2.8): before returning, the service independently recomputes `Assets(asOf)` and `Liabilities(asOf) + Equity_recorded(asOf) + NetIncome(asOf)` from two separately-issued aggregate queries and throws a hard error (matching Trial Balance's own "this should be impossible... surfacing as a hard failure rather than returning a wrong report" wording and intent) if they disagree by even one minor unit. The **same** two independently-computed numbers are also returned in the response body's `identity` block (§8.5) — so a caller (or an e2e test, §15) can verify the identity without re-deriving it, and a mismatch is visible in the API response itself, not just in a server log.

**9.6 — Forward compatibility with a future closing-entry engine (not built now, per §3, but checked for safety).** If a later work item introduces period-close automation that posts entries zeroing `REVENUE`/`EXPENSE` into a real `EQUITY`-type "Retained Earnings" account, §9.1's identity **continues to hold with no code change**: the closing entries themselves are ordinary balanced `POSTED` journal lines, so they simply shift where the same total lives (`NetIncome` for the now-closed period drops toward zero as its `REVENUE`/`EXPENSE` accounts empty out; `Equity_recorded` rises by the same amount as the Retained Earnings account absorbs it). The identity in §9.2 was derived from §2.6's invariant alone, independent of _how_ any given balance came to be — this is a structural property of this design, not a coincidence, and is worth the CTO/architecture team being aware of when that future work item is scoped.

---

## 10. Period/As-Of Semantics Summary

|                              | P&L                                                     | Balance Sheet                                                                     |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Nature                       | movement over a window                                  | snapshot at a point in time                                                       |
| Default window/point         | `[inception, today UTC]`                                | `today UTC`                                                                       |
| `periodId` mode              | resolves `dateFrom`/`dateTo` from the period            | resolves `asOf = period.endDate`, additionally enables §9.3's prior/current split |
| Mutual exclusion             | `periodId` excludes `dateFrom`/`dateTo` (§2.10 pattern) | `periodId` excludes `asOf` (§2.10 pattern)                                        |
| Effect of period OPEN/CLOSED | none (§2.7/§9.4)                                        | none (§2.7/§9.4)                                                                  |

---

## 11. Security / RBAC

Identical, unmodified convention to every existing Finance read route (§2.8): `JwtAuthGuard` + `RolesGuard`, `@Roles("finance.viewer", "finance.poster", "finance.admin")` on both new routes (no write-side distinction — there is no mutation here to distinguish), `tenantId`/`legalEntityId` sourced only from `requireTenantContext(user, ...)` against the verified JWT, never a request param/body. Every SQL query carries an explicit `legalEntityId` predicate in addition to tenant RLS, per the standing convention documented in `schema.ts` and re-applied in every Finance service to date (RLS alone only isolates by tenant, not legal entity, §2.8/§2.11 context).

---

## 12. Transaction Isolation

Both new service methods run inside `withTenant(tenantId, async (tx) => {...}, undefined, REPORT_TX_CONFIG)` — the exact `REPEATABLE READ` / `READ ONLY` configuration exported from `general-ledger.service.ts` and already reused by AP-1d and AR-1d (§2.8). Each statement issues multiple SQL statements (resolve period if given, fetch the account+balance set, and — for Balance Sheet — the prior/current split queries); `REPORT_TX_CONFIG` guarantees all of them observe one consistent snapshot even under concurrent posting, exactly the reasoning already documented in that file's top comment. No new transaction-isolation design is introduced.

---

## 13. Implementation File Scope (for the CTO's review — not built in this pass)

```
services/sphere-finance/src/financial-statements/
  financial-statements.service.ts
  financial-statements.controller.ts
  financial-statements.module.ts
  dto/
    profit-and-loss-query.dto.ts        (+ .dto.spec.ts)
    balance-sheet-query.dto.ts          (+ .dto.spec.ts)

services/sphere-finance/src/app.module.ts          — import FinancialStatementsModule, sibling of GeneralLedgerModule (§2.11)
services/sphere-finance/src/route-role-matrix.spec.ts — add FinancialStatementsController, 64→66 routes, 14→15 controllers (§2.12)

services/sphere-finance/test/
  financial-statements-profit-and-loss.e2e-spec.ts
  financial-statements-balance-sheet.e2e-spec.ts
```

No file outside `financial-statements/` is modified except the two integration points above (module wiring, route-role-matrix) — consistent with every prior Finance work item's diff-scope discipline.

---

## 14. Migration / Schema Impact

**None.** Confirmed by §2: every input this proposal needs (`chart_of_accounts.type`/`parentId`, `journal_lines.debit_minor`/`credit_minor`/`account_id`, `journal_entries.status`/`transaction_date`, `accounting_periods.start_date`/`end_date`) already exists, is already indexed for exactly this access pattern (`journal_lines_account_idx`, `journal_entries_tenant_entity_idx`, §2.1 context), and is already read by `GeneralLedgerService` in the same shape this proposal reuses. No `drizzle-kit generate` step, no new RLS policy, no new constraint trigger.

---

## 15. Test Strategy

E2e against real PostgreSQL, mirroring the AP-1d/AR-1d/GL testing pattern (fixtures built through the real AP/AR/Core APIs, never inserted directly), covering at minimum:

1. **Hierarchy correctness, no double-counting.** A 3-level chain (grandparent → parent → leaf) where the _parent itself also has direct postings_ (§2.5/§7.3) — assert every node's `ownBalanceMinor` and `subtotalMinor` independently, and assert the root's `subtotalMinor` equals a flat `SUM` over all three accounts computed via a separate raw query.
2. **Type-mismatch promotion (§7.2/§2.4).** An account whose `parentId` points to an account of a _different_ type — assert it appears as its own root in its own type's forest, is never dropped, and never appears twice.
3. **P&L movement window vs. cumulative balance.** Revenue/expense activity both inside and outside `[dateFrom, dateTo]` — assert only in-window activity is reflected (this is the one place this proposal's behavior deliberately differs from Trial Balance's cumulative-since-inception model, §6.2).
4. **Balance Sheet identity across multiple periods (§9.5).** Postings spanning at least three accounting periods, at least one of them `CLOSED` — assert the identity holds at an `asOf` inside each period, and that closing a period changes nothing about the computed figures (§9.4) by computing the same `asOf` before and after a `close()` call.
5. **Prior/current earnings split (§9.3).** A `periodId`-mode request — assert `priorPeriodsMinor + currentPeriodMinor === cumulativeMinor`, and that `cumulativeMinor` matches an `asOf`-mode request for the same date.
6. **`includeZeroBalance` and structural-ancestor retention (§7.5).** A zero-balance parent with a nonzero-balance child — assert the parent still appears (as a structural label) even with `includeZeroBalance=false`.
7. **Legal-entity isolation** — same shape as every existing report's dedicated isolation test.
8. **RBAC** — covered structurally by `route-role-matrix.spec.ts`'s extended count (§2.12), same as every prior work item.
9. **Acyclic-by-construction is not re-tested** — §2.3 is a structural proof from the _absence_ of any mutation path, not a runtime property; there is nothing to assert at the API level beyond what §15.1/§15.2 already cover.

Full suite run twice for stability, matching the established post-implementation verification discipline from AP-1d/AR-1d.

---

## 16. Direct-PostgreSQL Verification Strategy

Following the same technique used to independently validate AR-1d's reconciliation fix: hand-written raw SQL, run via `psql` against the live e2e database, independent of this service's own query code.

1. A raw recomputation of `Assets(asOf)`, `Liabilities(asOf)`, `Equity_recorded(asOf)`, and `NetIncome(asOf)` — four independent `GROUP BY account_type` aggregates over `journal_lines`/`journal_entries` — cross-checked against both the API response and the response's own embedded `identity` block (§8.5/§9.5), for at least one `asOf` with real AP+AR+Core activity from the existing e2e fixtures.
2. A raw recomputation of the P&L `netIncomeMinor` for a specific `[dateFrom, dateTo]` window, cross-checked against the API response for the same window.
3. A raw structural query confirming the CoA forest property directly (`WITH RECURSIVE` walk from every root, confirming no row is visited twice and every row is reached) — an independent structural confirmation of §2.3's proof, not required for correctness but cheap and consistent with this engagement's "verify claims against actual code/schema/tests rather than documentation alone" practice.

---

## 17. Risks

- **Deep/pathological CoA chains.** §2.3 proves no cycle can exist, but nothing bounds chain _depth_. Real charts of accounts are shallow (2–4 levels); the recursive rollup (§7.3) is a single in-memory post-order pass over a result set already fully fetched in one query (no N+1), so even an unrealistically deep chain is cheap. A defensive recursion-depth guard (e.g. 50) is proposed as cheap insurance, not because a failure mode is expected.
- **Type-mismatch edge case is currently untested in production data.** §2.4 confirms no existing fixture exercises it. §7.2/§15.2 give it an explicit, safe, tested behavior before this ships, closing that gap rather than leaving it implicit.
- **Future closing-entry engine.** §9.6 shows the identity is forward-compatible by construction, but flags that the _presentation_ split (§8.4's `recordedEquityMinor` vs. `accumulatedEarnings`) should be revisited once such an engine exists, since at that point some of what is today "computed accumulated earnings" will have become a real, posted Equity balance — the totals will still be correct either way; only the labeling nuance changes.
- **None of the above blocks this work item.** All three are either already resolved above or are explicitly-scoped follow-on considerations, not open implementation risks.

---

## 18. CTO Decisions

Per instruction 10: none. Every item the CTO's message listed under "pay special attention to" (§8 A–J) was resolved directly from the repository in §2, and used to fully specify §6–§10 without leaving a genuine, unresolved product/accounting/architecture choice:

- **A/H/I (hierarchy aggregation, parent-with-own-lines, double-counting)** — §7, proven correct by construction (§7.4) and grounded in §2.3's structural acyclic proof.
- **B (debit/credit signs)** — §6.3/§8.2, reusing `GeneralLedgerService.signFor` unchanged.
- **C (P&L period boundaries)** — §6.1/§6.2, a movement window, not cumulative.
- **D (Balance Sheet as-of semantics)** — §8.1/§8.2, point-in-time, matching Trial Balance's own model.
- **E (closed vs. open periods)** — §2.7/§9.4, provably no effect.
- **F (revenue/expense cumulative treatment)** — §6.2 (P&L: windowed) vs. §9.1–§9.3 (Balance Sheet: cumulative, precisely because Equity/NetIncome is inherently a life-to-date concept) — the difference between the two statements' treatment is intentional and is the direct answer to why this isn't a single shared code path.
- **G (existing Equity balances)** — §8.4, kept separately labeled from computed accumulated earnings, never merged into a real account's balance.
- **J (retained earnings without closing entries)** — §9, the full derivation.

If, on review, the CTO judges any one of these resolutions to be a product decision rather than an engineering inference (most likely candidate: §7.2's type-mismatch promotion rule, or §8.4's presentation split), that specific point can be raised for explicit sign-off without reopening the rest of this proposal.

---

**STOP AFTER THIS PROPOSAL, per instruction.** No implementation, schema change, migration, test, commit, or push has occurred. Awaiting CTO review before implementation begins.
