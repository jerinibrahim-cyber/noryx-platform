# Cash Flow Statement — Implementation Completion Report

Status: **IMPLEMENTED AND VERIFIED**, not pushed. Reports what was actually
built and actually run — this is not a proposal document.

Authorization: CTO "IMPLEMENTATION" instruction (full implementation
authorization) against the CTO-approved architecture in
`docs/finance-work-item-cash-flow-statement-proposal.md` ("Account-Level
Classification, Entry-Level Reconciling Gate").

---

## 1. Baseline SHA

`40b32e967755f6dfb797583c298d59cea37aed3d`
("Add audit-trail and asOfTotals-isolation verification tests for Document
Reversal") — verified as `HEAD` before any change in this work item was
made.

## 2. Implementation commit SHA

`a6142be715df0cca6246aabffd107bb0410d2b58` — "Implement Cash Flow Statement
(indirect method)", committed 2026-09-14 22:17:56 +0000, on top of the
baseline above (parent = baseline SHA, single commit, no rebasing/squashing
of unrelated history).

## 3. Completion-report commit SHA

This document is committed as "Add Cash Flow Statement completion
report", immediately after the implementation commit (parent =
`a6142be715df0cca6246aabffd107bb0410d2b58`) — its own SHA is necessarily
not knowable from inside its own content (the SHA is a hash of the
committed content, including this file), so see `git log -1` / §21's
final `git log` output for the exact value. This document is committed
separately from the implementation, matching this codebase's established
convention (e.g. the Document-Level Reversal work item's own separate
completion-report commit `0eaa484`).

## 4. Exact files changed

14 files, 8544 insertions(+), 1 deletion(-) — `git diff --stat
40b32e967755f6dfb797583c298d59cea37aed3d..a6142be`:

- `docs/finance-work-item-cash-flow-statement-proposal.md` — new (525
  lines; the CTO-approved design document itself, committed alongside its
  own implementation — matching every other Finance work item's
  convention in this repo).
- `services/sphere-finance/drizzle/migrations/0021_chart_of_accounts_cash_flow_category.sql`
  — new migration.
- `services/sphere-finance/drizzle/migrations/meta/0021_snapshot.json`,
  `services/sphere-finance/drizzle/migrations/meta/_journal.json` — new /
  updated drizzle-kit metadata.
- `services/sphere-finance/src/db/schema.ts` — new `cashFlowCategoryEnum`
  - `chartOfAccounts.cashFlowCategory` column.
- `services/sphere-finance/src/accounts/dto/update-cash-flow-category.dto.ts`
  — new DTO.
- `services/sphere-finance/src/accounts/accounts.controller.ts`,
  `services/sphere-finance/src/accounts/accounts.service.ts` — new
  `PATCH accounts/:id/cash-flow-category` route + service method.
- `services/sphere-finance/src/financial-statements/dto/cash-flow-query.dto.ts`
  — new DTO.
- `services/sphere-finance/src/financial-statements/financial-statements.controller.ts`,
  `services/sphere-finance/src/financial-statements/financial-statements.service.ts`
  — new `GET financial-statements/cash-flow` route,
  `FinancialStatementsService.getCashFlow()`, 7 new private query helpers
  (including the `cashAccountIdsFragment` fix described in §14), and 7 new
  exported result-shape interfaces.
- `services/sphere-finance/src/route-role-matrix.spec.ts` — 2 new
  `EXPECTED` route entries + route-count doc comment (133 → 135 routes,
  still 25 controllers).
- `services/sphere-finance/test/accounts.e2e-spec.ts` — 7 new RBAC/audit
  e2e tests for the new PATCH route.
- `services/sphere-finance/test/financial-statements-cash-flow.e2e-spec.ts`
  — new file, 27 e2e tests.

Confirmed via `git status --short` (post-commit) that **no other file**
changed: `docs/hardening/`, `docs/finance-work-item-next-discovery.md`,
and `docs/finance-work-item-next-discovery-post-reversal.md` remain
untouched and untracked, exactly as they were before this work item
started.

## 5. Schema / migration changes

Exactly one nullable column, matching the proposal's stated minimal schema
impact — no new table, no new index beyond the enum type itself:

```sql
CREATE TYPE "public"."cash_flow_category" AS ENUM('OPERATING', 'INVESTING', 'FINANCING');
ALTER TABLE "chart_of_accounts" ADD COLUMN "cash_flow_category" "cash_flow_category";
```

`NULL` = "Unclassified" (no default, never silently coerced to
`OPERATING`). No `NOT NULL`, no `CHECK`, no FK — a plain nullable enum
column exactly as approved.

## 6. API / routes added

- `PATCH /v1/finance/accounts/:id/cash-flow-category` — sets or clears
  (`null`) one account's `cashFlowCategory`. Body:
  `{ cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null }`
  (required field — there is no "leave unchanged" case).
- `GET /v1/finance/financial-statements/cash-flow` — query params
  `dateFrom?`, `dateTo?` (mutually exclusive with `periodId`), `periodId?`
  — identical shape/defaulting convention to
  `GET .../profit-and-loss` (movement statement, no `asOf`).

Both registered in `route-role-matrix.spec.ts`'s `EXPECTED` array and
verified passing against live NestJS reflection metadata (§17).

## 7. RBAC

- `PATCH .../cash-flow-category`: `finance.admin` only — same write gate
  as `POST accounts` / `PATCH accounts/:id/archive`. Verified e2e: no
  token → 401; `finance.viewer` → 403; `finance.poster` → 403;
  `finance.admin` → 200.
- `GET .../cash-flow`: `finance.viewer` / `finance.poster` /
  `finance.admin` — same read gate as every other report in this
  codebase (`GET .../profit-and-loss`, `GET .../balance-sheet`,
  `GET /trial-balance`, …). Verified e2e for all three roles.

## 8. Audit behavior

`updateCashFlowCategory()` writes an `audit_logs` row in the **same
transaction** as the `chart_of_accounts` update (identical pattern to
`archive()` / `BankCashAccountsService.update()`):
`action: "UPDATE"`, `entityType: "chart_of_accounts"`, `entityId: <account
id>`, `beforeState`/`afterState` = the full row before/after. Verified
against a real `audit_logs` row read directly from the database (not
merely that the service method was called) in
`test/accounts.e2e-spec.ts`, including the specific
`cashFlowCategory: null → "OPERATING"` before/after values.

`GET .../cash-flow` is a pure read — no audit write, consistent with
every other report endpoint in this service.

## 9. Accounting algorithm

Implements the approved "Account-Level Classification, Entry-Level
Reconciling Gate" exactly as specified in the proposal:

- Cash accounts = every `bank_cash_accounts.glAccountId` for the legal
  entity, **regardless of `isActive`** (§8; proposal-mandated, verified
  e2e — see §12).
- A journal entry is **reconciling** if ≥1 line touches a cash account OR
  ≥1 line touches a `REVENUE`/`EXPENSE` account; otherwise it is a **pure
  non-cash reclassification** entry.
- Reconciling entries' non-cash `ASSET`/`LIABILITY`/`EQUITY` lines bucket
  into Operating/Investing/Financing/Unclassified by the account's own
  `cashFlowCategory` (Operating additionally seeded with net income —
  Revenue − Expense within the window).
- Pure non-cash reclassification entries contribute **zero** to all four
  buckets and are surfaced only in `nonCashReclassifications`.
- Per-account attribution uses each account's own actual
  `creditMinor − debitMinor` for its own lines — **no proportional/
  equal-split allocation anywhere** (verified e2e explicitly — §12).
- Two hard identities are asserted at runtime, `throw`ing (never silently
  returning a wrong report) if violated — the same defensive-assertion
  convention as `getBalanceSheet`'s own identity check:
  `openingCashMinor + netCashMovementMinor === closingCashMinor`, and
  `operatingMinor + investingMinor + financingMinor + unclassifiedMinor
=== netCashMovementMinor`.

## 10. `unclassifiedAccounts` behavior

Every `NULL`-classified `ASSET`/`LIABILITY`/`EQUITY` account with a
nonzero reconciling contribution in the window is listed individually:
`{ accountId, code, name, type, movementMinor }`, sorted by descending
absolute `movementMinor`. `unclassifiedMinor` (the bucket total),
`hasUnclassifiedAccounts`, and `unclassifiedAccountCount` are always
present and never silently folded into `operatingMinor`. Verified e2e
with two unclassified accounts of different magnitudes, asserting sort
order, field shape, and that `operatingMinor` genuinely excludes them.

## 11. `nonCashReclassifications` behavior

Every pure non-cash reclassification entry in the window is itemized:
`{ journalEntryId, journalNumber, transactionDate, lines: [{ accountId,
code, name, type, cashFlowCategory, amountMinor }] }`.
`totalGrossMinor` = the summed absolute line amounts across every such
entry, divided by 2 (each reclassification's two legs would otherwise be
double-counted). Verified e2e with the canonical CTO scenario
(`Dr Fixed Asset / Cr Loan Payable`): appears **only** here, contributes
**zero** to `investingMinor`/`financingMinor`, and its own two lines net
to exactly zero (the proposal's §5.2 algebraic proof, re-verified live).

## 12. Historical cash-account behavior

- **Deactivation does not erase history**: `bank_cash_accounts.isActive`
  is never filtered on when identifying cash accounts. Verified e2e —
  identical `netCashMovementMinor` for the same historical window before
  and after deactivating the cash account that produced it.
- **`glAccountId` repointing is a documented V1 limitation, not solved**:
  cash-account identification uses the _current_ `glAccountId` only, with
  no historical/point-in-time tracking of which GL account a
  `bank_cash_accounts` row pointed at on any given date. Verified e2e:
  after re-pointing a `bank_cash_accounts` row from account X to account
  Y, historical activity posted while it pointed at X is **no longer**
  reflected as cash movement (`netCashMovementMinor` drops to 0 for that
  window) — proven, not merely asserted in prose, and independently
  confirmed via raw SQL that the 4000 in the test fixture still genuinely
  sits on account X's own ledger (data was never lost, only
  reclassified out of "cash" by the repointing).

## 13. Reversal behavior

No special Cash-Flow reversal logic exists anywhere in this
implementation — `getCashFlow` reads whatever the ledger currently says,
exactly like every other report. Verified e2e using the existing
`POST journal-entries/:id/reverse` endpoint (swapped-debit/credit,
brand-new journal entry, same account set as the original — existing
`JournalEntriesService` mechanics, untouched):

- A window containing only the original posting reflects its full effect.
- A window containing both the original and its reversal nets to exactly
  zero.
- A window ending just before the reversal date still shows the
  not-yet-reversed original effect (historical reporting around the
  reversal date).

## 14. Known V1 limitations (disclosed, not engineered around)

1. **`glAccountId` repointing** (§12 above) — cash-account identification
   is current-state-only.
2. **Account-level classification only** — a single account cannot split
   its movement across two cash-flow categories within one period; an
   account that genuinely belongs in two categories must be split into
   two GL accounts (documented in the proposal, unchanged by this
   implementation).
3. **A real driver bug, found and fixed during this work item's own e2e
   verification** (not a limitation of the approved design, but worth
   recording): `sql\`${arr}::uuid[]\`` does not serialize a plain JS array
   parameter as a Postgres array through drizzle-orm's postgres.js driver
   (`db.execute()`) — it arrives at Postgres as an anonymous composite,
   producing `PostgresError: cannot cast type record to uuid[]` at every
   one of the 6 call sites that used this pattern (all 6 in the new
   `fetchCashTotal*`/`fetchCashFlowWorkingCapital`/
   `fetchNonCashReclassificationLines` helpers). This was caught by
   running the real e2e suite against a real Postgres instance (every
   test in `financial-statements-cash-flow.e2e-spec.ts` initially failed
   with a 500), not by code review. Fixed with a new private helper,
   `FinancialStatementsService.cashAccountIdsFragment()`, that builds an
   explicit `ARRAY[$1::uuid, $2::uuid, ...]` construction via
   `sql.join` instead — verified against the live database with a
   dedicated scratch test before being applied to all 6 call sites, and
   again via the full e2e suite afterward. No other file in this
   codebase used the `${arr}::uuid[]`pattern before this work item (a
repo-wide`grep` confirmed it), so this is a newly-introduced-and-
   fixed defect, not a pre-existing one.

## 15. Test commands

```bash
cd services/sphere-finance
npx tsc -p tsconfig.json --noEmit
npx eslint src test --ext .ts
npx jest --silent
npx jest --config jest-e2e.config.js --silent
```

Migration/schema verification:

```bash
cd services/sphere-finance
npx drizzle-kit migrate
PGPASSWORD=noryx psql -h localhost -U noryx -d noryx_test -c '\d chart_of_accounts'
```

## 16. Exact test counts

| Suite                                        | Before this work item     | After this work item          |
| -------------------------------------------- | ------------------------- | ----------------------------- |
| Unit (`npx jest`)                            | 616/616 passed, 65 suites | **618/618 passed, 65 suites** |
| E2E (`npx jest --config jest-e2e.config.js`) | 955/955 passed, 45 suites | **989/989 passed, 47 suites** |

New e2e suite: `test/financial-statements-cash-flow.e2e-spec.ts`, 27
tests, all passing (covers the CTO's full 28-scenario minimum — see §19
below for the explicit scenario-to-test mapping). `test/accounts.e2e-spec.ts`
grew by 7 tests (31 total, was 24). `route-role-matrix.spec.ts` grew by 2
route-derived tests (145 total), asserting the two new routes against
live NestJS reflection metadata.

## 17. TypeScript / lint results

- `npx tsc -p tsconfig.json --noEmit`: **clean, zero errors** (both before
  and after the driver-bug fix).
- `npx eslint src test --ext .ts`: **0 errors, 34 warnings** — every
  warning is in a file this work item did not touch (`bank-transactions/
dto/create-bank-transaction.dto.spec.ts`, `common/reversal/
reversal.util.ts`, `payment-provider-settlements/dto/
create-payment-settlement-match.dto.spec.ts`,
  `scheduled-reversals/dto/create-scheduled-reversal.dto.spec.ts`,
  `test/customer-credit-notes.e2e-spec.ts`, `test/document-reversal.e2e-spec.ts`,
  `test/scheduled-reversals-concurrency.e2e-spec.ts`,
  `test/scheduled-reversals.e2e-spec.ts`, `test/supplier-debit-notes.e2e-spec.ts`
  — confirmed pre-existing via the same lint run before any change in
  this work item began).

## 18. Migration verification

- `npx drizzle-kit generate --name=chart_of_accounts_cash_flow_category`
  produced exactly the SQL the proposal specified (§5 above).
- Applied to `noryx_test` via `npx drizzle-kit migrate` — succeeded, no
  errors.
- `packages/db-core`'s `apply-rls.ts` (17 files) and
  `apply-db-constraints.ts` (25 files) re-run afterward — both fully
  idempotent no-ops against the new column (no RLS policy or CHECK
  constraint references it, correctly — it carries no tenant/legal-entity
  scoping of its own and no cross-row invariant).
- `psql \d chart_of_accounts` confirms the column: `cash_flow_category |
cash_flow_category | | |` (nullable, no default) — exactly as designed.
- No unnecessary table, index, or constraint was created — the migration
  is the two SQL statements in §5 and nothing else.

## 19. Quality Gate item F — 28-scenario minimum, explicit mapping

Every scenario is covered by `financial-statements-cash-flow.e2e-spec.ts`
(one shared, densely cross-checked main-window fixture for most of these,
plus dedicated isolated fixtures for reversal/deactivation/repointing/
empty-period/boundaries — see that file's own top comment):

1. Operating movement — `describe("GET … — main window")`, AR/AP/VAT/
   Deferred-Revenue contributions.
2. Investing movement — Fixed Asset (E8/E9/E11).
3. Financing movement — Loan Payable/Share Capital (E7/E8).
4. Unclassified movement — `describe("unclassifiedAccounts")`.
5. Zero-classification / pure non-cash reclassification —
   `describe("nonCashReclassifications")`, E10.
6. Revenue/Expense-driven eligibility — E1 (Dr AR / Cr Revenue, no cash
   line).
7. Cash-account-driven eligibility — E6 (Dr Cash / Cr Deferred Revenue,
   no income line).
8. Multiple cash lines — E14 (inter-cash-account transfer).
9. Multiple non-cash lines — E9 (FA2 + Inventory).
10. Mixed cash + non-cash — E8 (FA purchase, part-cash/part-loan).
11. Capital contribution — E0 (Dr Cash / Cr Share Capital).
12. Loan drawdown — E7.
13. Asset acquisition funded by liability (non-cash) — E10 (the canonical
    scenario, its own `describe` block).
14. Normal AP/AR activity — E3/E4.
15. Tax/VAT-related entries — E5 (multi-line with VAT Payable).
16. Reversal of an entry affecting cash flow —
    `describe("reversal interaction")`.
17. Document-level reversal interaction — same describe block (uses the
    shared journal-reversal mechanism every document type reverses
    through; see §13's "no special Cash-Flow reversal logic" note — the
    mechanism-level proof already exists in
    `general-ledger-concurrency.e2e-spec.ts`/`document-reversal.e2e-spec.ts`
    and is not duplicated here).
18. Historical reporting around reversal dates — same describe block,
    third test.
19. Deactivated cash-account historical reporting —
    `describe("deactivated cash-account historical integrity")`.
20. `unclassifiedAccounts` contents/ordering — `describe("unclassifiedAccounts")`.
21. `nonCashReclassifications` contents — `describe("nonCashReclassifications")`.
22. Empty/no-activity period — `describe("empty period")`.
23. Opening balance — main-window test, independently cross-checked via
    raw SQL.
24. Closing balance — same test.
25. Reconciliation failure detection/invariant — both hard identities
    asserted on every response; provable-impossible-to-violate by
    construction (proposal §5.2), so coverage is the identity assertion
    itself on every test rather than a forced-failure test (forcing a
    genuine violation would require breaking the DB balance-invariant
    trigger, which is out of scope and would test Postgres, not this
    code).
26. Multi-line journal entries — E5/E8/E9.
27. Negative/credit-debit polarity — E11 (credit-side/disposal Investing
    movement, proving sign handling isn't hardcoded to "debit = positive").
28. Multi-line proportional-allocation disproof (Quality Gate item M) —
    E9, its own dedicated assertion, plus a raw-SQL cross-check of
    CF-FA2's own line amount.

Every assertion above checks actual accounting values (specific
`*Minor` amounts, specific account identities, specific array
contents/ordering) — never merely HTTP 200.

## 20. Git diff verification

Performed exactly as required before committing:

- `git status --short` — reviewed, confirmed only the 8 expected tracked
  files as `M` and the 6 expected new files as untracked-to-be-added; the
  3 pre-existing out-of-scope untracked items (`docs/hardening/`, the two
  `next-discovery` docs) confirmed present but NOT staged.
- `git diff --stat` — reviewed (§4 above).
- `git diff` (full) — reviewed for every changed production file
  (`accounts.controller.ts`, `accounts.service.ts`, `schema.ts`,
  `financial-statements.controller.ts`, `_journal.json`) inline during
  this session; `financial-statements.service.ts`'s full content was
  reviewed via `Read` (new file content, ~650 new lines — too large for a
  single inline diff review, read in full instead).
- Every changed test file reviewed the same way
  (`route-role-matrix.spec.ts`'s diff, `accounts.e2e-spec.ts`'s new
  block, `financial-statements-cash-flow.e2e-spec.ts` authored and
  re-read in full).
- Confirmed no unrelated file changed, no generated artifact entered the
  diff beyond the expected drizzle-kit metadata (`meta/_journal.json`,
  `meta/0021_snapshot.json` — both are the standard, required drizzle-kit
  migration bookkeeping, identical in kind to every prior migration in
  this repo's history), and no Phase 6/Orchestrator/NOAH material
  entered the diff.
- `docs/hardening/` confirmed untouched (still fully untracked, 0 files
  staged from it).

## 21. Final git status

```
$ git log --oneline -3
<this file's own commit SHA — see git log -1>  Add Cash Flow Statement completion report
a6142be Implement Cash Flow Statement (indirect method)
40b32e9 Add audit-trail and asOfTotals-isolation verification tests for Document Reversal

$ git status --short
?? docs/finance-work-item-next-discovery-post-reversal.md
?? docs/finance-work-item-next-discovery.md
?? docs/hardening/
```

`HEAD` is this completion report's own commit (necessarily not knowable
from inside its own content — see §3). No push has been made to any
remote — no `git push` was run by this session. The CTO will
independently review this report and the accompanying git bundle and
instruct Antigravity separately for GitHub delivery.

---

## Assumptions made during implementation (per the CTO instruction's

"resolve, document, don't ask" rule)

1. **Empty `cashAccountIds`** (a legal entity with zero configured
   Bank/Cash Accounts): no special-cased error is thrown. The `ANY(ARRAY[
]::uuid[])` predicate correctly matches nothing everywhere it's used,
   and the reconciling identity remains mathematically self-consistent
   (opening/movement/closing all resolve to 0 for cash, and every entry
   is either income-driven-reconciling or a pure reclassification) — the
   approved Rev-3 proposal text does not mandate a distinct thrown error
   for this case (an earlier proposal revision had suggested one; it was
   not carried into the final approved text), so this was resolved by
   following the currently-approved document rather than an earlier
   draft.
2. **`contribution()` simplified to `creditMinor − debitMinor`**,
   uniformly across `ASSET`/`LIABILITY`/`EQUITY`, rather than the
   proposal's type-branching `contribution(ASSET) = −signedDelta`,
   `contribution(LIABILITY/EQUITY) = +signedDelta` — algebraically
   identical (hand-verified for multiple cases before implementation;
   also implicitly re-verified by every passing e2e assertion below,
   since every expected value in the test file was independently
   hand-derived using the proposal's own type-branching form and matches
   the implementation's output exactly).
3. **`cashAccountIdsFragment()` array-parameter construction** (§14 item 3) — not specified by the proposal (an implementation-mechanics
   detail below the proposal's level of abstraction), resolved by
   testing directly against the live database rather than assuming a
   pattern would work, per the Quality Gate's "verify, don't assume"
   posture.
