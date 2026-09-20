# Finance Work Item 1c — Supplier Payments & Settlement

Implementation-readiness proposal. Builds directly on AP-1a (`fdcc2b7`,
`docs/finance-work-item-1-ap-foundation-proposal.md`) and AP-1b
(`870a35e`, `docs/finance-work-item-1b-supplier-bills-proposal.md`) —
this document only states what AP-1c adds and where it deviates from
those two documents' original forward-looking sketches; it does not
re-derive conventions those already settled.

## 0. What was read

`docs/roadmap.md` (current Finance-First strategy — AP-1c is listed
`PLANNED`, no active hardening milestone competes for this cycle);
`docs/finance-work-item-1-ap-foundation-proposal.md` in full (§5–§9,
§14–§21 — the original AP Foundation proposal already sketched
`supplier_payments`/`supplier_payment_allocations` DDL, the payment
lifecycle, the locking strategy, and the explicit non-goals);
`docs/finance-work-item-1b-supplier-bills-proposal.md` (§24 — the two
decisions AP-1b explicitly deferred to this Work Item); the current
`schema.ts` (all tables through AP-1b); `supplier-bills.service.ts` in
full (the exact posting-transaction shape to replicate);
`005_supplier_bills_immutability_trigger.sql`, `004_ap_bills_rls.sql`,
`db.ts`, `route-role-matrix.spec.ts`, `suppliers.controller.ts`.

## 1. Scope

**In scope:** supplier payment master (draft create/edit/delete/post),
payment allocation against one or more `POSTED` bills, partial and full
settlement, posting through the Journal Engine (direct
`journal_entries`/`journal_lines` insertion, same as AP-1b), bill
`paid_minor`/`payment_status` updates, concurrency-safe multi-bill
locking, RLS/RBAC/audit/immutability matching AP-1a/1b exactly, e2e
coverage including GL integration, concurrency, and a sub-ledger/GL
reconciliation invariant test.

**Out of scope** (per the user's explicit boundary and/or the AP-1a
proposal's own §19 non-goals, restated narrowly for this Work Item):

- AP-1d — supplier balance, statement, ageing endpoints (`GET
/suppliers/:id/balance`, `/statement`, `/ap/ageing`). AP-1c produces
  exactly the data those need (`supplier_bills.paid_minor`/`total_minor`,
  `supplier_payment_allocations`); it does not expose any read endpoint
  for it. `GET /bills` gains one additional filter (`paymentStatus`) so
  a caller can find candidate bills to allocate against — a minimal,
  direct enabler of AP-1c's own allocation flow, not an AP-1d report.
- Credit/debit notes, void/unwind of a posted payment or bill — AP-1a
  §19 non-goal, restated by the user this cycle. No state hook is added
  for this; there is no code path today that would need one.
- Banking & reconciliation — payments post against a manually-selected
  `chart_of_accounts` row (type `ASSET`), no bank-account entity, no
  bank feed, no reconciliation (AP-1a §19/§20).
- FX/multi-currency conversion — payment currency is always the legal
  entity's functional currency, resolved server-side exactly like bills
  and journal entries (AP-1a §14).
- "Payment on account" (partial allocation of the payment itself,
  leaving cash unapplied) — AP-1a §19 non-goal, carried forward: posting
  requires `SUM(allocations.amountMinor) === paymentAmountMinor`
  exactly. See §7 below for why this is not re-litigated as a new
  decision.
- Journal Engine modification — zero changes, same as AP-1a/1b. No
  integration gap requires one.
- Any hardening/3.x work — untouched.

## 2. What's reused unmodified

`journal_entries`/`journal_lines`/`journal_number_counters` (payments
draw journal numbers from the same `JE-NNNNNN` sequence bills use — no
AP-only series, literally "posts through the existing Journal Engine");
`ap_settings` (the same `apControlAccountId` bills already debit/credit
is the account payments debit); `suppliers`; `accounting_periods`
resolution/locking helper shape; `audit_logs`; `@noryx/auth-core`
guards/decorators; the General Ledger read layer (unmodified — a posted
payment's lines appear in `/accounts/:id/balance`, `/ledger`,
`/trial-balance` automatically, proven the same way AP-1b proved it for
bills).

## 3. Database schema

```
ap_payment_number_counters                  -- see §12 decision 1
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  last_assigned_number  integer, not null, default 0
  PRIMARY KEY (tenant_id, legal_entity_id)

payment_method enum('BANK_TRANSFER','CHEQUE','CASH','CARD','OTHER')
supplier_payment_status enum('DRAFT','POSTED')   -- two-value, matches
                                                   -- journal_entries/
                                                   -- supplier_bills exactly

supplier_payments
  id                    uuid PK, default random
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  supplier_id           uuid, not null, FK -> suppliers.id
  internal_reference    varchar(20), nullable       -- "PAY-000123", assigned at posting only
  status                supplier_payment_status, not null, default 'DRAFT'
  payment_date          date, not null
  currency_code         varchar(3), not null         -- resolved server-side, never client-supplied
  payment_amount_minor  bigint, not null              -- the actual cash amount; must equal
                                                        -- SUM(allocations) to post — §7
  payment_method        payment_method, not null
  bank_cash_account_id  uuid, not null, FK -> chart_of_accounts.id   -- validated ACTIVE + type ASSET
  reference              varchar(100), nullable        -- free-text external ref (cheque #, transfer ref)
  memo                  text, nullable
  journal_entry_id      uuid, nullable, FK -> journal_entries.id     -- set once, at posting
  period_id             uuid, nullable, FK -> accounting_periods.id  -- set once, at posting
  created_by, posted_by uuid, nullable
  posted_at             timestamptz, nullable
  created_at, updated_at  timestamptz, not null
  UNIQUE (tenant_id, legal_entity_id, internal_reference)   -- NULL-distinct, same as bills/journal entries
  INDEX (tenant_id, legal_entity_id)
  INDEX (supplier_id)
  CHECK (payment_amount_minor > 0)

supplier_payment_allocations
  id                     uuid PK, default random
  tenant_id              uuid, not null            -- denormalized, own RLS policy, same as supplier_bill_lines
  payment_id             uuid, not null, FK -> supplier_payments.id, ON DELETE CASCADE
  bill_id                uuid, not null, FK -> supplier_bills.id
  allocated_amount_minor bigint, not null
  created_at             timestamptz, not null
  UNIQUE (payment_id, bill_id)   -- at most one allocation row per (payment, bill) pair
  INDEX (bill_id)
  CHECK (allocated_amount_minor > 0)
```

**`supplier_bills` change** — one CHECK constraint swap, no column
change: `supplier_bills_paid_minor_zero_until_ap1c` (`paid_minor = 0`)
is dropped and replaced with `supplier_bills_paid_minor_within_total`
(`paid_minor >= 0 AND paid_minor <= total_minor`) — exactly the range
both the AP-1a original sketch and AP-1b's proposal §24 item 3 already
named as this Work Item's job to loosen it to. `payment_status` gets its
first real writer here; no enum change (`UNPAID`/`PARTIALLY_PAID`/`PAID`
already exist).

No other existing table changes.

## 4. Relationships

```
suppliers ──< supplier_payments ──> chart_of_accounts (bank_cash_account_id)
                    |         └──> journal_entries (journal_entry_id, set at posting)
                    |         └──> accounting_periods (period_id, set at posting)
                    |
                    └──< supplier_payment_allocations >── supplier_bills
                               (many-to-many: one payment can pay several bills,
                                one bill can be paid by several payments over time)

ap_payment_number_counters (1 row per tenant+legal entity)
```

## 5. Lifecycle

**Payment posting-lifecycle (`status`)** — identical shape to bills:

```
DRAFT ──(POST /payments/:id/post)──> POSTED   (terminal; no reopen, no void — §1)
  └──(DELETE /payments/:id, DRAFT only)──> [deleted]
```

A payment is created DRAFT with its allocations in the same request
(mirrors bill+lines), editable in full (header + full-array allocation
replacement, same convention as `UpdateSupplierBillDto`) while DRAFT,
and becomes immutable in full once POSTED — see §11 (no narrow
exception here, unlike `supplier_bills`: no future writer is known for
any column on a posted payment within the current locked roadmap;
should AP-1e/a correction work item ever need one, that migration adds
it then, the same way AP-1b's own narrow exception was added ahead of
its AP-1c consumer).

**Bill payment-lifecycle (`payment_status`)** — already defined by
AP-1a §7, exercised here for the first time:

```
UNPAID ──(allocation posted, 0 < paid_minor < total_minor)──> PARTIALLY_PAID ──(paid_minor = total_minor)──> PAID
UNPAID ──(allocation posted, paid_minor = total_minor in one step)────────────────────────────────────────> PAID
```

Only ever moves forward (more paid) — no "unapply" action (§1).

## 6. Posting / accounting treatment

Two-line balanced entry, always:

```
DEBIT  ap_settings.apControlAccountId   payment_amount_minor   -- reduces the AP liability
CREDIT payment.bankCashAccountId        payment_amount_minor   -- reduces the bank/cash asset
```

No tax leg (a payment has no tax component — tax is a bill-line concept,
already fully handled at bill-posting time). Memo:
`Payment ${internalReference} to supplier ${supplier.name}` (or similar,
finalized during implementation to match `SupplierBillsService`'s memo
convention).

## 7. Allocation rules & why "full allocation" is not re-opened for approval

`SUM(allocations.allocatedAmountMinor) === payment.paymentAmountMinor`
is required to post — no partially-allocated ("on account") payment in
this Work Item. This is not a new decision: AP-1a §15/§19 already states
it explicitly as the approved design ("Posting requires
`SUM(allocations.amountMinor) === amount_minor`" / "'Payment on
account'... a payment must fully allocate at posting time in this Work
Item"), and nothing since has revisited it. Per the user's instruction
("if the existing roadmap/proposal already resolves the design
decisions, proceed directly to implementation"), this is implemented
as-is, not listed in §12.

Per-bill rule, validated under lock at posting (re-validated
independently of whatever was true at draft creation/edit time — same
posture as bill-line account re-validation in AP-1b):

- the target bill's `status` must be `POSTED` (a DRAFT bill has no
  settled `total_minor` to pay against);
- the target bill's `(tenant_id, legal_entity_id, supplier_id)` must
  match the payment's own — a payment can only allocate against its own
  supplier's bills;
- `allocation.allocatedAmountMinor <= bill.totalMinor - bill.paidMinor`
  (the bill's current outstanding balance) — the over-allocation guard.

At create/edit time (DRAFT), allocations are validated for shape (bill
exists, belongs to the same supplier/tenant/entity — 400) but _not_ for
sufficient remaining balance, since that balance can legitimately change
before posting (another payment might post first) — exactly the same
create-time-vs-post-time validation split AP-1b established for bill
line accounts (400 at create, 422 at posting).

## 8. Concurrency strategy

Mirrors `SupplierBillsService.post()`'s transaction shape (§8 of the
AP-1b proposal), extended for multi-row bill locking:

1. Lock the payment header (`SELECT ... FOR UPDATE`) — first statement.
2. `status === DRAFT` check.
3. `allocations.length >= 1` check (a payment must allocate to post — no
   bare unapplied payment, consistent with §7).
4. Validate `bank_cash_account_id` is still an ACTIVE `ASSET` account in
   scope (re-validated, same posture as bill-line accounts).
5. Load AP settings (422 if unconfigured, same as bills).
6. Resolve + lock the covering `OPEN` accounting period for
   `payment_date`.
7. **Lock every allocated bill in one statement, in a fixed order**:
   `SELECT * FROM supplier_bills WHERE id = ANY($ids) AND tenant_id = $1
AND legal_entity_id = $2 ORDER BY id FOR UPDATE` — ascending `id`
   guarantees two concurrent payments that both touch an overlapping
   bill set always acquire row locks in the same relative order, so
   neither can deadlock the other (this is the AP-1a proposal's own
   §15 locking strategy, applied literally).
8. Re-validate each locked bill: `status = POSTED`, same supplier, and
   `allocatedAmountMinor <= totalMinor - paidMinor` — 422 on any
   violation, whole transaction rolls back (no burned payment number).
9. Allocate payment number (`ap_payment_number_counters`, §12
   decision 1) and journal number (shared `journal_number_counters`).
10. Insert the journal entry **as DRAFT**, insert its 2 lines, **then**
    `UPDATE` to `POSTED` — the exact ordering fix AP-1b's own e2e
    verification caught (`journal_lines_immutable` rejects any INSERT
    once the parent is already `POSTED`). Implemented correctly from
    the start this time, not re-discovered.
11. For each allocated bill: `UPDATE supplier_bills SET paid_minor =
paid_minor + $alloc, payment_status = <recomputed> WHERE id = $id`
    — **critically, this UPDATE must not include `updated_at` in its
    SET clause**. `005_supplier_bills_immutability_trigger.sql` rejects
    any change to a POSTED row's `updated_at` alongside `paid_minor`/
    `payment_status` (it checks `updated_at` is unchanged, by design —
    AP-1b §19). Recomputation: `paidMinor === totalMinor ⇒ PAID`,
    `0 < paidMinor < totalMinor ⇒ PARTIALLY_PAID`.
12. Commit the payment's own transition (`status`, `internalReference`,
    `journalEntryId`, `periodId`, `postedBy`, `postedAt`).
13. Audit: one `POST` row for the payment, one `CREATE` row for the new
    journal entry (mirrors AP-1b's dual-audit shape), and one `UPDATE`
    row per allocated bill recording its `paidMinor`/`paymentStatus`
    transition — "audit all financially significant state changes"
    (the user's explicit scope item 6) makes each bill's settlement
    effect its own auditable event, not folded silently into the
    payment's own audit row.

A failure at any step rolls the whole transaction back — no burned
payment/journal number, no partial bill update, no orphaned journal
entry, from a failed post. Same guarantee AP-1b already established.

**No new DB-level cross-table trigger** for the
`SUM(allocations) = payment_amount_minor` invariant. This mirrors the
AP-1a proposal's own explicit reasoning (§10): a cross-table trigger
spanning `supplier_payment_allocations`/`supplier_payments` is more
invasive than the value it adds at this stage; the transactional,
row-locked service logic plus the e2e reconciliation test in §9 below
is the chosen level of rigor, matching precedent rather than exceeding
it speculatively.

## 9. Tests (real Postgres e2e, matching AP-1a/1b's rigor)

- `supplier-payments.e2e-spec.ts` — RBAC, validation (create/edit-time
  400s), draft CRUD (create with allocations, edit — full-array
  replacement, delete, both rejected once POSTED with 409), posting:
  full settlement (one bill, exact payoff), partial settlement (payment
  less than a bill's total), multiple-bill allocation in one payment,
  over-allocation rejection (single bill exceeds outstanding — 422;
  sum of allocations ≠ payment amount — 422), posting against a DRAFT
  bill (422), posting against another supplier's bill (422),
  immutability after posting (DB-trigger-level, raw-SQL, mirroring
  AP-1b's own immutability tests), cross-tenant/cross-legal-entity
  isolation (404-not-403).
- `ap-payment-gl-integration.e2e-spec.ts` — a posted payment's lines
  appear in `/accounts/:id/balance` (AP control debited, bank/cash
  credited), `/accounts/:id/ledger`, `/trial-balance` — same pattern as
  `ap-bill-gl-integration.e2e-spec.ts`, plus the **sub-ledger/GL
  reconciliation invariant** the AP-1a proposal names explicitly (§10):
  after a sequence of bill and payment postings, `SUM(supplier_bills
.totalMinor - paidMinor)` across a legal entity's open bills equals
  the GL's own closing balance of the AP control account.
- `ap-payment-concurrency.e2e-spec.ts` — two concurrent payments
  allocating to the same bill where only one fits within the
  outstanding balance (exactly one 200, one 422, no over-allocation);
  two concurrent payments allocating to disjoint amounts of the same
  bill that both fit (both succeed, bill ends `PARTIALLY_PAID`/`PAID`
  correctly — proving true concurrency-safe partial allocation, not
  just "first writer wins"); no burned payment/journal number from a
  failed post between two successful ones; concurrent payment-post vs.
  period-close (row-lock serialization, same shape as AP-1b's).
- DTO unit specs for `CreateSupplierPaymentDto`,
  `CreateSupplierPaymentAllocationDto`, `UpdateSupplierPaymentDto`.
- `route-role-matrix.spec.ts` extended: `SupplierPaymentsController`'s
  6 routes added (30 → 36).
- Full regression: the entire existing suite (units + e2e, 130 + 244
  cases as of `870a35e`) re-run and must stay green — no dedicated new
  file needed for this; it's the standard final verification gate.

## 10. RLS / RBAC / audit / immutability

Same conventions as every table in AP-1a/1b, no deviation:

- RLS: `tenant_isolation` policy (with the `= ''` bypass-fix branch from
  day one) on all three new tables, in a new
  `005_ap_payments_rls.sql`. `legal_entity_id` isolation stays an
  explicit service-layer predicate, same reasoning as every other
  Finance table.
- RBAC: `finance.poster` writes (create/edit/delete/post),
  any `finance.*` role reads — matching `SupplierBillsController`'s
  split exactly (payments are a transactional/posting document, not
  master data, same category as bills and journal entries).
- Audit: `entityType: "supplier_payment"` for payment CREATE/UPDATE/
  DELETE/POST rows, `entityType: "journal_entry"` for the posting-time
  CREATE row, `entityType: "supplier_bill"` for each allocated bill's
  settlement-effect UPDATE row (§8 step 13).
- Immutability: two new trigger files —
  `006_supplier_payments_immutability_trigger.sql` (zero-exception:
  once `status = POSTED`, no UPDATE or DELETE permitted at all — no
  narrow exception, per §5) and
  `007_supplier_payment_allocations_immutability_trigger.sql`
  (zero-exception, joins to the parent payment's `status`, mirroring
  `006_supplier_bill_lines_immutability_trigger.sql`'s join-to-parent
  shape exactly).

## 11. Required APIs

```
POST   /v1/finance/payments                create DRAFT incl. allocations   finance.poster
GET    /v1/finance/payments                 list                            any finance.* role
GET    /v1/finance/payments/:id             detail incl. allocations        any finance.* role
PATCH  /v1/finance/payments/:id             edit — DRAFT only                finance.poster
DELETE /v1/finance/payments/:id             delete — DRAFT only              finance.poster
POST   /v1/finance/payments/:id/post        DRAFT → POSTED                   finance.poster
```

`GET /payments` filters: `status`, `supplierId`, `dateFrom`/`dateTo`.
`GET /bills` gains one additional filter, `paymentStatus` (§1) — a
one-line extension to `ListSupplierBillsFilters` and its controller
query param, not a new endpoint.

**Note beyond the AP-1a proposal's original route sketch**: that
sketch listed no `PATCH /payments/:id`. This document adds it for
consistency with `PATCH /bills/:id` and `PATCH /journal-entries/:id` —
every other draft-editable document in this codebase supports edit
before posting, and there is no stated reason for payments to be the
one exception (delete-and-recreate as the only correction path).
Flagged here as an implementation note, not §12, because it applies
existing precedent in the same direction as everything else, not a new
tradeoff.

## 12. Decisions requiring approval

**1. `ap_number_counters`/payment-numbering shape.** AP-1b's proposal
(§24 item 1) explicitly left this open: widen the existing
`ap_number_counters` table with a `counter_type` discriminator column
(the AP-1a proposal's original idea), or add a new, separate
`ap_payment_number_counters` table (structurally identical, zero risk
to the existing table/rows). **Recommendation: the separate table**
(this document's default, §3) — every schema change across AP-1a/1b has
been purely additive (new tables, never an ALTER to an existing table's
primary key or an added discriminator column to data already in
production use), and `journal_number_counters`/`ap_number_counters`
being separate, single-purpose tables is the same pattern this would
extend rather than break. The cost either way is one small migration,
not a redesign, per AP-1b's own framing of this exact choice.

No other decision in this document is presented as requiring approval.
Full-allocation-only posting (§7), no void/unwind (§1/§5), zero-exception
payment immutability (§5/§10), the locking order (§8), and the
`paid_minor` CHECK loosening target (§3) all directly restate an
already-approved source (the AP-1a proposal itself, or AP-1b's §24) —
none of them are new judgment calls this Work Item is making on its
own.

## 13. What's deliberately left for later

- AP-1d — supplier balance, statement, ageing endpoints (§1).
- Payment on account / partial payment-amount allocation (§7).
- Void/unwind of a posted payment or bill; correction/credit-note
  workflow.
- Real bank-account entities, bank feeds, reconciliation — payments
  keep using a manually-selected `chart_of_accounts` row
  (`bank_cash_account_id`), the same documented seam AP-1a §20 already
  names for a future Banking & Cash Management module to extend.
- Multi-currency/FX payments.
- A DB-level cross-table trigger for the allocation-sum invariant (§8)
  — an e2e reconciliation test is the chosen rigor level, matching
  AP-1a's own stated reasoning, not a gap.
