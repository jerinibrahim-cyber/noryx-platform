# Finance Core — 2d: General Ledger Read Layer

**Status: IMPLEMENTED AND VERIFIED.** Three substantive corrections
(§0.1) and two documentation-only cleanups (§0.2) are incorporated
throughout this document. Implementation is complete: Account Ledger,
Account Balance, Trial Balance, `GeneralLedgerModule`, all required
DTOs/validators, the shared `LedgerMeta` type, and full e2e coverage
exist and pass. §6.3's candidate index was evaluated against real
EXPLAIN ANALYZE evidence and DEFERRED — no schema or migration change
was made. See §16 for the full verification record.

2c-2 (posting, numbering, reversal) is approved and closed — commit
`9f9fb05`, on top of `db83d69` (2c-1) and `383004d`, confirmed pushed to
`origin/main`. This is the last increment on the original Finance Core
roadmap (`docs/finance-journal-engine-proposal.md` §12): **2d — General
Ledger read layer**. Three read-only capabilities: Account Ledger,
Account Balance, Trial Balance.

## 0.1 Corrections from review

The overall design (three endpoints, §2/§3/§5; the accounting-correctness
reasoning, §4; RBAC/isolation, §8/§9) is approved as originally proposed.
Review found three points that were either self-contradictory or
under-specified, corrected here as final decisions, not open questions:

| item                                                       | correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate index (`journal_entries_entity_status_date_idx`) | The original §6.3 both proposed the index as "not created" (correct, per instruction) and pre-judged it as "the one place a new index is genuinely justified" — a contradiction, since the second phrasing decides the outcome the first phrasing said was still open. Corrected: the index remains allowed within 2d but is **not** decided by this proposal either way. §6.3 now specifies an explicit implementation-time procedure — inspect the actual query plan (`EXPLAIN ANALYZE`) against realistic seeded data using only the existing indexes; add the index via a normal migration only if it measurably improves the plan, otherwise explicitly defer it. Whichever outcome occurs is documented with its `EXPLAIN ANALYZE` evidence (§6.3, §13, §16) — never silently decided. |
| Account Balance `asOf` default ("today")                   | The original §3.1.1 said `asOf` defaults to "today" without defining what "today" means for a server that could run in any timezone, or whether the value is computed in application code or in SQL against the database server. Corrected: a new §4.8 defines "today" as the current **UTC calendar date**, computed once in application code via `new Date().toISOString().slice(0, 10)` — the same expression 2c-2 already uses for reversal's default `transactionDate` — never via SQL `CURRENT_DATE`/`NOW()`. This is deterministic regardless of the application server's or the Postgres server's local timezone configuration. §3.1.1 and §5.1.2 (new, below) both now reference this single definition rather than restating an ambiguous default independently.                   |
| Trial Balance `periodId` semantics                         | The original §5 mentioned `periodId` only in passing (§4.5's summary table) with no dedicated subsection: it never stated how `periodId` resolves to a date, what happens with a closed period, whether it can combine with `asOf`, or what the default is when neither is given. Corrected: new §5.1.2 makes this fully explicit — `periodId` resolves via the same tenant+legal-entity-scoped lookup used everywhere else in 2d (404 if out of scope), the resolved period's `endDate` becomes the effective `asOf`, a `CLOSED` period remains fully readable (same principle as §2.1.2/§4.4), `periodId` combined with an explicit `asOf` is rejected `400`, and the resolved `asOf` (plus, when applicable, the resolved `periodId`) is always echoed in `TrialBalanceMeta` (§5.1.6).    |

## 0.2 Final documentation cleanups (post-§0.1 review)

Both are wording-only — no design, endpoint, RBAC, isolation, pagination,
or date-semantics change:

| item                                     | correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1.2's `periodId`/date-range rule      | Was phrased as "a review decision, not a hard requirement — flagging it in case you'd rather have `periodId` merely supply defaults." That hedge is removed. §2.1.2 now states the rule — `periodId` resolves within tenant+legal-entity scope, `periodId` combined with `dateFrom`/`dateTo` is rejected `400`, `periodId` determines the period's `[startDate, endDate]` range — as a final decision, approved in review, not open for reconsideration during implementation. §6's intro and §6.3 likewise no longer call the candidate index's outcome a "review decision" — it's an **implementation-time evidence decision**, resolved by `EXPLAIN ANALYZE` against the real query plan, not by reviewer judgment.                                                                                                                                            |
| `db/schema.ts` "NO CHANGE" contradiction | §6.3 always allowed the candidate index to be added via migration if justified, while §14/§15/§16 flatly stated "NO CHANGE" to `schema.ts` with no exception carved out — a direct contradiction once §6.3's evidence-based procedure could actually justify adding it. Corrected: §14 now states schema.ts is unchanged **by default**, with the sole exception being that one index, added only if §6.3's evidence justifies it (and a corresponding migration file, listed conditionally). §15 clarifies that if the index is justified, its migration lands in the same single commit as the rest of 2d, discovered during this implementation pass rather than deferred. §16's "zero changes" acceptance bullet is updated to carve out this same single, evidence-gated exception rather than asserting an absolute that §6.3 could never actually satisfy. |

---

## 0. What was inspected before writing this

Full re-read of the current `main` state, not assumptions carried over
from earlier sessions:

- `services/sphere-finance/src/db/schema.ts` — `chartOfAccounts`,
  `accountingPeriods`, `journalNumberCounters`, `journalEntries`,
  `journalLines`, their columns, constraints, and **existing indexes**
  (enumerated in §6 below). Unchanged since `15f044b` (2b) — 2c-1/2c-2
  added no schema.
- `src/accounts/{accounts.service,accounts.controller}.ts` — the
  `(tenantId, legalEntityId)` explicit-predicate pattern, the
  `findByIdInTx` scoped-lookup convention, that `list()`/`findOne()` are
  unpaginated today, and that `findOne`/ledger-adjacent lookups do **not**
  filter on `isActive` (archived accounts remain individually
  addressable — relevant precedent for 2d, see §3.1).
- `src/accounting-periods/{accounting-periods.service,accounting-periods.controller}.ts`
  — the `close()` atomic-`UPDATE...WHERE` pattern (not relevant to a
  read layer, but confirms periods are never deleted, only OPEN→CLOSED,
  so historical period references from journal entries are always
  resolvable).
- `src/journal-entries/journal-entries.service.ts` — `post()`/`reverse()`
  in full: the `SELECT ... FOR UPDATE` locking pattern (write-side only,
  not applicable to 2d — see §8's explicit "no new write-side concurrency
  controls" note), `resolveAndLockOpenPeriod`'s period-resolution query
  shape (reused read-only, unlocked, in §2.1/§3), the
  `journal_number_counters` atomic-allocation shape, and the exact
  reversal semantics (§4 below reasons through what this means for GL).
- `src/journal-entries/journal-entries.controller.ts` — confirms `list()`
  today takes ad-hoc `@Query()` params validated inline in the handler
  body (no query DTO exists anywhere in this codebase yet — §5.4 flags
  this as the one genuinely new pattern 2d introduces).
- `src/auth/{finance-auth.module,guards/roles.guard,decorators/roles.decorator}.ts`,
  `src/auth/strategies/jwt.strategy.ts` — the two-layer RBAC
  (`noryx.module.json`'s `requiredRoles` pre-filter + per-route
  `@Roles()`), `FinanceAuthModule`'s `PassportModule`/`JwtStrategy`
  wiring reused by 2c-1's two new modules.
- `src/common/interceptors/response.interceptor.ts`,
  `src/common/filters/all-exceptions.filter.ts` — the `ApiSuccess<T>` /
  `ApiError` envelope, applied uniformly regardless of route.
- `src/db/db.ts` — confirms `chartOfAccounts`, `accountingPeriods`,
  `journalEntries`, `journalLines`, plus db-core's `auditLogs` and
  `legalEntities`, are already one query-building schema union; a new
  read-only service can query across all four Finance tables in a single
  `withTenant()` transaction with no new wiring.
- `src/app.module.ts` — the one-module-per-capability registration
  pattern (`AccountsModule`, `AccountingPeriodsModule`,
  `JournalEntriesModule`, each importing `FinanceAuthModule` except
  `AccountsModule`).
- `noryx.module.json` — `requiredRoles` already lists all three
  `finance.*` roles; **2d needs no manifest change** (unlike 2c-1, which
  had to add `finance.poster`).
- `packages/shared-types/src/api-envelope.ts` — **`PaginatedResponse<T>`
  and `PaginatedMeta` already exist** (`page`, `pageSize`, `totalItems`,
  `totalPages`) but are defined and unused — no route anywhere in the
  platform paginates yet. Confirmed via repo-wide grep
  (`grep -rn "PaginatedResponse\|cursor\|pageSize"`) across
  `services/`, `packages/`, `apps/`: zero consuming usages, zero other
  pagination convention anywhere else in NoryX to reconcile against.
  This is the one existing "reporting/read-model pattern elsewhere in
  NoryX" that's directly relevant, and 2d's Account Ledger endpoint would
  be its first real consumer (§5.1, §5.4).
- `drizzle/constraints/002_balance_invariant_trigger.sql` — reconfirmed
  the deferred trigger that guarantees `SUM(debit) = SUM(credit)` for
  every `POSTED` `journal_entries` row, individually. This is the
  mathematical basis for the Trial Balance invariant proof in §4.3 —
  2d's grand-total equality is not a new assertion 2d has to
  independently maintain, it's a direct, provable consequence of a
  guarantee 2b already enforces at the database level for every entry.
- `drizzle/constraints/003_journal_entries_immutability_trigger.sql` —
  reconfirmed a `POSTED` entry's `transactionDate`, lines, and every
  other business field are frozen (only `reversedByJournalEntryId` can
  ever move, once). Relevant to §4.4 (reversals): the original entry's
  historical GL impact can never silently change after the fact.

No other reporting/read-model pattern exists anywhere else in the
monorepo to be consistent with beyond the `ApiSuccess`/`PaginatedResponse`
envelope already inspected above — `services/identity` and
`services/api-gateway` have no analogous "derive a report from
transactional data" endpoint.

---

## 1. 2d scope

**In scope — exactly the three capabilities from
`docs/finance-journal-engine-proposal.md` §12's "2d — General Ledger read
layer":**

1. **Account Ledger** — `GET /accounts/:id/ledger` — paginated
   transaction history for one account, with running balance.
2. **Account Balance** — `GET /accounts/:id/balance` — opening / period
   movement / closing balance for one account, as of a date or over a
   date range.
3. **Trial Balance** — `GET /trial-balance` — every account's net
   debit/credit position as of a date, for the caller's legal entity,
   with the grand-total debit=credit control check.

All three are **read-only**: no mutation routes, no new database writes
(no new tables, no audit-log writes — reads are never audited anywhere
in this codebase today, and 2d does not start). Schema is unchanged by
default, with one narrow, evidence-gated exception for a single
candidate index — never a business-data write, and never assumed;
see §6.3/§14.

**Explicitly out of scope for 2d** (per your instruction, restated so
this document is self-contained for the reviewer):

- Materialized/precomputed balances of any kind. Every figure 2d returns
  is computed at query time from `journal_entries`/`journal_lines`,
  full stop. §7 discusses why this is adequate for 2d's proposed shape
  and what a future increment could do if it ever isn't.
- AP/AR, bank reconciliation, FX/multi-currency conversion, period
  reopening, reversal-of-reversal, cross-legal-entity user access, or any
  accounting capability beyond the three GL read endpoints above.
- Any schema migration, new table, or new index **as part of this
  proposal document** — §6.3 proposes one candidate index but does not
  create it here; whether it's ultimately added is decided at
  implementation time against the real query plan (`EXPLAIN ANALYZE`),
  not assumed by this document either way (§0.1, §6.3, §16).
- Any change to `AccountsModule`, `AccountingPeriodsModule`, or
  `JournalEntriesModule`'s existing behavior. 2d is additive: a new
  module reading tables those modules already own, touching none of
  their files.
- Pagination for Trial Balance (§4.3 argues why an unpaginated single
  response is the correct shape for a report whose entire point is an
  internally-consistent grand total).
- A `desc`/`order` toggle on Account Ledger — fixed chronological
  ascending only (§2.1.4). Flagged as a possible, easy future addition,
  not part of 2d.

---

## 2. Account Ledger — `GET /accounts/:id/ledger`

### 2.1 Design decisions

**2.1.1 — Account selection.** `:id` path param, resolved through the
exact same tenant+legal-entity-scoped lookup `AccountsService.findOne`
already uses (`and(eq(id), eq(legalEntityId))`, inside `withTenant`) —
404, not 403, on a nonexistent id or one belonging to a different
tenant/legal-entity, matching the codebase's established
information-disclosure convention (§7.4 of the 2c proposal; same
reasoning applies here). **No `isActive` filter on account resolution**
— an archived account's ledger remains fully readable. Archiving means
"no new postings may reference this account" (2c-1/2c-2's create/edit/
posting validation); it does not mean "this account's history is
hidden." This mirrors `AccountsService.findOne`'s own behavior today
(no `isActive` predicate there either).

**2.1.2 — Query parameters.**

| param      | type       | default | notes                                                   |
| ---------- | ---------- | ------- | ------------------------------------------------------- |
| `dateFrom` | ISO date   | —       | inclusive                                               |
| `dateTo`   | ISO date   | —       | inclusive                                               |
| `periodId` | UUID       | —       | mutually exclusive with `dateFrom`/`dateTo` — see below |
| `page`     | int ≥ 1    | `1`     |                                                         |
| `pageSize` | int, 1–200 | `50`    |                                                         |

**Final decision**: `periodId`, if given, resolves that accounting
period's own `[startDate, endDate]` as the effective range — the period
is looked up scoped to the caller's own `tenantId`/`legalEntityId` (404
if not found in that scope, same convention as everywhere else in this
proposal). **`periodId` combined with an explicit `dateFrom`/`dateTo` is
rejected with `400`** ("cannot combine periodId with an explicit date
range") — composing them (e.g., does an explicit `dateFrom` narrow or
override the period's range?) has no single obviously-correct meaning,
so 2d picks the simpler, unambiguous rule rather than guessing. Approved
as final in review; not open for reconsideration during implementation.

Both `dateFrom` and `dateTo` are optional and independent when no
`periodId` is given — either, both, or neither may be supplied. No
`dateFrom`/no `periodId` means "from account inception" (openingBalance
= 0, §2.1.5). No `dateTo` means "through today."

A period's **`OPEN`/`CLOSED` status has no bearing on this endpoint** —
read access to historical data is never gated on whether the period that
covers it is still open for new postings. This is worth stating
explicitly because it's an easy, wrong assumption to carry over from the
write side.

**2.1.3 — Only `POSTED` entries participate.** `journal_entries.status =
'POSTED'` is an unconditional predicate — `DRAFT` entries referencing
this account never appear in the ledger, regardless of any filter. A
ledger is a view of the books of record; `DRAFT` is definitionally not
yet part of the books (matches 2c-2's own framing of posting as "the
accounting integrity boundary").

**2.1.4 — Deterministic ordering.** `transactionDate ASC, journalNumber
ASC, lineNumber ASC`. `transactionDate` is the primary chronological
key; when two or more `POSTED` entries share the same `transactionDate`,
`journalNumber` is the tiebreaker — it's assigned monotonically per
legal entity at posting time (2b's `journal_number_counters`), so it's a
faithful proxy for "which of these was posted first" among same-date
entries. **Note for the reviewer**: `journalNumber` is a zero-padded
`VARCHAR` (`JE-000123`), so a plain lexicographic string sort is
numerically correct today only because every number shares the same
prefix and width — this is an existing 2c-2 invariant 2d is relying on,
not something 2d introduces or needs to re-validate; called out here so
it's an explicit, visible dependency rather than a silent assumption.
`lineNumber` is the final tiebreaker for the (rare but valid) case of two
lines in the same entry both touching this account (e.g., a journal that
debits Cash twice for two distinct amounts). Always ascending — no `desc`
option in 2d (§1).

**2.1.5 — Opening balance.** When an effective `dateFrom` applies
(explicit or via `periodId`), the response's `meta` includes
`openingBalanceMinor`: the account's signed balance (§4.1's sign
convention) from **all** `POSTED` lines with `transactionDate <
dateFrom` — i.e., strictly before the window, not including it. Because
`transaction_date` is a `date` column with no time component, "strictly
before this date" is unambiguous — there's no intraday ordering problem
to solve, a genuine simplification worth stating rather than assuming.
When no `dateFrom` applies, `openingBalanceMinor` is `0` by definition
(there is no "before the account's first possible activity").

**2.1.6 — Running balance, and how it survives pagination.** Each
returned line carries `runningBalanceMinor`: the account's cumulative
signed balance immediately after this line, in the deterministic order
above, starting from `openingBalanceMinor`. Getting this right under
**offset pagination** (§2.1.7) needs its own explicit algorithm, since a
naive per-page window function would restart from zero on every page:

1. Resolve the effective date range and compute `openingBalanceMinor` as
   in §2.1.5 (one aggregate query, always — cheap, a single indexed
   `SUM`).
2. Fetch this page's rows: the qualifying lines in the deterministic
   order, `OFFSET (page-1)*pageSize LIMIT pageSize`, plus a `COUNT(*)`
   over the same `WHERE` clause for `meta.totalItems`.
3. Compute this **page's own starting balance** — `openingBalanceMinor`
   plus the signed sum of every qualifying line strictly before this
   page's first returned row in the deterministic order (i.e., the
   `(transactionDate, journalNumber, lineNumber)` tuple of that row is
   used as an upper bound on a second aggregate `SUM` query, scoped by
   the same tenant/entity/account/date/status predicates). For page 1
   this is just `openingBalanceMinor` again (nothing precedes it) — no
   special case needed, the query naturally returns zero rows to sum.
4. Walk the page's own rows in order, accumulating from the page's
   starting balance, to produce each row's `runningBalanceMinor`.

This makes each page's running balance correct in isolation — a caller
fetching only page 3 still sees accurate running balances, not balances
relative to an assumed "page 1 was fetched first" — at the cost of one
extra aggregate query per page (step 3). That query is a `SUM` filtered
by the same predicates plus a tuple upper bound, which the composite
index proposed in §6.1 would make an efficient indexed range scan rather
than a full scan of everything before the page. **This is real,
identified cost that grows with how deep a caller pages** (page 50 pays
for summing 49 pages' worth of predecessor rows) — flagged here rather
than glossed over, per the "no silent caps" principle. For realistic
Finance usage (a human reviewing one account's ledger, rarely paging
past the first few pages) this is acceptable; if deep-paging ever becomes
a real workload, a future increment could move to keyset/cursor
pagination (carry the last row's ordering tuple forward instead of an
offset) to make each page O(pageSize) instead of O(offset). Out of scope
for 2d, noted as the natural next step if it's ever needed.

**2.1.7 — Pagination.** Offset-based, using the platform's existing
`PaginatedResponse<T>`/`PaginatedMeta` shape from `@noryx/shared-types`
(§0 — defined, never yet consumed). Proposed defaults: `pageSize` 50,
minimum 1, maximum 200 (a `pageSize` outside `[1, 200]` is a `400`, not a
silent clamp — consistent with this codebase's "clean 4xx, not a
surprising silent behavior" convention throughout 2c). These specific
numbers are a review decision, not load-tested — flagging them as
proposed defaults, easy to change before implementation.

**2.1.8 — Response row shape.**

```ts
interface LedgerLine {
  journalEntryId: string;
  journalNumber: string; // "JE-000123"
  transactionDate: string; // ISO date
  memo: string | null; // journal_entries.memo
  lineDescription: string | null; // journal_lines.description
  debitMinor: number;
  creditMinor: number;
  runningBalanceMinor: number; // signed, per §4.1's normal-balance convention
  // Presentational, not required for correctness — cheap to include
  // since the row is already loaded. Null on an ordinary entry.
  reversalOfJournalEntryId: string | null;
  reversedByJournalEntryId: string | null;
}
```

Both `debitMinor` and `creditMinor` are always present (one of them zero,
per the existing `journal_lines_single_sided`/`journal_lines_nonzero`
DB checks) — a ledger is conventionally a two-column T-account view, not
a single signed "amount" column; collapsing to one column would lose
information a real ledger reader expects (§4.4 also explains why
reversal lines need no special handling here — they're ordinary lines).

**2.1.9 — `meta` shape** (extends `PaginatedMeta`):

```ts
interface LedgerMeta extends PaginatedMeta {
  // page, pageSize, totalItems, totalPages
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  openingBalanceMinor: number;
  effectiveDateFrom: string | null; // resolved, whether from dateFrom or periodId
  effectiveDateTo: string | null;
}
```

Full response: `ApiSuccess<LedgerLine[]> & { meta: LedgerMeta }` —
i.e., `PaginatedResponse<LedgerLine>` with `LedgerMeta` in place of the
bare `PaginatedMeta`. `packages/shared-types` needs `LedgerMeta` added
(§9) since `PaginatedMeta` alone doesn't carry the ledger-specific
fields — the alternative (cramming these into `PaginatedMeta` itself)
would leak ledger-specific fields into every future paginated endpoint,
so this proposes an extension, not a modification, of the existing type.

---

## 3. Account Balance — `GET /accounts/:id/balance`

### 3.1 Design decisions

Same account-resolution rule as §2.1.1 (no `isActive` filter — an
archived account's balance is still a real, meaningful number, not an
error).

**3.1.1 — Date semantics: two modes, not one.**

- **`asOf` mode** (query param `asOf`, ISO date; **default: today**,
  resolved via the deterministic UTC-calendar-date convention defined in
  §4.8 — never dependent on the application server's or database
  server's local timezone configuration) — "what is this account's
  cumulative balance through this date." `openingBalanceMinor` is `0`,
  `periodMovementMinor` equals the full life-to-date balance, and
  `closingBalanceMinor` equals `periodMovementMinor`. This is the
  simplest, most common query ("what's the balance right now") and is
  the default when no other param is given.
- **Range mode** (`dateFrom`+`dateTo`, or `periodId` resolving to a
  period's own range — same mutual-exclusivity rule as §2.1.2, `400` if
  `periodId` is combined with explicit dates) — all three figures are
  meaningful: `openingBalanceMinor` (§2.1.5's definition, reused
  verbatim), `periodMovementMinor` (net signed movement strictly within
  `[dateFrom, dateTo]`), `closingBalanceMinor = openingBalanceMinor +
periodMovementMinor`.

`asOf` combined with `dateFrom`/`dateTo`/`periodId` is rejected with
`400` — mixing "as of a single point" with "a range" has no coherent
combined meaning, so 2d rejects rather than guessing which one wins.

**3.1.2 — Only `POSTED` entries participate.** Identical rule to the
ledger (§2.1.3) — restated here because it's independently load-bearing
for this endpoint's own correctness, not merely inherited.

**3.1.3 — Zero activity is not an error.** An account with no qualifying
`POSTED` lines in the resolved range returns `openingBalanceMinor`
(possibly nonzero, if activity exists before the range),
`periodMovementMinor: 0`, `closingBalanceMinor` = `openingBalanceMinor`.
`404` is reserved exclusively for "this account id doesn't resolve in
the caller's own tenant/legal-entity scope" — never repurposed to mean
"no activity."

**3.1.4 — Response shape.**

```ts
interface AccountBalanceResponse {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  effectiveDateFrom: string | null;
  effectiveDateTo: string; // always resolved — "asOf" or dateTo
  openingBalanceMinor: number; // signed, normal-balance convention (§4.1)
  periodMovementMinor: number; // signed, same convention
  closingBalanceMinor: number; // opening + movement
  totalDebitMinor: number; // raw, unsigned, this range only
  totalCreditMinor: number; // raw, unsigned, this range only
}
```

`ApiSuccess<AccountBalanceResponse>` — no `meta`, no pagination (a
single account, a single computed answer; there's nothing to page).

---

## 4. Critical accounting correctness

This section is the substance the reviewer should scrutinize hardest —
restated explicitly because "just `SUM(debitMinor) - SUM(creditMinor)`"
is wrong or incomplete in at least three distinct ways addressed below.

### 4.1 Normal balance by account type

Double-entry accounting assigns each account type a **normal balance**
side — the side on which increases to that account are recorded:

| type        | normal balance | increases via | decreases via |
| ----------- | -------------- | ------------- | ------------- |
| `ASSET`     | DEBIT          | debit         | credit        |
| `EXPENSE`   | DEBIT          | debit         | credit        |
| `LIABILITY` | CREDIT         | credit        | debit         |
| `EQUITY`    | CREDIT         | credit        | debit         |
| `REVENUE`   | CREDIT         | credit        | debit         |

A **signed balance** (used by the Ledger's running balance, §2.1.6, and
Account Balance's three figures, §3) must be computed relative to each
account's own normal-balance side, or the sign is meaningless (a $500
credit to a Liability account is an *increase*; the same $500 credit to
an Asset account is a _decrease_ — collapsing both to "credit = positive"
would be simply wrong for half the chart of accounts). The signed delta
for one line is:

- `debitMinor - creditMinor` for a DEBIT-normal account (`ASSET`,
  `EXPENSE`)
- `creditMinor - debitMinor` for a CREDIT-normal account (`LIABILITY`,
  `EQUITY`, `REVENUE`)

This mapping is proposed as a small, pure, private helper function in
`GeneralLedgerService` (`normalBalanceFor(type): "DEBIT" | "CREDIT"`) —
Finance-domain logic with no reason to live in `@noryx/shared-types` or
be exposed outside this service.

### 4.2 Ledger running balance — already specified in §2.1.6

Restated for completeness: `runningBalanceMinor` after line _i_ =
`openingBalanceMinor + Σ(signed delta for lines 1..i)`, using §4.1's
per-type sign convention, in the §2.1.4 deterministic order.

### 4.3 Trial Balance column placement — the debit/credit convention is

NOT the normal-balance convention

This is the single most important correctness decision in this
document, and it's easy to get wrong by reflexively reusing §4.1's
type-based sign convention here. **A trial balance's debit/credit column
placement is deliberately type-agnostic** — it is a mechanical check
that total debits equal total credits across the _entire_ chart of
accounts, which only works because the placement rule ignores account
type entirely:

For each account, over all qualifying `POSTED` lines up to `asOf`
(life-to-date, not a movement window — trial balances are inherently a
point-in-time snapshot, not a period report; there is no `dateFrom` on
this endpoint, only `asOf`/`periodId`, §4.5):

1. `rawDebitTotal = SUM(debitMinor)`, `rawCreditTotal =
SUM(creditMinor)` — unsigned, straightforward aggregates.
2. `netMinor = rawDebitTotal - rawCreditTotal` — a plain arithmetic net,
   **not** adjusted by the account's normal-balance type.
3. Column placement, purely by the sign of `netMinor`:
   - `netMinor > 0` → `netMinor` in the **debit** column, `0` in credit.
   - `netMinor < 0` → `abs(netMinor)` in the **credit** column, `0` in
     debit.
   - `netMinor == 0` → both columns `0` (subject to the zero-balance
     inclusion rule, §4.6).

An account with an _unusual_ balance for its type (e.g., a `LIABILITY`
account that happens to carry a net debit position — unusual, but not
impossible) is still placed correctly: it lands in the debit column as a
positive number, exactly as a real trial balance would show it, **not**
flipped into the credit column as a negative number because "liabilities
are normally credit." `accountType` and `normalBalance` are still
surfaced per row as informational metadata (a consumer may well want to
flag "this liability has an abnormal debit balance" — that's exactly
what carrying both fields alongside the mechanical placement enables),
but they play **no role** in which column the number lands in.

**Why this must be true, not just asserted:** the reason a trial balance
balances at all — `Σ(debit column) = Σ(credit column)` across every
account — is that summing the per-account nets and re-splitting each by
its own sign telescopes back to `Σ(all rawDebitTotal) - Σ(all
rawCreditTotal)` across the whole legal entity, which is exactly
`Σ(debitMinor) - Σ(creditMinor)` summed over every qualifying line in
every account. That grand difference is `0` **by construction**, because
2b's deferred balance trigger (`drizzle/constraints/002_...`,
reconfirmed in §0) already guarantees `SUM(debitMinor) = SUM(creditMinor)`
for every individual `POSTED` journal entry — so the sum over _all_
entries is trivially the sum of a list of zeros. The trial balance's
grand-total equality is therefore not a new invariant 2d has to
independently defend; it's a direct, provable consequence of an
invariant 2b already enforces at the database level. §8's test plan
includes an explicit assertion of this (`Σdebit column === Σcredit
column`, always, as a property check) — proving the _query_ correctly
preserves an invariant the _data_ already guarantees, which is a
meaningfully different (and necessary) thing to test than re-deriving
the invariant itself.

### 4.4 Reversals in GL views

A reversal (2c-2, `docs/finance-2c-journal-entry-service-proposal.md`
§6) is, by design, **an ordinary new `POSTED` journal entry** — normal
debit/credit lines (amounts identical to the original, debit/credit
swapped), its own `journalNumber`, its own `transactionDate`, its own
resolved period. It participates in the Ledger, Account Balance, and
Trial Balance **exactly like any other posted entry** — no special-case
branch anywhere in 2d's query logic. The **original** entry is likewise
untouched except for `reversedByJournalEntryId` (2b's immutability
trigger, reconfirmed in §0, guarantees every other field — including its
lines — is frozen), so it too continues to participate unchanged.

The correct accounting behavior falls out of this with no extra code:
the original's impact and the reversal's (opposite) impact both appear
in the ledger at their own respective transaction dates, and their
combined net effect nets to zero over time — which is the entire point
of a _reversing_ entry (correct the books going forward, never
retroactively edit history). §2.1.8 proposes surfacing
`reversalOfJournalEntryId`/`reversedByJournalEntryId` on each ledger row
as cheap, useful presentational metadata (the data is already loaded);
this is a nice-to-have, not a correctness requirement — omitting it
would not change any balance or ordering.

One consequence worth stating explicitly: reversing an entry whose
original covering period has since **closed** (a scenario 2c-2's own
test suite already covers — the reversal resolves its own, independently
open, period) means the _original's_ GL impact continues to appear
exactly where its own `transactionDate`/`periodId` place it, even though
that period is now closed — again, consistent with "closed only affects
future postability, never past readability" (§2.1.2).

### 4.5 Date/period semantics — summarized across all three endpoints

| endpoint        | date modes                                   | range meaningful?                                                        |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| Ledger          | `dateFrom`/`dateTo`/`periodId`               | yes — a browsable window with opening balance                            |
| Account Balance | `asOf` **or** `dateFrom`+`dateTo`/`periodId` | yes in range mode                                                        |
| Trial Balance   | `asOf` **or** `periodId` only                | **no** — always a point-in-time snapshot, never a movement window (§4.3) |

Trial Balance deliberately has no `dateFrom`/`dateTo` — a trial balance
is not a period-movement report, it's a snapshot control total. Offering
a range on this one endpoint would invite a "trial balance for Q2" query
that doesn't correspond to any real accounting artifact (a trial balance
is always as-of a point; a _change_ in trial balances between two points
is a different report this proposal doesn't build). Stated explicitly so
it reads as a deliberate omission, not a gap.

### 4.6 Trial Balance: zero-balance and archived-account inclusion

- **Zero-balance accounts**: excluded by default (matches how a real
  trial balance is conventionally presented — an account with no
  activity and no carried balance adds no signal). Proposed opt-in flag:
  `includeZeroBalance=true`, useful for confirming a freshly-seeded chart
  of accounts is complete. Default-exclude is a review decision, not
  load-bearing for correctness — flagged, not asserted.
- **Archived (`isActive: false`) accounts**: **always included** if they
  carry nonzero `POSTED` activity as of `asOf`, unconditionally,
  regardless of `includeZeroBalance`. This is not a style choice — it's
  required by §4.3's invariant proof: every account's raw debit/credit
  totals must be represented for the grand totals to reconcile. Excluding
  an archived account with a real balance would silently break `Σdebit =
Σcredit`, which is the one thing a trial balance must never do. An
  archived account with **zero** balance follows the same
  `includeZeroBalance` rule as any other account (its zero balance
  contributes nothing to the totals either way, so excluding it by
  default is safe).

### 4.7 Multiple legal entities / tenant isolation

All three endpoints are single-tenant, single-legal-entity, exactly like
every existing Finance route — `tenantId`/`legalEntityId` always
JWT-derived (`CurrentUser`), never a request param/body, never a
cross-entity aggregate mode. No new architectural surface here; 2d
simply inherits the existing, already-reviewed non-goal (cross-legal-
entity user access is explicitly out of scope for the whole Finance Core
milestone, restated in §1).

### 4.8 The "today" convention — deterministic, not machine/server-dependent

Account Balance's `asOf` default (§3.1.1) and Trial Balance's `asOf`
default (§5.1.2) both need a well-defined "today" when the caller
supplies neither an explicit date nor a `periodId`. This must not depend
ambiguously on the application server's local timezone setting or the
Postgres server's `TimeZone` configuration — a date-based accounting API
returning a different "today" depending on which machine, container, or
region happened to serve a given request would be a real correctness
bug (two callers hitting different app-server instances near midnight
could get different trial balances for the same nominal request), not
merely a style inconsistency.

**2d resolves "today" as the current UTC calendar date, computed once in
application code, never in SQL.** Concretely:
`new Date().toISOString().slice(0, 10)` — the same expression 2c-2
already uses for reversal's default `transactionDate`
(`journal-entries.service.ts`, reconfirmed §0). `Date.prototype.
toISOString()` always normalizes to UTC regardless of the Node process's
`TZ` environment variable or the host machine's local timezone, so this
value is identical no matter which server, container, or region
evaluates it — genuinely deterministic, not merely "usually consistent
in practice." This value is computed once per request and passed to the
query layer as an ordinary `date` parameter; 2d never calls
`CURRENT_DATE`/`NOW()`/`now()` in a raw SQL fragment for this purpose,
specifically to avoid any dependency on the Postgres server's own
`TimeZone` GUC, which is a separate, independently-configurable setting
that has no reason to agree with the application's convention.

**What this convention deliberately does not attempt:** a true
"business day" boundary for a company operating in, say, US Eastern time
would flip at 04:00 or 05:00 UTC, not midnight UTC — this proposal does
not model that. NoryX has no tenant- or legal-entity-level timezone
setting anywhere in its schema today (reconfirmed by §0's schema
re-read), so there is nothing to derive a business timezone from without
inventing new schema — explicitly out of scope for 2d. UTC-calendar-date
is the simplest convention that is at least fully deterministic and
consistent with 2c-2's existing precedent; if a genuine
business-timezone requirement emerges later, it would need its own
schema addition (e.g. a timezone column on `legal_entities`) and would
be its own reviewed proposal, not a 2d concern.

Because `transaction_date` — the column this value is ultimately
compared against — is itself a `date` column with no time component
(§2.1.5's same observation), no further timezone conversion is needed
once "today" is resolved to a plain calendar-date string: the comparison
is between two dates, never an instant-vs-timezone comparison.

---

## 5. Trial Balance — `GET /trial-balance`

### 5.1 Design decisions

**5.1.1 — Route shape.** `GET /trial-balance` — a bare top-level route,
**not** nested under `/accounts` or a `/legal-entities/:id/...` path.
Finance has no route anywhere that takes `legalEntityId` as a path/query
param (it's always JWT-derived), and Finance doesn't own the
`legal_entities` resource (`db-core`'s, read-only from Finance's side,
§0) — inventing a `/legal-entities/:id/trial-balance` path would imply a
resource-ownership relationship that doesn't exist in this codebase.
`GET /trial-balance` matches the existing convention exactly
(`GET /accounting-periods`, `GET /journal-entries` are likewise bare,
tenant/entity-scope always implicit).

**5.1.2 — Date resolution: `asOf` vs. `periodId`, and the "today"
default.** Exactly one of `asOf`, `periodId`, or neither may be
supplied — **`asOf` combined with `periodId` is rejected with `400`**
("cannot combine periodId with an explicit asOf"), the same
mutually-exclusive-inputs rule already established for Ledger's
`periodId`-vs-`dateFrom`/`dateTo` (§2.1.2) and Account Balance's
`asOf`-vs-range (§3.1.1), extended here for consistency rather than
left as an unstated gap.

- **`asOf` supplied** — used directly as the snapshot date.
- **`periodId` supplied** — resolved through the same
  tenant+legal-entity-scoped `AccountingPeriodsService` lookup already
  used everywhere else in 2d (§9): a `periodId` that doesn't resolve
  within the caller's own `tenantId`/`legalEntityId` is `404`, identical
  to every other `periodId` resolution in this proposal (§2.1.2,
  §3.1.1). Once resolved, **the period's own `endDate` becomes the
  effective `asOf`** — "the trial balance for period X" conventionally
  means "as of the last day period X covers" (a snapshot at period
  close, not a movement report over the period — restated from §4.5).
  The period's `status` (`OPEN` or `CLOSED`) has **no bearing on
  whether this resolves** — a `CLOSED` period's trial balance remains
  fully readable, the same "closed only affects future postability,
  never past readability" principle already established for Ledger
  (§2.1.2) and reversals (§4.4). Worth stating explicitly here because
  "the trial balance as of a period I just closed" is the single most
  common real-world use of this endpoint, so it must never be
  accidentally treated as an error case.
- **Neither supplied** — `asOf` defaults to **today**, resolved by the
  deterministic UTC-calendar-date convention defined in §4.8 — identical
  default behavior to Account Balance's `asOf` mode (§3.1.1).

`TrialBalanceMeta` (§5.1.6) always echoes the resolved `asOf` date and,
when resolution went through `periodId`, the resolved `periodId` itself
— so a caller can always tell which concrete date the response reflects,
and which period (if any) drove that resolution, without re-deriving it
client-side.

**5.1.3 — Account inclusion.** Every account in the caller's chart of
accounts (§4.6) with either nonzero `POSTED` activity as of `asOf`, or
(if `includeZeroBalance=true`) simply existing in scope regardless of
activity. No account-type filter, no `isActive` filter beyond §4.6's
rule.

**5.1.4 — Ordering.** Account `code` ascending — the natural,
conventional chart-of-accounts ordering, and already a unique key per
`(tenantId, legalEntityId)` (`chart_of_accounts_tenant_entity_code_unique`,
2a), so it's a legitimate, fully deterministic sort key with no
tiebreaker needed.

**5.1.5 — No pagination.** A trial balance's entire value proposition is
an internally-consistent grand total — "debits equal credits" is only
verifiable by looking at the whole report at once. A "page 1 of 3" trial
balance without the other two pages' contribution to the total would be
actively misleading (a reader could reasonably expect a partial page's
two columns to already reconcile, and they wouldn't). 2d proposes
returning the full account list in one response, unpaginated,
explicitly as a deliberate correctness-over-uniformity decision — flagged
as a review point since it's the one place 2d doesn't reuse the
`PaginatedResponse` shape. For realistic Finance chart-of-accounts sizes
this is a small, bounded response; if an organization's chart of accounts
ever grows large enough for this to be a real problem, §7 sketches the
future direction (a summary/detail split), explicitly deferred.

**5.1.6 — Response shape.**

```ts
interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isActive: boolean;
  debitMinor: number; // this account's placed column value; 0 if netMinor <= 0
  creditMinor: number; // this account's placed column value; 0 if netMinor >= 0
}

interface TrialBalanceMeta {
  asOf: string; // always resolved, ISO date (§5.1.2) — explicit asOf, periodId's endDate, or today (§4.8)
  periodId: string | null; // the periodId that resolved asOf, if any; null when resolved via asOf or the today-default
  legalEntityId: string;
  totalDebitMinor: number; // Σ debitMinor across all rows
  totalCreditMinor: number; // Σ creditMinor across all rows — always === totalDebitMinor
  accountCount: number;
  includeZeroBalance: boolean; // echoes the resolved query param
}
```

`ApiSuccess<TrialBalanceRow[]> & { meta: TrialBalanceMeta }` — not
`PaginatedMeta`-shaped, deliberately (§5.1.5). `totalDebitMinor ===
totalCreditMinor` is asserted by construction (§4.3) and additionally
verified in application code before the response is returned — if it
ever somehow didn't hold, that's a bug worth surfacing loudly (a `500`
via an unexpected-state guard) rather than silently shipping a
non-reconciling trial balance. This is the one place 2d proposes an
internal defensive assertion beyond what the DB trigger already
guarantees, precisely because this invariant is the entire point of the
endpoint.

---

## 6. Data/query design and performance

**No new database structure is proposed.** All three endpoints derive
their results entirely from `journal_entries`, `journal_lines`,
`chart_of_accounts`, and (for period-resolution convenience)
`accounting_periods` — the same four tables 2c-1/2c-2 already query.
Per your explicit instruction, this section identifies where the
_existing_ indexes are and are aren't sufficient, and proposes one
candidate addition — **not implemented here; its outcome is an
implementation-time evidence decision** (§6.3), resolved by an actual
query plan against real data, not by review-time judgment.

### 6.1 Existing indexes (from `schema.ts`, reconfirmed §0)

| table               | index                                                                       | covers                                   |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `journal_entries`   | `(tenant_id, legal_entity_id)`                                              | entity scoping                           |
| `journal_entries`   | `(period_id)`                                                               | period-based lookups                     |
| `journal_entries`   | unique `(tenant_id, legal_entity_id, journal_number)`                       | also usable as an entity+number index    |
| `journal_lines`     | `(account_id)`                                                              | account-scoped line lookups              |
| `journal_lines`     | unique `(journal_entry_id, line_number)`                                    | also usable as an entry→lines join index |
| `chart_of_accounts` | unique `(tenant_id, legal_entity_id, code)`; `(tenant_id, legal_entity_id)` | account lookups/ordering                 |

### 6.2 Account Ledger's query path

`journal_lines WHERE account_id = $1` (existing index, highly selective
— an account belongs to exactly one legal entity, so this alone narrows
sharply) `JOIN journal_entries ON journal_entry_id = journal_entries.id`
(PK join, always indexed) `WHERE tenant_id/legal_entity_id/status/
transaction_date` (filtered post-join) `ORDER BY transaction_date,
journal_number, line_number`. The existing `journal_lines_account_idx`
already makes the entry point to this query cheap; the post-join filter
and sort operate over a set already narrowed to one account's lines, so
this is likely adequate **without** a new index for realistic per-account
row counts. Flagged as "likely adequate, not verified against real data
volume" — a candidate to revisit if a specific account's ledger proves
slow in practice (e.g. a very high-traffic Cash account).

### 6.3 Trial Balance's query path — a candidate index, decided at implementation time against the real query plan

Trial Balance has **no single account to narrow by** — it must scan
every `POSTED` entry in the legal entity up to `asOf` (then join to
`journal_lines`, group by `account_id`, sum). The existing
`journal_entries (tenant_id, legal_entity_id)` index gets the query to
"every entry in this entity" but provides no help narrowing further by
`status`/`transaction_date` — that filter runs unindexed once landed
inside the entity's row set. As entry volume grows, this could degrade
in a way the ledger's account-first access pattern doesn't — but whether
it actually does, for realistic data volumes, is an empirical question
this proposal does not settle, and does not need to settle, before
implementation begins.

**Candidate index** (allowed within 2d; not created by this proposal —
its outcome is an **implementation-time evidence decision**, not a
review decision, per §6.3's procedure below):

```sql
CREATE INDEX journal_entries_entity_status_date_idx
  ON journal_entries (tenant_id, legal_entity_id, status, transaction_date);
```

This composite index, if added, would make both Trial Balance's "every
POSTED entry up to asOf" scan and the Ledger's opening-balance/
page-boundary aggregate queries (§2.1.5/§2.1.6 step 3, which also filter
by `status`/`transaction_date` without an account_id narrowing when
computing a page's predecessor sum) efficient indexed range scans
instead of full entity scans.

**Decision procedure, run once during implementation, not now — and its
outcome is a required part of 2d being called done (§16):**

1. Implement the Trial Balance query (and the Ledger page-boundary
   aggregate) against the **existing** indexes only — no new index
   present yet.
2. Seed a representative dataset (realistic entry/line volume for a
   single legal entity — not the handful of rows a correctness-only e2e
   test needs) and run `EXPLAIN ANALYZE` against the actual query as
   built, on real Postgres, not a guess about what the planner will do.
3. **If the existing indexes are sufficient** — the plan is already an
   efficient scan (e.g. the entity index narrows enough that the
   remaining `status`/`transaction_date` filter and `GROUP BY` cost is
   negligible for realistic volumes) — **explicitly defer** the
   candidate index. Do not create it "just in case."
4. **If the composite index would materially improve the plan** (e.g.
   the `EXPLAIN ANALYZE` without it shows a full/sequential scan over a
   nontrivial row count that an index scan would avoid) — add it through
   the normal `drizzle-kit generate` migration process, the same
   low-risk, no-cross-service-coupling class of change as 2b's existing
   indexes, and re-run `EXPLAIN ANALYZE` to confirm the planner actually
   uses it (an index that exists but isn't chosen by the planner proves
   nothing).
5. **Either outcome is recorded, not silently decided**: the actual
   `EXPLAIN ANALYZE` output (before, and after if the index was added)
   is included in the implementation report/commit description, and this
   document's §6.3/§16 are updated in place with the recorded outcome —
   matching this proposal's own established pattern of amending review
   corrections into the document (§0.1) rather than leaving the written
   record stale. This decision is made once, by evidence, at
   implementation time — never assumed from this proposal's reasoning
   alone, and never made twice (i.e., not re-litigated per environment).

**Decision recorded at implementation — DEFERRED, by evidence.**

Seeded a single legal entity with 20 accounts, 20,000 `POSTED` journal
entries (2 balanced lines each, 40,000 `journal_lines` rows) spread
across a 2-year date range — real Postgres, `ANALYZE`d, no synthetic
shortcuts. `EXPLAIN (ANALYZE, BUFFERS)` was run against the Trial
Balance query exactly as implemented (§6, the `LEFT JOIN` onto a
pre-filtered `journal_lines`/`journal_entries` subquery, `GROUP BY
coa.id`) three times: (a) against the existing indexes only, full-range
`asOf`; (b) after creating the candidate
`journal_entries_entity_status_date_idx`, same query; (c) with the
index still present but a narrow `asOf` (a date range covering roughly
2% of the seeded rows), to check whether a more selective filter would
change the planner's choice.

The result was the same in all three runs: the planner drives the query
from `journal_lines_account_idx` (a nested loop over the 20 accounts,
each probing its own lines via that existing index), then joins
`journal_entries` **by primary key per line** (a `Memoize`-cached index
scan on `journal_entries_pkey`) rather than ever scanning
`journal_entries` in bulk by `(tenant_id, legal_entity_id, status,
transaction_date)`. Because `journal_entries` is never scanned in bulk
in this plan shape, the candidate composite index is structurally
irrelevant to it — run (b) confirms this directly: with the index
physically present, the planner did not choose it, and execution time
was statistically identical to run (a) (~105ms vs. ~109ms, within
run-to-run noise). Run (c) confirms the same holds under a much more
selective date filter — the planner still drives from the account-first
path rather than switching strategies. The Ledger's opening-balance
query (§2.1.5, the same account-first shape §6.2 already predicted was
adequate) measured 7.9ms against the existing indexes alone, on one
account's ~2,000 qualifying lines — consistent with §6.2's un-tested
prediction, now empirically confirmed.

**Conclusion: the existing indexes are sufficient for the Trial Balance
query as implemented; the candidate index is explicitly deferred, not
created.** `db/schema.ts` and the migrations directory are unchanged by
2d (§14's default-no-schema-change path applies, not its conditional
exception). If Trial Balance latency ever becomes a real, measured
problem at production data volumes, the more direct fix suggested by
this evidence is not this candidate index but a query shape that groups
`journal_lines` directly (a single `GROUP BY account_id` pass over the
pre-filtered lines, rather than one nested-loop iteration per account)
— out of scope for 2d, noted here only because the measurement points
at it more precisely than "add an index" would have; a future increment
revisiting Trial Balance performance should start from this note rather
than re-deriving it.

### 6.4 Aggregation cost

Trial Balance's `SUM(...)  GROUP BY account_id` is the single most
expensive query 2d introduces — proportional to total `POSTED` line
count in the entity up to `asOf`, unavoidable without materializing
balances (explicitly out of scope, §1/§7). §6.3's candidate index was
evaluated and explicitly deferred — the measured query plan does not use
a composite index of this shape regardless of whether it exists (§6.3's
recorded decision) — so no index-based optimization is applied for 2d;
none is proposed further here either.

---

## 7. Why no materialized structure, and what would change that

Every figure in 2d is computed at query time. This is deliberate, not an
oversight: a materialized/precomputed balance table introduces its own
correctness surface (keeping it in sync with every `post()`/`reverse()`
transaction, backfilling it correctly, handling the case where a bug
lets it drift from the source of truth) that this proposal has no
concrete evidence is yet justified by real query cost. If, after 2d
ships, real Trial Balance or high-traffic-account Ledger query latency
turns out to be a genuine problem (measured, not assumed), the natural
next step would be a **materialized summary table** updated
transactionally inside `post()`/`reverse()`'s existing transaction (the
row lock those methods already take makes this safe to add later without
a new concurrency design) — explicitly deferred, not part of 2d, and
would be its own reviewed proposal if it's ever needed.

---

## 8. RBAC

No new roles. Every 2d route: `@Roles("finance.viewer", "finance.poster",
"finance.admin")` — identical to every existing read route
(`GET /accounts`, `GET /journal-entries`, `GET /accounting-periods`).
`noryx.module.json`'s `requiredRoles` already lists all three roles
(§0) — **no manifest change needed**. `JwtAuthGuard` + `RolesGuard`
applied at the controller level, same as every other Finance controller.

No mutation routes exist in 2d, so there is no write-side RBAC
distinction to design (no `finance.poster`-only route here, unlike
journal entries).

**No new write-side concurrency controls.** Per your instruction, 2d is
read-only and introduces no `SELECT ... FOR UPDATE`, no new transaction-
locking design — every query in 2d is a plain `withTenant(tenantId, tx =>
...)` read, same as `AccountsService.list()`/`findOne()` today. The
_existing_ write-side locking (2c-2's `post()`/`reverse()` row locks) is
unaffected by and irrelevant to 2d; a concurrent post and a concurrent
ledger read simply don't conflict — Postgres's MVCC means a read never
blocks on, or is blocked by, another transaction's row lock, so no
concurrency test is needed to prove "posting while someone reads the
ledger works fine." (This still leaves an ordinary "did the read happen
before or after that post's commit" ordering question — not a
correctness bug, just normal read-your-writes semantics that don't need
special handling.)

---

## 9. Tenant/legal-entity isolation

Identical pattern to every prior increment, restated for completeness
since it's the thing every reviewer of this codebase checks first:

- `tenantId`/`legalEntityId` always resolved from the verified JWT via
  `CurrentUser()` + the same `requireTenantId`/`requireLegalEntityId`
  private-method pattern every controller in this service already uses
  — never a request param/body.
- Every query wrapped in `withTenant(tenantId, tx => ...)` — RLS
  session variable set before any Finance table is touched.
- Every query carries an **explicit** `legalEntityId` predicate in
  addition to RLS — RLS alone stops cross-tenant leakage but not
  cross-legal-entity leakage within one tenant (2a's architecture,
  reaffirmed through every increment since). Account resolution (§2.1.1)
  is 404 for a wrong-tenant or wrong-legal-entity account id, never a
  distinguishable error — same information-disclosure convention as
  every prior increment.
- `periodId` (§2.1.2/§3.1.1), when supplied, is resolved through the
  same tenant+legal-entity-scoped lookup `AccountingPeriodsService`
  already uses — a `periodId` belonging to a different tenant/entity is
  `404`/`400`, never silently accepted.

---

## 10. Response contracts — summary

| route                       | success shape                                                         |
| --------------------------- | --------------------------------------------------------------------- |
| `GET /accounts/:id/ledger`  | `PaginatedResponse<LedgerLine>` with `LedgerMeta` (§2.1.8/§2.1.9)     |
| `GET /accounts/:id/balance` | `ApiSuccess<AccountBalanceResponse>` (§3.1.4)                         |
| `GET /trial-balance`        | `ApiSuccess<TrialBalanceRow[]> & { meta: TrialBalanceMeta }` (§5.1.6) |

Errors: the existing `ApiError` envelope via `AllExceptionsFilter`,
unchanged — `404` (account/period not found in scope), `400` (malformed
query params, mutually-exclusive param combinations per §2.1.2/§3.1.1),
`401`/`403` (auth/RBAC, via the existing guards).

---

## 11. Edge cases (consolidated)

- Account exists but has zero `POSTED` activity in the requested range —
  not an error; Ledger returns an empty page with a correct (possibly
  nonzero) `openingBalanceMinor`; Account Balance returns zeros for
  movement with a correct opening/closing.
- Account is archived (`isActive: false`) — fully readable in all three
  endpoints (§2.1.1/§4.6); never excluded from Trial Balance if it
  carries a nonzero balance (§4.6 — this is a correctness requirement,
  not a convenience).
- Account belongs to a different legal entity within the **same**
  tenant — `404`, not `403` or a data leak (§9).
- Account belongs to a different tenant entirely — `404` (RLS backstop
  plus the explicit predicate, §9).
- `periodId` doesn't resolve in the caller's own scope (Ledger, Account
  Balance, or Trial Balance) — `404`.
- `periodId` combined with explicit `dateFrom`/`dateTo` — `400` (§2.1.2/
  §3.1.1).
- `asOf` combined with a range on Account Balance — `400` (§3.1.1).
- Trial Balance `periodId` combined with explicit `asOf` — `400`
  (§5.1.2).
- Trial Balance `periodId` resolves to a `CLOSED` period — fully
  readable, `asOf` resolved to that period's `endDate`, not an error
  (§5.1.2).
- Trial Balance / Account Balance with neither `asOf` nor `periodId`
  given — `asOf` defaults to today per §4.8's UTC-calendar-date
  convention, identically regardless of the serving instance's local
  timezone.
- Multiple `POSTED` entries share the same `transactionDate` — resolved
  deterministically via `journalNumber` then `lineNumber` (§2.1.4); no
  nondeterministic ordering, ever.
- A reversal and its original both fall inside the same ledger window —
  both appear as ordinary lines, no special-casing, net effect is
  correct automatically (§4.4).
- An entry's covering period is now `CLOSED` — no effect on
  readability; its historical impact appears exactly as posted (§2.1.2/
  §4.4).
- `pageSize` outside `[1, 200]`, or `page < 1` — `400`, not a silent
  clamp (§2.1.7).
- A caller with a token lacking `tenantId`/`legalEntityId` (e.g. a
  malformed or `PLATFORM_OPERATOR` token) — `403`, matching every
  existing `requireTenantId`/`requireLegalEntityId` check.
- Trial Balance for a legal entity with **zero** accounts at all — an
  empty `data: []`, `totalDebitMinor`/`totalCreditMinor` both `0`
  (trivially equal), `accountCount: 0`. Not an error.
- Trial Balance `includeZeroBalance=true` on a chart of accounts with
  many accounts and little activity — every account appears with `0`/`0`
  columns; totals still reconcile trivially.

---

## 12. Adversarial test plan (design only — not implemented)

New file `test/general-ledger.e2e-spec.ts`, same real-Postgres/synthetic-
JWT/`supertest` pattern as every existing Finance e2e spec, reusing the
existing multi-tenant/multi-entity account/period seeding conventions
already established in `accounts.e2e-spec.ts`/`journal-entries.e2e-spec.ts`.
At minimum:

**Isolation:**

- Tenant A cannot read Tenant B's account ledger/balance by id — `404`.
- Entity 1 cannot read Entity 2's account ledger/balance within the same
  tenant — `404`.
- Trial Balance for Tenant A/Entity A never includes any Tenant B or
  Entity 2 account, under any query params.
- A `periodId` belonging to a different tenant/entity — `404`/`400`.

**Status filtering:**

- A `DRAFT` entry's lines never appear in the ledger, never affect
  balance/trial-balance figures, even when its `transactionDate` falls
  squarely inside the query range.
- A `POSTED` entry's lines always appear/count, including when its
  covering period is now `CLOSED`.

**Accounts:**

- An archived (`isActive: false`) account with historical `POSTED`
  activity: ledger/balance still return real data; Trial Balance still
  includes it if its balance is nonzero, even with
  `includeZeroBalance=false`.
- An account with zero `POSTED` activity at all: ledger returns an empty
  page (not `404`); balance returns all-zero movement with a correct
  (possibly nonzero, if activity precedes the range) opening balance;
  excluded from Trial Balance by default, included when
  `includeZeroBalance=true` with `0`/`0` columns.

**Ordering/determinism:**

- Two or more `POSTED` entries sharing the same `transactionDate` — the
  ledger's order is stable and matches `journalNumber` ascending, proven
  by asserting the exact returned order across repeated calls, not just
  "some" order.
- Two lines in the same entry both touching the same account — ordered
  by `lineNumber` within the shared `(transactionDate, journalNumber)`
  key.

**Date resolution ("today" default and Trial Balance `periodId`):**

- Account Balance and Trial Balance, called with neither `asOf` nor
  `periodId`, both resolve to the current UTC calendar date — asserted
  by computing the expected value the same way the test itself would
  (`new Date().toISOString().slice(0, 10)`), not by assuming the test
  runner's local date happens to match.
- The above assertion additionally re-run with the test process's `TZ`
  environment variable set to a non-UTC value (e.g. `America/Los_Angeles`
  or `Pacific/Kiritimati` — one behind UTC, one ahead, to catch a
  day-boundary bug in either direction) to prove the resolved `asOf` is
  genuinely independent of the server's local timezone setting, not
  merely consistent in a CI environment that happens to already run as
  UTC.
- Trial Balance `periodId`: resolves to that period's `endDate` as
  `asOf`, for both an `OPEN` and a `CLOSED` period — the `CLOSED` case
  asserted explicitly (not merely "not `404`") since it's the most
  common real use of this parameter.
- Trial Balance `periodId` belonging to a different tenant, or a
  different legal entity within the same tenant — `404`, never a
  cross-scope leak.
- Trial Balance `periodId` combined with an explicit `asOf` — `400`,
  neither value silently wins.
- `TrialBalanceMeta.asOf` and `TrialBalanceMeta.periodId` in the response
  correctly reflect how the snapshot date was resolved in each of the
  three modes (explicit `asOf`, `periodId`, and the today-default) —
  `periodId` is `null` in the non-`periodId` modes, not omitted or
  empty-string.

**Balances:**

- Opening balance correctness: seed known activity before and after a
  `dateFrom`, assert the returned `openingBalanceMinor` reflects only
  the "before" activity, for both a DEBIT-normal and a CREDIT-normal
  account (proving §4.1's sign convention, not just one direction of it).
- Running balance correctness across a full page and across a page
  boundary (§2.1.6's step 3) — seed enough entries to span two pages at
  the proposed default `pageSize`, assert page 2's first row's
  `runningBalanceMinor` is correct **without ever having fetched page
  1**, proving the per-page starting-balance query is genuinely correct
  and not merely consistent with a client that happened to fetch
  sequentially.
- Account Balance's three-figure breakdown (`opening`/`movement`/
  `closing`) verified against hand-computed expected values for at least
  one DEBIT-normal and one CREDIT-normal account.

**Reversals:**

- A posted entry and its reversal both appear as independent, ordinary
  ledger lines at their own respective transaction dates; their combined
  net effect on the account's closing balance is zero (§4.4).
- Reversing an entry whose original period has since closed: the
  original's ledger/balance/trial-balance contribution is unchanged and
  still attributed to its own (closed) period; the reversal's
  contribution is attributed to its own (open) period.

**Trial Balance invariant:**

- `Σ debitMinor === Σ creditMinor` across the full response, asserted
  directly — not merely "the endpoint didn't error" — for a legal entity
  with a realistic mix of account types and at least one reversal.
- An account with an abnormal balance for its type (e.g., contrive a
  `LIABILITY` account with a net debit position via a deliberately
  constructed set of postings) lands in the debit column as a positive
  number, never the credit column as a negative one (§4.3's core
  assertion, tested directly, not just inferred from the total).
- Zero-balance accounts excluded by default, included with
  `includeZeroBalance=true`.

**Pagination:**

- A large seeded ledger (enough entries to span 3+ pages) — every page
  requested independently returns the correct slice, correct
  `runningBalanceMinor`, and correct `meta.totalItems`/`totalPages`.
- `pageSize`/`page` outside allowed bounds — `400`.

**Auth:**

- No/invalid JWT — `401`.
- A role outside `finance.viewer`/`finance.poster`/`finance.admin` (or
  no role) — `403`.
- A token missing `tenantId`/`legalEntityId` — `403`.

**No mutation side effects (explicitly, since this is the point of a
read-only increment):**

- Calling every 2d endpoint any number of times produces zero writes to
  `journal_entries`, `journal_lines`, `chart_of_accounts`,
  `accounting_periods`, or `audit_logs` — asserted directly (row counts
  unchanged before/after), not merely assumed from "the handler never
  calls `.insert()`/`.update()`."

Concurrency is deliberately **not** a first-class section here, per your
instruction — 2d is read-only and Postgres's MVCC means reads don't
block on or get blocked by writers (§8). The one place concurrency is
still worth a passing mention: a ledger page fetched mid-way through a
concurrent `post()` will simply reflect whichever entries had committed
by the time each query ran — ordinary read-committed semantics, not a
bug, not something 2d needs a special test for.

---

## 13. Verification plan (once implementation is approved and written)

Same checklist every prior increment has run, for completeness — not
run now, since no code exists yet:

- `test/general-ledger.e2e-spec.ts` alongside the full existing Finance
  e2e suite (all spec files together), real Postgres.
- New DTOs' unit tests (`*.dto.spec.ts`, mirroring the existing
  `create-*.dto.spec.ts` convention).
- `pnpm typecheck` / `pnpm lint` / `pnpm build` (monorepo-wide).
- `services/identity` e2e (unaffected, run anyway per established
  practice).
- RLS re-verification (`relrowsecurity`/`relforcerowsecurity` on every
  Finance table) and `noryx` role non-superuser re-check — unaffected by
  a read-only increment, run anyway per established practice.
- §6.3's index decision procedure: `EXPLAIN ANALYZE` against the
  Trial Balance query (and the Ledger page-boundary aggregate) using
  only the existing indexes, on a representative seeded dataset; if the
  candidate index is then added, `EXPLAIN ANALYZE` re-run to confirm the
  planner actually chooses it. Both the "deferred" and "added" outcomes
  require this evidence recorded in the implementation report — an
  index that's added but never confirmed via a re-run plan, or a
  deferral with no plan evidence at all, does not satisfy §16.

---

## 14. File changes

**Status: implemented as described below.** Every item under "new" was
created; every item under "NO CHANGE" was left untouched, confirmed via
`git diff --stat`; the one conditional item (the candidate index) was
evaluated per §6.3's procedure and DEFERRED — its migration was never
created.

```
services/sphere-finance/src/general-ledger/
  general-ledger.module.ts          (new)
  general-ledger.controller.ts      (new)
  general-ledger.service.ts         (new)
  dto/
    ledger-query.dto.ts             (new — dateFrom/dateTo/periodId/page/pageSize + cross-field validation)
    account-balance-query.dto.ts    (new — asOf | dateFrom/dateTo/periodId, mutually exclusive)
    trial-balance-query.dto.ts      (new — asOf/periodId/includeZeroBalance)
    ledger-query.dto.spec.ts        (new)
    account-balance-query.dto.spec.ts (new)
    trial-balance-query.dto.spec.ts (new)

services/sphere-finance/src/common/validators/
  is-same-or-after-date.validator.ts (new — dateTo >= dateFrom; §5.4 below explains
                                       why this can't reuse IsAfterDate as-is)

services/sphere-finance/src/common/interceptors/response.interceptor.ts
  — MODIFIED, additively: a new exported `ApiSuccessWithMeta<T, M>`
    wrapper class, and one new branch in the interceptor's existing
    `map()` callback that unwraps it into `{ ok, data, meta }` — the
    mechanism 2d's Ledger/Trial Balance routes use to put `meta`
    alongside `data` in the shared response envelope (§10), since
    `PaginatedResponse`/`PaginatedMeta` had never had a real consumer
    before 2d and nothing in the existing envelope plumbing populated a
    top-level `meta` from a handler's return value. Every other route in
    this service (Accounts, Accounting Periods, Journal Entries) returns
    a plain value, never an `ApiSuccessWithMeta` instance, so this
    interceptor change is behaviorally invisible to every route besides
    the two 2d ones that opt in — confirmed by the full existing Finance
    e2e suite passing unchanged (§13). This is the one file this
    proposal did not originally list; recorded here for an accurate,
    non-stale file-change record, same reasoning as §0.1's corrections.

services/sphere-finance/src/app.module.ts
  — add GeneralLedgerModule to imports, alongside the existing three modules.

services/sphere-finance/test/
  general-ledger.e2e-spec.ts        (new, §12)

packages/shared-types/src/api-envelope.ts
  — add `LedgerMeta extends PaginatedMeta` (§2.1.9). No change to any
    existing exported type — purely additive.

docs/finance-2d-general-ledger-read-layer-proposal.md
  — this document; already created, will be updated in place with any
    review corrections (same pattern as the 2c proposal doc's §0.1/§0.2/
    §0.3).

noryx.module.json — NO CHANGE (§0, §8).
services/sphere-finance/src/accounts/*, accounting-periods/*,
journal-entries/* — NO CHANGE, unconditionally.

services/sphere-finance/src/db/schema.ts — NO CHANGE. §6.3's
`EXPLAIN ANALYZE` procedure was run (seeded 20,000 entries / 40,000
lines for one legal entity, measured with and without the candidate
index present, and again under a narrow date filter) and found the
candidate index would not be used by the query as implemented — the
planner drives Trial Balance from `journal_lines_account_idx`
per-account, never scanning `journal_entries` in bulk by
`(tenant_id, legal_entity_id, status, transaction_date)` regardless of
whether that composite index exists. DEFERRED by evidence, not assumed
— full measurement recorded in §6.3. schema.ts's conditional exception
was therefore never invoked; this file has zero diff, the same as
every other NO-CHANGE file below.

drizzle/<timestamp>_journal_entries_entity_status_date_idx.sql — NOT
CREATED. §6.3's evidence did not justify the candidate index (above);
per the decision procedure, the migration is not generated at all.
```

**§5.4 note on the new validator**: `IsAfterDate` (2c-1) enforces strict
`>`, matching `startDate`/`endDate` on an accounting period (a
zero-length period is meaningless). A ledger/balance date **range**
needs `dateTo >= dateFrom` (a single-day range, `dateFrom === dateTo`,
is a completely valid query — "show me just this one day's activity") —
strict inequality would wrongly reject it. Proposed as a small sibling
validator rather than a parameter on `IsAfterDate`, to avoid changing
`IsAfterDate`'s existing, already-reviewed behavior for accounting
periods.

**§5.4 note on query DTOs**: this is the first place this codebase
validates `@Query()` params via a full class-validator DTO rather than
ad-hoc per-field checks in the controller body (`journal-entries.
controller.ts`'s `list()` today manually checks `status` inline, §0).
Given the number of interacting params here (`dateFrom`/`dateTo`/
`periodId`/`page`/`pageSize`/`asOf`/`includeZeroBalance`, several with
cross-field rules), a DTO is proposed as the appropriate tool rather than
replicating that ad-hoc pattern three times over — flagged explicitly as
a small, deliberate pattern extension for you to confirm rather than a
silent departure. It relies on the same global `ValidationPipe({
whitelist: true, forbidNonWhitelisted: true, transform: true })` already
configured — `transform: true` is what allows `@Type(() => Number)` to
coerce `page`/`pageSize` from query-string values.

---

## 15. Sequencing

Proposed as **one commit**, unlike 2c's 2c-1/2c-2 split. The reasoning
2c-1/2c-2 split on — separating lower-risk scaffolding from
higher-risk, invariant-critical write logic — doesn't apply here: 2d
introduces no mutation, no new invariant, and no concurrency design
(§6/§8), and carries **no schema change by default** — the one
conditional exception (§6.3/§14: `journal_entries_entity_status_date_idx`,
added only if `EXPLAIN ANALYZE` evidence justifies it) is discovered and
resolved during this same implementation pass, not as a follow-up
increment, so if it's justified its migration lands in the same commit
alongside the code and evidence that justified it — never a schema
change reviewed separately from the query it exists to serve. The three
endpoints share one service, one
module, one query-pattern foundation (§4.1's `normalBalanceFor` helper
is used by all three); splitting them into separate reviewed increments
would mostly just delay reviewing accounting logic that's easiest to
evaluate together (the reviewer can directly compare, e.g., §2.1.6's
signed running-balance convention against §4.3's deliberately different
trial-balance column convention in one sitting). Flagged as a proposal,
not a unilateral decision — happy to split into three if you'd prefer
smaller reviewed increments, matching the established willingness to
split when you asked for it in 2c.

**Resolved**: §6.3's index decision came back DEFERRED (evidence in
§6.3), so the conditional exception above was never invoked — this
shipped as the single commit originally proposed, with no migration.

---

## 16. Acceptance criteria — all verified

- [x] Account Ledger: correct opening balance, correct running balance
      (including across page boundaries computed independently, §12),
      correct deterministic ordering, `DRAFT` excluded, `POSTED`
      included regardless of period open/closed state, archived accounts
      readable, tenant/entity isolation proven, pagination bounds
      enforced. Verified by `test/general-ledger.e2e-spec.ts`'s "Account
      Ledger" suite.
- [x] Account Balance: correct three-figure breakdown in both `asOf` and
      range modes, correct sign convention proven for both DEBIT-normal
      and CREDIT-normal account types, zero-activity handled without
      error, archived accounts readable. Verified by the same file's
      "Account Balance" suite.
- [x] Trial Balance: `Σdebit === Σcredit` proven directly (not inferred),
      abnormal-balance accounts placed by sign not by type, archived
      accounts with nonzero balance always included regardless of
      `includeZeroBalance`, zero-balance default-exclusion and opt-in
      both verified, ordered by code, unpaginated. Verified by the same
      file's "Trial Balance" suite.
- [x] Zero new mutation routes; zero new audit-log writes; zero new
      write-side concurrency controls. Verified by the "no mutation side
      effects" test (row counts unchanged before/after every 2d route).
- [x] Zero changes to `accounts/*`, `accounting-periods/*`,
      `journal-entries/*`, `noryx.module.json`, or `db/schema.ts` —
      confirmed via `git diff --stat`; the schema.ts conditional
      exception was evaluated (§6.3) and not invoked (DEFERRED).
- [x] Full monorepo `typecheck`/`lint`/`build` clean (all 9 packages);
      full Finance e2e suite (all 5 spec files, 151 tests) green, run
      twice plus 3 additional isolated re-runs of the new spec file for
      flakiness; Identity e2e green; RLS
      (`relrowsecurity`/`relforcerowsecurity` on all 5 Finance tables)
      and `noryx` role non-superuser re-verified — both unaffected, as
      expected for a schema-free increment.
- [x] §6.3's candidate index decision made by evidence, not by default:
      `EXPLAIN ANALYZE` run against the real query plan (20k
      entries/40k lines seeded, one legal entity) on existing indexes
      first, then again with the candidate index physically present,
      then again under a narrow date filter — all three showed the
      planner never uses it (drives from `journal_lines_account_idx`
      per-account instead). **DEFERRED.** Full evidence in §6.3; scratch
      seed data and the test index were both removed after measurement.
- [x] Account Balance's and Trial Balance's `asOf` default resolved via
      §4.8's deterministic UTC-calendar-date convention — proven
      independent of the application/database server's local timezone
      by a test that swaps `process.env.TZ` to UTC+14 and UTC-12 and
      confirms the resolved date is unchanged (§12).
- [x] Trial Balance `periodId` semantics match §5.1.2 exactly: scoped
      404, `endDate` used as `asOf`, `CLOSED` periods fully readable,
      `periodId`+`asOf` rejected `400`, resolved `asOf`/`periodId`
      returned in `TrialBalanceMeta` — each individually verified in
      `test/general-ledger.e2e-spec.ts`.

---

**2d is implemented, verified, and closed.** This is the last increment
on the original Finance Core roadmap (`docs/finance-journal-engine-proposal.md`
§12). No further Finance capability is started beyond 2d without new,
explicit authorization.
