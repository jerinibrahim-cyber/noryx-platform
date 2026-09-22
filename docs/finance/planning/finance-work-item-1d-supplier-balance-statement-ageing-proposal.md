# Finance Work Item 1d — Supplier Balance, Supplier Statement & AP Ageing

Status: **approved for direct implementation** — the user's kickoff instruction
for this Work Item specified scope, endpoints, DB approach ("prefer
read-layer... do NOT create a new AP ledger table"), accounting rules, and
test coverage in full detail, and the original AP Foundation proposal
(`docs/finance-work-item-1-ap-foundation-proposal.md` §16/§17/§23) already
named the three routes, their RBAC posture, and the reconciliation invariant
this Work Item implements — so per the standing instruction "if the existing
roadmap/proposal already resolves the design decisions, proceed directly to
implementation," this document records the design as built rather than
gating on a separate approval round.

## 0. What was read before writing any code

- `docs/finance-work-item-1-ap-foundation-proposal.md` — §9/§10 (AP posts
  real journal rows, GL needs zero AP-specific code), §16 (route table,
  including the three routes this Work Item implements verbatim), §17
  (named test files: `ap-reports.e2e-spec.ts`, `ap-gl-reconciliation.e2e-spec.ts`),
  §19 (no "payment on account"), §23/§10 (the reconciliation invariant).
- `docs/finance-work-item-1b-supplier-bills-proposal.md` and
  `docs/finance-work-item-1c-supplier-payments-proposal.md` — confirms
  `supplier_bills.paid_minor`/`payment_status` and
  `supplier_payment_allocations` are the only writers this Work Item reads
  from, and that AP-1c's own §13 explicitly deferred "AP-1d — supplier
  balance, statement, ageing endpoints" to this Work Item.
- `docs/finance-2d-general-ledger-read-layer-proposal.md` and
  `src/general-ledger/general-ledger.service.ts` — the report-read-layer
  conventions this Work Item reuses directly: `REPORT_TX_CONFIG`
  (REPEATABLE READ + READ ONLY, already exported for cross-file reuse — see
  `test/general-ledger-concurrency.e2e-spec.ts`'s own import of it), raw
  `tx.execute(sql\`...\`)`for aggregates the query builder can't cleanly
express,`toNumber()`/date-normalization helpers, the `asOf`-vs-range query
convention, and `GeneralLedgerController`'s "`@Controller()`with full
per-method paths" shape (reused here for the same reason: routes live under
two different prefixes,`suppliers/:id/...`and`ap/...`).
- `src/db/schema.ts` (full) — confirms every table this Work Item needs
  already exists: `supplier_bills` (`total_minor`, `paid_minor`,
  `payment_status`, `due_date`, `status`), `supplier_payments`
  (`payment_amount_minor`, `status`, `payment_date`),
  `supplier_payment_allocations` (`allocated_amount_minor`, links payment to
  bill), `ap_settings` (`ap_control_account_id`), `journal_entries`/
  `journal_lines` (already the AP control account's ledger, no AP-specific
  columns). No `VOID` bill/payment status exists anywhere in the schema —
  the void/credit-note workflow is out of scope for every AP Work Item so
  far, so "exclude VOID bills" below is satisfied vacuously (there is
  nothing to exclude yet) and documented as such rather than silently
  dropped.
- `src/accounts-payable/supplier-payments/supplier-payments.service.ts`
  and `.../supplier-bills/supplier-bills.service.ts` (full) — confirms the
  exact posting semantics this Work Item's read queries must respect: only
  `status = 'POSTED'` bills/payments carry real balances, `paid_minor` is
  updated by `SupplierPaymentsService.post()` alone, and a payment's
  `supplier_id` always matches every bill it allocates to (validated at
  create/edit and re-validated at posting) — so a per-supplier aggregate
  can key off either `supplier_bills.supplier_id` or
  `supplier_payments.supplier_id` without a join-through-allocations
  ambiguity risk.
- `src/accounts-payable/accounts-payable.module.ts` — its own doc comment
  already anticipates this Work Item: "AP-1d (AP Reporting) adds its own
  feature module as a sibling import here."
- `src/route-role-matrix.spec.ts` — the repo-wide reflection test every new
  controller must be added to (import + `discoverRoutes()` + `EXPECTED`
  entries).

## 1. Scope

**In scope** (per the user's kickoff instruction, all four numbered areas):

1. Supplier balance — current and as-of-date outstanding payable per
   supplier (total billed, total paid, total outstanding), reconciled
   against `supplier_payment_allocations` + posted `supplier_bills`.
2. Supplier statement — chronological bill/payment/allocation history for
   one supplier with opening balance, running balance, closing balance,
   date filtering.
3. AP ageing — bucketed (Current, 1-30, 31-60, 61-90, 91-120, 120+) report
   across all suppliers in a legal entity, using outstanding-after-
   allocations, excluding DRAFT bills, as-of-date configurable, per-supplier
   rows plus report-wide totals.
4. AP/GL reconciliation — an explicit invariant proving
   `sum(all supplier outstanding balances) = AP control account balance`,
   exposed as both a dedicated read endpoint and a dedicated e2e test.

**Out of scope** (explicit, restated from the kickoff instruction — nothing
below is touched):

AP hardening, Milestone 3.x, Accounts Receivable, Banking/reconciliation
(bank feeds), Cash management, Tax engine, FX/multi-currency, Fixed assets,
budgeting, any new supplier-payment functionality beyond what AP-1c already
shipped, credit notes/void workflow, UI. No change to the Journal Engine, to
`JournalEntriesModule`/`Service`/`Controller`, to the General Ledger read
layer, or to AP-1a/1b/1c's own schema, services, or accounting semantics —
this Work Item is additive read-only code on top of data those Work Items
already write correctly (no correctness defect was found in them during
this Work Item's implementation; see §9).

## 2. What's reused unmodified

Every table in §0's schema list, every RLS policy already applied to those
tables, every RBAC role (`finance.viewer`/`finance.poster`/`finance.admin`),
`withTenant()`/`TxClient`, `@noryx/auth-core`'s guards/decorators,
`ApiSuccess`/`ApiSuccessWithMeta` response envelopes, `REPORT_TX_CONFIG`
(imported directly from `general-ledger.service.ts`, not duplicated — it is
already exported specifically for reuse), and the `route-role-matrix.spec.ts`
reflection-test pattern.

## 3. Database — no new tables, no new migration

Per the kickoff instruction's explicit steer ("prefer read-layer/query
implementation over unnecessary new tables... do NOT create a new AP ledger
table if the existing posted supplier bills + payment allocations already
provide the authoritative AP sub-ledger"): this Work Item adds **zero**
schema changes. `supplier_bills.total_minor`/`paid_minor`/`status`/
`due_date`, `supplier_payments.status`/`payment_date`/`payment_amount_minor`,
and `supplier_payment_allocations.allocated_amount_minor` are already the
complete, authoritative AP sub-ledger — every number this Work Item reports
is derivable from them with plain `SELECT`s. No `drizzle/rls/*.sql`, no
`drizzle/constraints/*.sql`, no migration file, no schema.ts change.

## 4. Module layout

A new sibling module under `accounts-payable/`, exactly as
`accounts-payable.module.ts`'s own doc comment anticipated:

```
src/accounts-payable/ap-reports/
  ap-reports.service.ts
  ap-reports.controller.ts
  ap-reports.module.ts
  dto/supplier-balance-query.dto.ts (+ .spec.ts)
  dto/supplier-statement-query.dto.ts (+ .spec.ts)
  dto/ap-ageing-query.dto.ts (+ .spec.ts)
  dto/ap-reconciliation-query.dto.ts (+ .spec.ts)
```

Wired into `accounts-payable.module.ts`'s `imports` array as a sibling of
`SupplierBillsModule`/`SupplierPaymentsModule`.

## 5. Endpoints

Verbatim from the AP Foundation proposal's own route table (§16), plus one
addition (`ap/reconciliation`) this Work Item's kickoff instruction asks for
that the original sketch left as a test-only invariant (§10/§23 there):

```
GET /v1/finance/suppliers/:id/balance      open payable balance        any finance.* role
GET /v1/finance/suppliers/:id/statement    bill/payment history         any finance.* role
GET /v1/finance/ap/ageing                  bucketed ageing report       any finance.* role
GET /v1/finance/ap/reconciliation          sub-ledger/GL reconciliation any finance.* role
```

All four are pure reads — same RBAC posture as `GeneralLedgerController`
(`@Roles("finance.viewer", "finance.poster", "finance.admin")` on every
route, no write-side split to make since nothing here mutates), not
`SupplierBillsController`/`SupplierPaymentsController`'s poster-writes/
any-role-reads split, which exists specifically for transactional/posting
documents this module has none of.

Controller shape mirrors `GeneralLedgerController` exactly: `@Controller()`
with no prefix, each method supplying its own full path — the same
"routes live under more than one path prefix inside one controller" case
GL already established (`accounts/:id/ledger` + `trial-balance` in one
controller), reused here for `suppliers/:id/...` + `ap/...`.

`tenantId`/`legalEntityId` always come from the verified JWT via
`requireTenantContext()`, never from a request param/body — identical
convention to every other Finance controller.

## 6. Design decisions and their reasoning

### 6.1 Supplier Balance — two-mode `asOf`

Mirrors `GeneralLedgerService.getBalance`'s own asOf-vs-current split,
adapted to the sub-ledger:

- **Current mode** (no `asOf` given): `totalBilledMinor`/`totalPaidMinor`
  are summed directly from `supplier_bills.total_minor`/`paid_minor` for
  this supplier's `POSTED` bills — the same stored, already-invariant-tested
  fields `SupplierPaymentsService.post()` maintains. Cheapest query, and
  guaranteed numerically identical to the reconciliation invariant's own
  sub-ledger side (§6.4) for "as of today" reports, since both read the same
  columns.
- **As-of mode** (`asOf` given): a bill only counts if `bill_date <= asOf`
  (`totalBilledMinor`), and a payment allocation only counts toward
  `totalPaidMinor` if **both** its payment's `payment_date <= asOf` **and**
  its bill's `bill_date <= asOf` — reconstructing what was actually billed
  and paid by that date, rather than reporting today's `paid_minor` (which
  reflects every payment ever posted against the bill, including one dated
  after `asOf`). This is a real historical reconstruction, not merely a
  different bucket boundary — necessary because `paid_minor` has no
  date-versioned history of its own.

`totalOutstandingMinor = totalBilledMinor - totalPaidMinor` in both modes.
A supplier with zero posted bills returns all-zero totals (empty case),
never a 404 — only a nonexistent/out-of-scope `supplierId` 404s (mirrors
`GeneralLedgerService.resolveAccount`'s convention).

### 6.2 Supplier Statement — chronological rows + running balance

One flat, date-sorted list mixing two row kinds — `BILL` (a posted bill
dated in range: `+totalMinor`, increases the amount owed) and `PAYMENT` (a
posted payment dated in range: `-paymentAmountMinor`, decreases it) — sorted
by `(date, internalReference)` ascending (the two prefixes, `BILL-` and
`PAY-`, never collide, and `internalReference` is zero-padded/fixed-width
within each prefix per AP-1b/1c's own numbering convention, so lexicographic
order matches numeric order — the identical reasoning
`general-ledger.service.ts`'s doc comment already gives for sorting
`journal_number` as a string).

`openingBalanceMinor` reuses §6.1's as-of-mode computation, evaluated
strictly before `dateFrom` when `dateFrom` is given, else `0` — the same
"only compute a real opening balance if a lower bound exists" convention
`GeneralLedgerService.getLedger` already uses. `closingBalanceMinor` is
simply the final running value (or the opening value, if no rows fall in
range). Each `PAYMENT` row additionally carries its own `allocations` array
(`billId`, the bill's `internalReference`, `allocatedAmountMinor`) so the
statement satisfies "payment allocations" as a visible structural element
without needing a second, separate endpoint or a second list of rows to
reconcile against the first.

Deliberately **not** phrased as `debitMinor`/`creditMinor` (GL terminology,
where the AP control account is credit-normal — a bill is a _credit_ to
that account from the ledger's perspective). A supplier statement is a
sub-ledger artifact read from the supplier's own point of view ("what do I
owe them"), so a signed `amountMinor` plus an explicit `type` field is
clearer and avoids leaking GL sign convention into a document a supplier-
facing report is meant to read naturally.

### 6.3 AP Ageing — current outstanding, `asOf`-relative buckets only

`outstandingMinor` per bill is always `total_minor - paid_minor` (current
stored value, i.e. "after payment allocations" exactly as instructed) —
**not** a date-filtered historical reconstruction the way Balance's as-of
mode is. `asOf` only changes which bucket a bill's `due_date` falls into
(`daysPastDue = asOf - due_date`), not the outstanding amount itself. This
is a deliberate, bounded design choice, not a gap: an ageing report answers
"how overdue would today's open balances have been as of this date," which
is the standard meaning of an ageing report's `asOf` parameter industry-wide
— it is not a request to replay history and recompute what was owed back
then (that is what Balance's as-of mode is for, and exists separately).
Documented explicitly here rather than left implicit, since it is the one
place this Work Item's two report endpoints use `asOf` with genuinely
different semantics.

Bucketing: `daysPastDue <= 0` → **Current / Not Due** (covers not-yet-due
and due-today); `1-30`, `31-60`, `61-90`, `91-120` inclusive ranges; `> 120`
→ **120+**. A bill with a `null` due_date (schema allows it — AP-1b never
requires one) is bucketed as **Current / Not Due**: with no due date there
is no defensible overdue determination to make, and silently excluding it
would understate the report's own total, so it is included at the
least-alarming bucket rather than dropped.

Only `POSTED` bills with `outstandingMinor > 0` are considered — `DRAFT`
bills are excluded (never posted, so never a real payable), and a bill fully
settled (`outstandingMinor = 0`) is excluded entirely rather than appearing
in every bucket at zero, matching the instruction's "unpaid amounts that
have already been fully settled" exclusion. A supplier with no bills in any
nonzero bucket does not appear as a report row at all (avoids a report full
of all-zero supplier rows); report-level totals sum only over rows that do
appear, so they always equal the sum of the visible per-supplier rows.

### 6.4 AP/GL Reconciliation — the invariant, as both an endpoint and a test

Sub-ledger side: `sum(total_minor - paid_minor)` across every `POSTED`
`supplier_bills` row in the legal entity (current mode; an `asOf` param
applies the same historical reconstruction as Balance's as-of mode,
aggregated legal-entity-wide instead of per-supplier — one shared private
helper serves both, parameterized by an optional `supplierId`).

GL side: the AP control account's own closing balance, computed the same
way `GeneralLedgerService.getBalance` computes any liability account's
balance (credit-normal sign, `SUM(credit_minor) - SUM(debit_minor)` over
every `POSTED` `journal_lines` row for that account up to `asOf`) — this
Work Item does not import `GeneralLedgerService` (its balance method isn't
exported as a standalone helper other services can call without also
resolving an `accountId` path param), so the equivalent raw-SQL aggregate is
written locally here, following the exact same query shape and sign
convention `general-ledger.service.ts` already documents, not inventing a
second accounting mechanism — same tables, same `status = 'POSTED'` filter,
same sign-by-type rule.

`reconciled = subLedgerTotalMinor === glControlAccountBalanceMinor`;
`differenceMinor` is reported alongside so a real drift (were one ever to
occur) is diagnosable from the response itself, not just a boolean. This is
exactly the property AP-1a's own proposal (§10) predicted must always hold
if AP's posting logic is correct, and treated as "a natural, hard invariant"
worth a dedicated always-run test rather than an assumption — this Work Item
makes it directly queryable, not just test-asserted.

## 7. Accounting rules respected (no changes)

`POSTED`-only filtering throughout (bills and payments); payment allocations
read as-is, never recomputed or re-validated (that already happened at
`SupplierPaymentsService.post()` time — this Work Item only reads the
settled result); no interaction with accounting-period open/closed status
(read access never depends on postability, identical posture to
`GeneralLedgerService.resolvePeriodInScope`'s own doc comment); legal-entity
and supplier scoping applied as an explicit predicate on every query, RLS
still applies underneath for `tenant_id`; no write of any kind, anywhere in
this Work Item's code — no audit-log rows either (reads are never audited
anywhere in this codebase, same convention `general-ledger.service.ts`
documents for its own read layer). No genuine correctness defect was found
in AP-1a/1b/1c's accounting semantics while building this Work Item — had
one been found, this document would stop and report it rather than
silently redesigning anything, per the kickoff instruction.

## 8. Concurrency

No new concurrency-sensitive behavior is introduced — every query here is a
plain multi-statement read, using `REPORT_TX_CONFIG` (REPEATABLE READ + READ
ONLY) for the identical reason `general-ledger.service.ts` adopted it: a
report built from several separate `SELECT`s needs one consistent snapshot
across all of them, or a concurrent bill/payment posting between two of a
report's own statements could produce a response whose parts don't
reconcile with each other. No `SELECT ... FOR UPDATE` anywhere (a read never
blocks on, or is blocked by, a writer's row lock under Postgres MVCC — same
reasoning `general-ledger.service.ts` gives). Per the kickoff instruction's
"add concurrency tests only where the actual implementation introduces
concurrency-sensitive behavior" — none does, so no dedicated
`ap-reports-concurrency.e2e-spec.ts` is added; ordinary posting concurrency
is already covered by `ap-payment-concurrency.e2e-spec.ts` (AP-1c) and
`ap-bill-concurrency.e2e-spec.ts` (AP-1b).

## 9. Tests

New spec files under `services/sphere-finance/test/`, real Postgres,
following the established harness exactly (`tokenFor()`, full Nest app
boot with the same pipe/interceptor/filter wiring as every other e2e spec):

- `ap-supplier-balance.e2e-spec.ts` — no transactions, one unpaid bill,
  multiple bills, partial payment, full payment, multiple payments,
  multiple suppliers, as-of-date behavior, cross-tenant isolation,
  cross-legal-entity isolation.
- `ap-supplier-statement.e2e-spec.ts` — opening balance, bills, payments,
  allocations, running balance, date ranges, chronological ordering, empty
  statement, isolation.
- `ap-ageing.e2e-spec.ts` — current/not due, every bucket, partial payment,
  fully-paid-bill exclusion, multiple suppliers, as-of date, report totals,
  reconciliation to supplier balances.
- `ap-gl-reconciliation.e2e-spec.ts` — the §6.4 invariant: sub-ledger total
  equals the GL control-account balance, across multiple bills, multiple
  payments, partial settlement, multiple suppliers, legal-entity isolation
  — the named test file from the AP Foundation proposal's own §17.
- DTO unit specs (`*.dto.spec.ts`) for all four new query DTOs.
- `route-role-matrix.spec.ts` extended: import `ApReportsController`, add
  it to `discoverRoutes()`, add its 4 `EXPECTED` entries (36 → 40 routes).

## 10. What's still deliberately left for later

Everything named out-of-scope in §1. Within this Work Item's own subject
area specifically: no pagination on the statement or ageing endpoints (a
per-supplier statement or a legal entity's ageing report is bounded by real
business data volume, not unbounded like a general ledger across every
account — matching the Trial Balance precedent, which also has no
pagination, §5.1.5 of the 2d proposal); no CSV/PDF export (a UI/reporting-
layer concern, out of scope for every Finance Work Item so far); no
supplier-statement PDF/email delivery (same reasoning); no configurable
bucket widths beyond the six named buckets (the instruction names them
explicitly as "configurable/as-of-date" referring to the as-of date being
configurable, not the bucket boundaries themselves — six fixed buckets is
the entire named requirement).
