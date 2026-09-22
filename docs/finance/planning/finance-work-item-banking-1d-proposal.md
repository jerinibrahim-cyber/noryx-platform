# Finance Work Item — Banking-1d: Bank & Cash Reporting

**Status:** proposed, self-reviewed, ready for implementation in this same
run per the CTO's combined discovery→implementation authorization
(2026-08-27 turn). No genuine unresolved architectural decision was found
— see §6.

---

## 1. Scope Determination (from the existing repository, not invented)

Banking-1a (Bank/Cash Account master), Banking-1b (Bank Transactions), and
Banking-1c (Bank Statement Import & Reconciliation) are implemented and on
`main` (`f750406`, `6993993`, `0914de3`). `docs/roadmap.md:167`'s Banking &
Cash Management checklist is:

> Bank accounts, Bank transactions, Bank reconciliation, UPI/card/bank
> payment reconciliation where applicable, Cash management, Cash receipts,
> Cash payments, Bank transfers, Cash position.

Mapped against what exists today:

| Checklist item                       | Status                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bank accounts                        | Done — Banking-1a                                                                                                                                                            |
| Bank transactions                    | Done — Banking-1b                                                                                                                                                            |
| Bank reconciliation                  | Done — Banking-1c                                                                                                                                                            |
| Bank transfers                       | Done — Banking-1b's `TRANSFER` type                                                                                                                                          |
| UPI/card/bank payment reconciliation | Explicitly out of scope, no repository evidence supports it (locked in every Banking proposal's exclusion list, most recently Banking-1c §21 OUT OF SCOPE)                   |
| Cash receipts / Cash payments        | Already served by AR Customer Receipts / AP Supplier Payments (existing posting sources) — not Banking's job; continuity rules for this run explicitly forbid rewriting them |
| **Cash position**                    | **Not implemented anywhere — the one genuine remaining gap**                                                                                                                 |

Separately, the original master proposal
(`docs/finance-work-item-banking-cash-management-proposal.md §14`,
"Reporting Implications") named three specific reports and where they'd
land once their dependencies existed, without committing to build them
immediately:

> "**Banking-1c** (design only): unlocks **Bank Reconciliation Report**
> (...) — mirroring `ArReconciliationResult`'s shape), **Cash Position** (Σ
> closing balance across every active Bank/Cash Account's GL account for a
> legal entity — a lightweight aggregate reusing the same
> `glAssetBalance`-style query per account, no new computation), and
> **Unreconciled Transaction Report** (book transactions with no
> statement-line match as of a date)."
>
> "...once Bank Transactions exist, a genuine **Bank/Cash Account
> Statement** (running balance of all book transactions — Payments,
> Receipts, and Bank Transactions — touching one account, mirroring
> `ar-reports.service.ts`'s `getCustomerStatement` shape exactly) becomes
> meaningful..."

Of these four, **Bank Reconciliation Report was already built** — it is
exactly Banking-1c's `BankStatementImportSummary`
(`statementClosingBalanceMinor`/`glBookBalanceMinor`/`differenceMinor` +
the matching-completeness block), confirmed present and tested in the
`0914de3` commit. The other three — **Cash Position**, **Bank/Cash Account
Statement**, **Unreconciled Transactions** — were named, given a precise
shape, and explicitly deferred, never built. They are Banking-1d's scope.

This is not a new design — it is finishing a design the repository's own
history already committed to, using conventions (`ar-reports.service.ts`,
`ap-reports.service.ts`, `general-ledger.service.ts`) that exist and are
exercised by 464+ passing tests today.

---

## 2. Proposed Scope: three read-only reports, one new module

A single new module, `bank-reports/`, exactly mirroring `ap-reports/` and
`ar-reports/`'s file shape and the "duplicate `GeneralLedgerService`'s
balance logic locally" convention every report module in this codebase
already follows:

```
src/bank-reports/
├── bank-reports.controller.ts
├── bank-reports.module.ts
├── bank-reports.service.ts
└── dto/
    ├── cash-position-query.dto.ts (+ .spec.ts)
    ├── bank-cash-account-statement-query.dto.ts (+ .spec.ts)
    └── unreconciled-transactions-query.dto.ts (+ .spec.ts)
```

**Zero new tables, zero migration, zero RLS file, zero immutability
trigger.** Every number this module reports is derived, read-only, from
tables Banking-1a/1b/1c/AP/AR already write correctly:
`bank_cash_accounts`, `bank_transactions`, `bank_reconciliation_matches`,
`bank_statement_lines`, `supplier_payments`, `customer_receipts`,
`journal_lines`/`journal_entries`. This mirrors AR-1d/AP-1d exactly
("No new tables, no new migration ... every number here is derived").

### 2.1 `GET /bank-reports/cash-position`

**Route placement correction (self-review):** initially drafted as
`GET /bank-cash-accounts/cash-position`, but `BankCashAccountsController`
already registers `@Get(":id")` on that exact prefix at the same
single-segment depth — a second controller adding a sibling bare segment
there is a real collision hazard (NestJS/Express would route
`/bank-cash-accounts/cash-position` into `BankCashAccountsController
.findOne(id: "cash-position")` depending on registration order). AP-1d
already solved this identical shape problem: legal-entity-wide reports
(`ap/ageing`, `ap/reconciliation`) live under their own `ap/` prefix, never
nested as a bare segment under `suppliers/` (which has its own `:id`
route). Banking-1d follows the same precedent — the two
legal-entity-wide reports live under `bank-reports/`; only the
single-account statement (§2.2, a `:id/statement` shape with a mandatory
second segment, the same safe shape `accounts/:id/ledger` and
`suppliers/:id/statement` already use) stays nested under
`bank-cash-accounts/:id/...`.

**Cash Position** — for the caller's legal entity, one row per Bank/Cash
Account: its GL book balance as of a date, computed the identical way
Banking-1c's own `glBookBalance` and `ArReportsService.glAssetBalance`
compute any account's balance (debit-normal, `SUM(debit) - SUM(credit)`
over POSTED `journal_lines`/`journal_entries`, up to `asOf`) — duplicated
locally in this new service, not imported, per the established
cross-module convention. **Never derived from `bank_transactions`** — same
non-negotiable rule Banking-1c's charter locked (§1 of that
implementation-authorization: "BOOK BALANCE must come from the GL account
... never from `bank_transactions` sums").

- Query: `asOf?` (default today), `includeInactive?` (default `false` —
  mirrors `BankCashAccountsService.list`'s own `includeInactive` filter
  and query-param convention exactly, including its `Transform`-based
  boolean coercion, the same shape `TrialBalanceQueryDto.includeZeroBalance`
  already uses).
- Response: `rows: CashPositionRow[]` (`bankCashAccountId`, `code`,
  `name`, `kind`, `currencyCode`, `glAccountId`, `balanceMinor`), `meta`
  (`asOf`, `legalEntityId`, `accountCount`,
  `totalsByCurrency: Record<string, number>`). **Subtotaled by currency,
  never summed across currencies** — no FX exists anywhere in this schema
  today (every prior Banking/AP/AR proposal's identical constraint); a
  single blended total would silently imply an FX rate that does not
  exist. In the common single-currency-tenant case `totalsByCurrency` has
  exactly one key and reads as the obvious total.
- RBAC: all three finance roles read (no write side exists in this
  controller at all).

### 2.2 `GET /bank-cash-accounts/:id/statement`

**Bank/Cash Account Statement** — chronological, running-balance list of
every book-side transaction touching one Bank/Cash Account, mirroring
`ArReportsService.getCustomerStatement`'s shape line-for-line
(`StatementLine`/`CustomerStatementMeta`/opening+closing balance, the same
`REPORT_TX_CONFIG` snapshot isolation). Three sources, unioned and sorted
chronologically:

1. **`bank_transactions`** (Banking-1b), `status = POSTED`, where
   `bankCashAccountId = :id` **or** (`type = 'TRANSFER'` and
   `counterpartyBankCashAccountId = :id`) — the identical "either leg" scan
   Banking-1c's own matching-candidate query already uses. Signed per the
   schema's own documented direction convention (`schema.ts`'s Banking-1c
   comment block, verbatim): DEPOSIT/INTEREST = inflow (+), WITHDRAWAL/FEE
   = outflow (−), TRANSFER = outflow (−) on `bankCashAccountId`, inflow
   (+) on `counterpartyBankCashAccountId`.
2. **`supplier_payments`** (AP), `status = POSTED`, where
   `bankCashAccountId = bank_cash_accounts.glAccountId` for this account —
   **always an outflow (−)**. This is a read-only join on the _existing_
   `chart_of_accounts`-typed `bankCashAccountId` column AP already has; no
   change to that column, its type, or its validation (continuity rule:
   "AP Supplier Payments ... must not be silently rewritten", and this
   report doesn't touch AP at all — it only reads AP's already-posted
   rows).
3. **`customer_receipts`** (AR), `status = POSTED`, same join shape against
   `customer_receipts.bankCashAccountId = bank_cash_accounts.glAccountId`
   — **always an inflow (+)**.

- Query: `dateFrom?`, `dateTo?` (default today) — identical
  `CustomerStatementQueryDto` shape, reusing the existing
  `IsSameOrAfterDate` validator unchanged.
- Opening balance = the account's GL book balance strictly before
  `dateFrom` (same `glAssetBalance`-as-of-cutoff pattern, `strict: true`,
  as AR-1d's own opening-balance computation) when `dateFrom` is given,
  else `0` (statement from inception) — identical convention to
  `ArReportsService.getCustomerStatement`.
- Running balance is computed by walking the sorted, signed rows from the
  opening balance — **this is a presentation reconstruction of the GL book
  balance, not a second balance authority**: `openingBalanceMinor +
Σ(signed rows) = glBookBalance(dateTo)` is an invariant this report's
  own e2e suite asserts by cross-checking against the same
  `glAssetBalance`-style query, exactly mirroring how Banking-1c's book
  balance is independently verified against raw `journal_lines`.
- RBAC: all three finance roles read.

### 2.3 `GET /bank-reports/unreconciled-transactions`

**Unreconciled Transactions** — POSTED `bank_transactions` that are not
fully covered by ACTIVE `bank_reconciliation_matches`, i.e. the exact
per-leg "remaining capacity" computation Banking-1c's own
`remainingAmountForBankTransaction` already performs (leg-scoped by
Bank/Cash Account, required for TRANSFER's double-leg design — locked in
the Banking-1c commit that fixed this exact scoping bug). This report
_generalizes_ that existing per-import computation into a cross-import,
listing-level view — it does not invent a new matching or balance concept.

- Query: `bankCashAccountId?` (optional — legal-entity-wide when omitted),
  `asOf?` (default today, filters `transactionDate <= asOf`).
- When `bankCashAccountId` is given: one row per POSTED bank transaction
  whose remaining (unmatched) amount on **that account's leg** is `> 0`
  (transactions where `bankCashAccountId = :id`, or, for TRANSFER,
  `counterpartyBankCashAccountId = :id`).
- When omitted: every POSTED bank transaction in the legal entity is
  evaluated on its primary leg (`bankCashAccountId`); a `TRANSFER` is
  _additionally_ evaluated on its counterparty leg — producing up to two
  rows for one TRANSFER transaction if both legs still have remaining
  capacity, each row tagged with which account/leg it represents. This is
  the identical double-leg semantics Banking-1c's matching layer already
  has; this report only surfaces it as a list instead of a per-import
  count.
- Response row: `bankTransactionId`, `internalReference`, `type`,
  `transactionDate`, `bankCashAccountId` (the leg this row represents),
  `amountMinor` (the transaction's own full amount), `remainingMinor` (the
  unmatched amount on this leg), `reference`, `memo`.
- RBAC: all three finance roles read.

---

## 3. Explicit Exclusions

Not in Banking-1d:

- Any schema change, migration, RLS policy, or immutability trigger — this
  work item is a pure read layer (§2).
- Any change to Banking-1a/1b/1c, AP, AR, Journal Engine, or
  `GeneralLedgerService` — every query here is `SELECT`-only against
  existing tables.
- Any change to `supplier_payments.bankCashAccountId` /
  `customer_receipts.bankCashAccountId`'s schema, type, or validation —
  read-only joins against the column as it exists today.
- Cash-flow statement, multi-currency/FX consolidation, UPI/card/POS
  reconciliation — locked out of scope by every prior Banking proposal,
  restated here for completeness, not reopened.
- A cross-currency blended Cash Position total (§2.1) — no FX exists in
  this schema.
- Any new posting, matching, or reconciliation logic — Banking-1d reports
  on state Banking-1b/1c already produce; it does not create, match, or
  complete anything.

---

## 4. API / RBAC Summary

Three new `GET` routes, split across two prefixes exactly the way
`ap-reports`/`ar-reports` split theirs — a per-account route nested under
the existing master-data prefix (`bank-cash-accounts/:id/...`, mirroring
`suppliers/:id/statement`/`accounts/:id/ledger`'s safe 2-segment shape),
and legal-entity-wide routes under their own `bank-reports/` prefix
(mirroring `ap/ageing`, `ap/reconciliation`, `ar/ageing`,
`ar/reconciliation` — never nested as a bare segment under a prefix that
already owns a `:id` route at that depth; see §2.1's routing-collision
note):

| Route                                         | Roles                 |
| --------------------------------------------- | --------------------- |
| `GET /bank-reports/cash-position`             | viewer, poster, admin |
| `GET /bank-cash-accounts/:id/statement`       | viewer, poster, admin |
| `GET /bank-reports/unreconciled-transactions` | viewer, poster, admin |

No write route exists in this controller — identical posture to
`ApReportsController`/`ArReportsController`/`GeneralLedgerController`, all
of which are 100% read RBAC with no poster/admin split (there is nothing
to distinguish, since nothing here mutates).

`route-role-matrix.spec.ts` grows from 103 routes / 20 controllers to 106
routes / 21 controllers.

`BankReportsModule` registers as a new **top-level sibling** of
`BankReconciliationModule` in `AppModule` — Banking has no wrapper module
(unlike AP/AR, which nest their own `ApReportsModule`/`ArReportsModule`
inside `AccountsPayableModule`/`AccountsReceivableModule`); every prior
Banking sub-item (`BankCashAccountsModule`, `BankTransactionsModule`,
`BankReconciliationModule`) is already a flat top-level import, so
`BankReportsModule` follows that established pattern exactly rather than
introducing a new wrapper.

---

## 5. Testing Plan

Mirrors Banking-1c's own discipline: real Postgres, no mocking of
accounting behavior.

**DTO unit specs** (3 files): query-param validation for each report's DTO
(date format, `IsSameOrAfterDate`, `includeInactive` coercion,
`bankCashAccountId` optional-UUID).

**`test/bank-reports.e2e-spec.ts`** (new), covering at minimum:

- RBAC: all three roles can read every route; no token → 401.
- Cash Position: `totalsByCurrency` sums correctly across the legal
  entity's accounts, keyed by that entity's own single functional
  currency — every Bank/Cash Account within one legal entity necessarily
  shares that same currency (§2.1, no FX), so a genuine multi-currency
  fixture isn't constructible within one Cash Position response; the test
  instead asserts the (always-one-key) `totalsByCurrency` shape is
  correct and includes the seeded account's balance. A deactivated
  account is excluded by default and included with `includeInactive=true`;
  the reported `balanceMinor` is independently cross-checked against a raw
  `journal_lines` SUM in the test itself (same style as Banking-1c's own
  book-balance test) and proven **not** to equal a naive
  `bank_transactions`-only sum when AP/AR/manual-journal activity exists
  against the account (the identical AP/AR-bypass proof Banking-1c's own
  suite established, reused here because Cash Position makes the same
  claim).
- Statement: a fixture combining a DEPOSIT bank transaction, a WITHDRAWAL
  bank transaction, a POSTED Supplier Payment, and a POSTED Customer
  Receipt against one account, asserting correct sign, chronological
  order, and that `openingBalanceMinor + Σ(rows.amountMinor) =
closingBalanceMinor = independently-recomputed GL book balance` as of
  `dateTo`. A TRANSFER fixture proves both legs appear correctly signed on
  their respective accounts' statements (mirroring Banking-1c's own
  TRANSFER double-leg e2e test).
- Unreconciled Transactions: an unmatched transaction appears; a fully
  matched transaction does not; a partially matched transaction appears
  with the correct `remainingMinor`; a TRANSFER matched on one leg but not
  the other appears exactly once, for the unmatched leg only, when queried
  legal-entity-wide (no `bankCashAccountId` filter).
- Tenant isolation / legal-entity isolation on all three routes (same
  pattern as every other report suite in this codebase).

**Full suite**: unit (existing 464 + this item's new DTO specs), this
item's e2e file, full e2e suite, full e2e suite run a second time for
stability — identical sequence to Banking-1c's own verification gate.

**Independent raw-PostgreSQL verification**: since this work item adds no
schema, the independent check is a manual SQL cross-computation (not a
schema/constraint/trigger check, none of which apply here) — for at least
one seeded Bank/Cash Account, manually SUM `journal_lines` against its
`glAccountId` via `psql` and confirm it equals the Cash Position API's
reported `balanceMinor` and the Statement API's `closingBalanceMinor`,
exactly the cross-check already performed for Banking-1c's book balance.

---

## 6. Self-Review — Design Questions Resolved From Existing Architecture

Per the combined-cycle instruction, every question below is answered from
code/schema/convention already in the repository — none required a new
CTO decision:

1. **Does Cash Position sum across currencies?** No — no FX exists
   anywhere in this schema (locked in every prior Banking/AP/AR proposal);
   subtotal by currency, matching the "no invented FX" constraint.
2. **Does the Statement include AP/AR, or only Bank Transactions?** Both —
   the master proposal's own §14 language ("all book transactions —
   Payments, Receipts, and Bank Transactions") is explicit, and the join
   is against AP/AR's _existing_ `bankCashAccountId` column, read-only, no
   schema change.
3. **Does Unreconciled Transactions need new matching logic?** No —
   Banking-1c's `remainingAmountForBankTransaction` (leg-scoped) already
   computes exactly this per bank transaction; this report reuses the
   identical query shape across a listing instead of a single import.
4. **Where does the new module register?** As a top-level sibling in
   `AppModule`, matching the flat pattern all three existing Banking
   modules already use (no `BankingModule` wrapper exists to nest under).
5. **Does this need a migration/RLS/trigger?** No — zero new tables, so
   §I/§II of the standard schema checklist are structurally inapplicable
   here, not skipped.
6. **Include deactivated Bank/Cash Accounts in Cash Position by default?**
   No, matching `BankCashAccountsService.list`'s own default
   (`includeInactive` defaults false); available via the identical
   opt-in query flag.

**No genuinely blocking decision was found.** Proceeding directly to
implementation per the CTO's instruction (§5 of the authorization: "If
there are no genuine unresolved CTO decisions, IMPLEMENT Banking-1d
immediately in this same run").

---

## 7. Acceptance Criteria

1. `GET /bank-reports/cash-position` returns one row per active
   Bank/Cash Account (or all, with `includeInactive=true`) in the caller's
   legal entity, `balanceMinor` equal to that account's GL book balance as
   of `asOf`, subtotaled by currency in `meta.totalsByCurrency`.
2. Cash Position's `balanceMinor` is never a `bank_transactions`-only sum
   — it reflects AP/AR/manual-journal activity against the account's
   `glAccountId`, proven by a dedicated test.
3. `GET /bank-cash-accounts/:id/statement` returns a chronological,
   correctly-signed union of Bank Transactions, Supplier Payments, and
   Customer Receipts touching the account, with a running balance whose
   closing value equals the account's independently-computed GL book
   balance as of `dateTo`.
4. A TRANSFER bank transaction appears correctly signed (outflow on the
   primary leg, inflow on the counterparty leg) on both accounts' own
   statements.
5. `GET /bank-reports/unreconciled-transactions` lists every POSTED
   bank transaction (or leg, for TRANSFER) whose active-match sum is less
   than its own `amountMinor`, with the correct `remainingMinor`; a fully
   matched transaction never appears.
6. All three routes enforce tenant isolation, legal-entity isolation, and
   are readable by all three finance roles; no route in this controller
   permits any write.
7. Zero diff to any file outside `bank-reports/`, its DTOs, its e2e spec,
   `app.module.ts`, and `route-role-matrix.spec.ts`.
