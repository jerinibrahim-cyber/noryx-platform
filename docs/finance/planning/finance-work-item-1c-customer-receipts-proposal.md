# Finance Work Item AR-1c — Customer Receipts & Settlement

Implementation-readiness proposal (**discovery/design only — no code,
schema, migration, or test file has been touched to produce this
document**). Builds directly on AR-1a (`c85f1b9`,
`docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md`)
and AR-1b (`1257b4b`,
`docs/finance-work-item-ar-1b-customer-invoicing-proposal.md`), and is
the literal customer-side mirror of AP-1c (`2ffddb9`,
`docs/finance-work-item-1c-supplier-payments-proposal.md`) — this
document states what AR-1c adds and the handful of places its shape
must legitimately differ from AP-1c because the underlying accounting
polarity or table history differs; it does not re-derive conventions
AR-1a/AR-1b/AP-1c already settled.

## 0. What was read before writing this

Read against the actual repository at `HEAD = 1257b4b` (not from prior
session summaries — every claim below was verified directly against
current source):

- `docs/roadmap.md` — confirms Accounts Receivable is `PLANNED` scope
  including "Receipts, Receipt allocation, AR ageing, AR reporting";
  confirms no AR-1d work has landed (see the correction in §1 below).
- `docs/finance-work-item-1-ap-foundation-proposal.md` §15/§19/§20 — the
  original payment/settlement architecture sketch (full-allocation-only
  posting, ascending-`bill_id` lock ordering, the "payment on account"
  and banking/reconciliation non-goals) that AP-1c implemented and that
  this document mirrors for AR.
- `docs/finance-work-item-1c-supplier-payments-proposal.md` in full —
  the direct structural template for this document.
- `docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md`
  §0–§4 — the read-only, zero-new-schema reporting pattern a future
  AR-1d will mirror; confirms exactly which AP-1c-written columns
  (`supplier_bills.paid_minor`/`payment_status`,
  `supplier_payment_allocations.allocated_amount_minor`) are AP-1d's
  only data source, so AR-1c can be checked for producing the AR
  equivalent.
- `docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md`
  and `docs/finance-work-item-ar-1b-customer-invoicing-proposal.md` in
  full — confirms `customers`, `ar_settings`, `ar_number_counters`,
  `customer_invoices`, `customer_invoice_lines` already exist exactly as
  documented, and confirms AR-1b's own explicit deferral: "Customer
  receipts, receipt allocation, partial/full settlement, customer
  statements, AR ageing, AR/GL reconciliation, credit notes,
  multi-currency — unchanged from the roadmap, not touched by AR-1b"
  (AR-1b proposal §9).
- `src/db/schema.ts` in full (current, through AR-1b) — confirms every
  table this Work Item needs already exists on the AP side as a
  structural template (`ap_payment_number_counters`, `supplier_payments`,
  `supplier_payment_allocations`, `payment_method` enum,
  `supplier_payment_status` enum) and confirms the AR side's exact
  current shape (`customer_invoices.paid_minor` pinned to `0` via
  `customer_invoices_paid_minor_zero_until_ar1c`, `payment_status`
  defaulting `UNPAID`, both explicitly documented in schema.ts as
  "AR-1c's future receipt-allocation posting" is their first writer).
- `src/accounts-payable/supplier-payments/supplier-payments.service.ts`,
  `.controller.ts`, and its three DTO files in full — the exact
  posting-transaction shape, multi-row locking pattern, and DTO/RBAC
  conventions this document replicates for AR.
- `drizzle/rls/005_ap_payments_rls.sql`,
  `drizzle/constraints/007_supplier_payments_immutability_trigger.sql`,
  `drizzle/constraints/008_supplier_payment_allocations_immutability_trigger.sql`,
  and `drizzle/constraints/009_customer_invoices_immutability_trigger.sql`
  in full — confirms (a) the RLS/immutability file conventions to
  replicate, and (b) critically, that **`customer_invoices`' immutability
  trigger already has the narrow `paid_minor`/`payment_status` exception
  built in** (added structurally in AR-1b, unused until now, excluding
  `updated_at` from the allowed-to-change set exactly like
  `005_supplier_bills_immutability_trigger.sql` does for bills) — so
  AR-1c needs a CHECK-constraint swap on `customer_invoices`, not a
  trigger-function change.
- `src/accounts-receivable/customer-invoices/customer-invoices.controller.ts`
  — confirms `GET /invoices` currently has no `paymentStatus` filter (the
  same minimal gap AP-1c's own `GET /bills` had before its one-line
  enabler addition).
- `src/accounts-receivable/accounts-receivable.module.ts` — its own doc
  comment already anticipates this Work Item: "Later AR Work Items
  (receipts, allocations, reporting) will add further sibling imports
  here, the same way AP-1c/1d continued AccountsPayableModule."
- `src/route-role-matrix.spec.ts` — current state confirmed: 54 routes
  across 12 controllers (`CustomerInvoicesController` is the most recent
  addition); the repo-wide reflection-test pattern every new controller
  must be added to.
- `src/db/db.ts` (`withTenant`/`TxClient`), `src/general-ledger/general-ledger.service.ts`
  (`REPORT_TX_CONFIG`, confirmed already exported for cross-file reuse —
  the exact mechanism AP-1d imported directly rather than duplicating).

## 1. Correction to the kickoff framing — AR-1d does not exist yet

The kickoff instruction describes "the AR-1d reporting layer already
implemented" and asks AR-1c to "integrate cleanly with the AR-1d
reporting layer already implemented." **This is not the current
repository state.** Only `services/sphere-finance/src/accounts-payable/`
has a reports module (`ap-reports/`, implementing AP-1d — supplier
balance, statement, ageing, AP/GL reconciliation).
`services/sphere-finance/src/accounts-receivable/` contains exactly
three modules as of `1257b4b`: `customers/`, `ar-settings/`,
`customer-invoices/`. There is no `ar-reports/` directory, no AR
balance/statement/ageing endpoint, and `docs/roadmap.md` still lists AR
ageing/reporting as `PLANNED` (unchecked), not `COMPLETE`.

This does not block AR-1c — AP-1c itself was built and shipped before
AP-1d existed, using the identical reasoning this document uses in §12.
AR-1c's job per this correction is: produce data in the exact shape a
_future_ AR-1d will need (mirroring what AP-1c produced for AP-1d),
proven by this Work Item's own reconciliation e2e test, not by calling
into or extending any already-built AR-1d code — because none exists.
§12 below states this explicitly as the compatibility contract.

## 2. Objective

Complete the customer-side settlement equivalent of AP-1c: let a posted
customer invoice actually get paid. Concretely — record money received
from a customer (a "receipt"), allocate it across one or more `POSTED`
customer invoices (partial or full settlement, one or many invoices per
receipt), post the receipt through the existing Journal Engine with the
correct Dr Bank/Cr AR-control polarity, and atomically update each
settled invoice's `paid_minor`/`payment_status` — all with the same
concurrency-safety, RLS, immutability, RBAC, and audit rigor already
proven by AP-1c.

## 3. Scope

**In scope:**

- Customer receipt master: draft create (with allocations in the same
  request), list/detail, edit (header + full-array allocation
  replacement) and delete while `DRAFT`, `DRAFT → POSTED` lifecycle,
  receipt numbering, tenant + legal-entity isolation.
- Receipt allocation: one receipt against one or many `POSTED` customer
  invoices, partial and full per-invoice settlement, over-allocation
  guard against each invoice's outstanding balance
  (`totalMinor - paidMinor`), full-allocation-only posting
  (`SUM(allocations) === receiptAmountMinor` — see §9 for why this is
  not re-opened as a new decision).
- Invoice settlement state: `customer_invoices.paid_minor`/
  `payment_status` updated atomically with receipt posting, using the
  exact narrow exception already built into
  `009_customer_invoices_immutability_trigger.sql`.
- Accounting: two-line balanced entry (Dr bank/cash, Cr AR control)
  posted through the same direct `journal_entries`/`journal_lines`/
  `journal_number_counters` insertion pattern AR-1b/AP-1b/AP-1c all use
  — no Journal Engine modification.
- Concurrency: fixed ascending-`id` multi-invoice locking, receipt-vs-
  invoice-posting and receipt-vs-period-close race safety, no burned
  numbering on a failed post, double-allocation/over-settlement
  prevention proven under real concurrent load.
- RLS, RBAC (reusing `finance.viewer`/`finance.poster`/`finance.admin`
  exactly — no new role), immutability, and audit — matching AR-1a/
  AR-1b/AP-1c conventions exactly.
- One additive `GET /invoices` filter (`paymentStatus`) — the same
  minimal enabler AP-1c added to `GET /bills`.
- Full real-Postgres e2e coverage: DTO units, draft CRUD, posting
  (multiple scenarios), GL integration, concurrency (3 scenarios
  mirroring AP-1c's), sub-ledger/GL reconciliation invariant,
  cross-tenant/cross-legal-entity isolation.

**Out of scope** — see §4.

## 4. Non-scope (explicit)

Mirroring AP-1c's own non-goals, restated for AR, plus the one AR-1d
correction from §1:

- **AR-1d** — customer balance, statement, ageing, AR/GL reconciliation
  read endpoints. Per §1, this does not exist yet; AR-1c produces
  exactly the data it will need (`customer_invoices.paid_minor`/
  `total_minor`/`payment_status`, `customer_receipt_allocations`) but
  exposes no report endpoint for it. `GET /invoices` gains the one
  `paymentStatus` filter named in §3 as a direct, minimal enabler of
  AR-1c's own allocation flow — not an AR-1d report.
- **Credit/debit notes, void/unwind of a posted receipt or invoice** — no
  such workflow exists anywhere in Finance yet (AP-1a §19 non-goal,
  restated for AR by the same reasoning); no state hook added.
- **Banking & reconciliation** — receipts post against a manually-selected
  `chart_of_accounts` row (type `ASSET`), exactly like AP-1c's
  `bankCashAccountId`. No bank-account entity, no bank feed, no
  reconciliation module.
- **FX/multi-currency** — receipt currency is always the legal entity's
  functional currency, resolved server-side, identical to every other
  Finance document.
- **"Receipt on account"** (partial allocation of the receipt itself,
  leaving cash unapplied) — excluded per the kickoff's own instruction
  not to invent this where the existing architecture excludes it; AP-1a
  §19/AP-1c §7 already settled this for the whole Finance suite's
  payment/receipt model. Posting requires exact full allocation. See §9.
- **Journal Engine modification** — zero changes. No integration gap
  requires one.
- **Any hardening/3.x work** — untouched, per the standing charter.

## 5. Existing architecture reused (unmodified)

`journal_entries`/`journal_lines`/`journal_number_counters` (receipts
draw journal numbers from the exact same `JE-NNNNNN` sequence invoices,
bills, and payments already use — no AR-only journal series); `ar_settings`
(the same `arControlAccountId` invoices already debit/credit at
posting is the account receipts credit); `customers`; `customer_invoices`
(read and, at posting, its narrow `paid_minor`/`payment_status`
exception written); `accounting_periods` resolution/locking helper
shape; `audit_logs`; `chart_of_accounts` (the bank/cash account,
validated `ACTIVE` + type `ASSET`, identical validation to AP-1c's
`bankCashAccountId`); `@noryx/auth-core` guards/decorators
(`JwtAuthGuard`, `RolesGuard`, `Roles`, `CurrentUser`,
`requireTenantContext`); the General Ledger read layer (unmodified — a
posted receipt's lines appear in `/accounts/:id/balance`, `/ledger`,
`/trial-balance` automatically, proven the same way AR-1b proved it for
invoices); `withTenant()`/`TxClient` from `src/db/db.ts`;
`ApiSuccess`/`ApiSuccessWithMeta` response envelopes;
`route-role-matrix.spec.ts`'s reflection-test pattern.

## 6. Database model

```
-- receipt_method: NO new enum type. customer_receipts.receipt_method is
-- typed against the EXISTING `payment_method` enum
-- ('BANK_TRANSFER','CHEQUE','CASH','CARD','OTHER') — reused, not
-- duplicated. See §14 decision 2 for the full comparison and rationale
-- (CTO-directed re-evaluation, resolved in favor of reuse).
customer_receipt_status enum('DRAFT','POSTED')   -- two-value, matches
                                                   -- every other Finance
                                                   -- posting-lifecycle enum

ar_receipt_number_counters                  -- see §14 decision 1
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  last_assigned_number  integer, not null, default 0
  PRIMARY KEY (tenant_id, legal_entity_id)

customer_receipts
  id                    uuid PK, default random
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  customer_id           uuid, not null, FK -> customers.id
  internal_reference    varchar(20), nullable       -- "RCT-000123", assigned at posting only
  status                customer_receipt_status, not null, default 'DRAFT'
  receipt_date          date, not null
  currency_code         varchar(3), not null         -- resolved server-side, never client-supplied
  receipt_amount_minor  bigint, not null              -- the actual cash amount received; must equal
                                                        -- SUM(allocations) to post — §9
  receipt_method        payment_method, not null   -- reuses the EXISTING enum type — §14 decision 2
  bank_cash_account_id  uuid, not null, FK -> chart_of_accounts.id   -- validated ACTIVE + type ASSET
  reference              varchar(100), nullable        -- free-text external ref (cheque #, transfer ref)
  memo                  text, nullable
  journal_entry_id      uuid, nullable, FK -> journal_entries.id     -- set once, at posting
  period_id             uuid, nullable, FK -> accounting_periods.id  -- set once, at posting
  created_by, posted_by uuid, nullable
  posted_at             timestamptz, nullable
  created_at, updated_at  timestamptz, not null
  UNIQUE (tenant_id, legal_entity_id, internal_reference)   -- NULL-distinct, same as every other doc
  INDEX (tenant_id, legal_entity_id)
  INDEX (customer_id)
  CHECK (receipt_amount_minor > 0)

customer_receipt_allocations
  id                     uuid PK, default random
  tenant_id              uuid, not null            -- denormalized, own RLS policy, same as
                                                      -- supplier_payment_allocations
  receipt_id             uuid, not null, FK -> customer_receipts.id, ON DELETE CASCADE
  invoice_id              uuid, not null, FK -> customer_invoices.id
  allocated_amount_minor bigint, not null
  created_at             timestamptz, not null
  UNIQUE (receipt_id, invoice_id)   -- at most one allocation row per (receipt, invoice) pair
  INDEX (invoice_id)
  CHECK (allocated_amount_minor > 0)
```

**`customer_invoices` change** — one CHECK constraint swap, no column
change, no new migration file beyond schema.ts's edit + drizzle-kit's
generated SQL: `customer_invoices_paid_minor_zero_until_ar1c`
(`paid_minor = 0`) is dropped and replaced with
`customer_invoices_paid_minor_within_total`
(`paid_minor >= 0 AND paid_minor <= total_minor`) — exactly what AR-1b's
own schema.ts comment already named as this Work Item's job
("A later AR Work Item's migration loosens this constraint together
with introducing the first writer"). `payment_status` gets its first
real writer here; no enum change (`UNPAID`/`PARTIALLY_PAID`/`PAID`
already exist). **No trigger-function change** —
`009_customer_invoices_immutability_trigger.sql`'s narrow exception
already permits exactly this pair of columns to change on a `POSTED`
row, with every other column (including `updated_at`) still enforced
unchanged.

No other existing table changes.

## 7. Relationships

```
customers ──< customer_receipts ──> chart_of_accounts (bank_cash_account_id)
                    |         └──> journal_entries (journal_entry_id, set at posting)
                    |         └──> accounting_periods (period_id, set at posting)
                    |
                    └──< customer_receipt_allocations >── customer_invoices
                               (many-to-many: one receipt can settle several invoices,
                                one invoice can be settled by several receipts over time)

ar_receipt_number_counters (1 row per tenant+legal entity)
```

## 8. Lifecycle / state machine

**Receipt posting-lifecycle (`status`)** — identical shape to invoices
and payments:

```
DRAFT ──(POST /receipts/:id/post)──> POSTED   (terminal; no reopen, no void — §4)
  └──(DELETE /receipts/:id, DRAFT only)──> [deleted]
```

A receipt is created `DRAFT` with its allocations in the same request
(mirrors payment+allocations), editable in full (header + full-array
allocation replacement, same convention as `UpdateSupplierPaymentDto`)
while `DRAFT`, and becomes immutable in full once `POSTED` — zero
exception, same posture as `supplier_payments` (§13): no future writer
is known for any column on a posted receipt within the current locked
roadmap.

**Invoice payment-lifecycle (`payment_status`)** — already defined by
AR-1a/AR-1b, exercised here for the first time:

```
UNPAID ──(allocation posted, 0 < paid_minor < total_minor)──> PARTIALLY_PAID ──(paid_minor = total_minor)──> PAID
UNPAID ──(allocation posted, paid_minor = total_minor in one step)───────────────────────────────────────────> PAID
```

Only ever moves forward (more paid) — no "unapply" action (§4).

## 9. Accounting entries

Two-line balanced entry, always:

```
DEBIT  receipt.bankCashAccountId          receipt_amount_minor   -- increases the bank/cash asset
CREDIT ar_settings.arControlAccountId     receipt_amount_minor   -- reduces the AR asset
```

This is the mirror image of AP-1c's payment entry (Dr AP control /
Cr bank-cash) because both sides of a receipt sit on the asset side of
the balance sheet — cash goes up, the receivable goes down — matching
the kickoff's own explicit rule (Dr Bank/Cash, Cr AR Control) exactly.
No tax leg — tax is an invoice-line concept, already fully handled at
invoice-posting time (AR-1b). Memo: `Receipt ${internalReference} from
customer ${customer.name}` (finalized during implementation to match
`CustomerInvoicesService`'s/`SupplierPaymentsService`'s memo
convention).

## 10. Allocation rules & why "full allocation" is not re-opened for approval

`SUM(allocations.allocatedAmountMinor) === receipt.receiptAmountMinor`
is required to post — no partially-allocated ("on account") receipt in
this Work Item. This is not a new decision: the kickoff instruction
itself says "do not invent on-account functionality if the existing
architecture/proposals already exclude it," and AP-1a §19/AP-1c §7
already excluded the AP-side equivalent for the whole Finance payment/
receipt model. Per the standing "if the existing roadmap/proposal
already resolves the design decision, proceed directly" rule, this is
adopted as-is for AR, not listed in §14.

Per-invoice rule, validated under lock at posting (re-validated
independently of whatever was true at draft creation/edit time — same
posture as AP-1c's bill re-validation):

- the target invoice's `status` must be `POSTED` (a `DRAFT` invoice has
  no settled `total_minor` to receive against);
- the target invoice's `(tenant_id, legal_entity_id, customer_id)` must
  match the receipt's own — a receipt can only allocate against its own
  customer's invoices;
- `allocation.allocatedAmountMinor <= invoice.totalMinor - invoice.paidMinor`
  (the invoice's current outstanding balance) — the over-allocation
  guard, identical shape to AP-1c's bill guard.

At create/edit time (`DRAFT`), allocations are validated for shape
(invoice exists, belongs to the same customer/tenant/entity — 400) but
_not_ for sufficient remaining balance, since that balance can
legitimately change before posting (another receipt might post first)
— the same create-time-vs-post-time validation split AP-1c established
for bill allocations, itself following the split AR-1b/AP-1b established
for line accounts (400 at create, 422 at posting).

## 11. Settlement rules — which fields settlement may change, and why

Settlement (the per-invoice effect of a receipt posting) may change
exactly two columns on a `POSTED` `customer_invoices` row:
`paid_minor` and `payment_status`. This set is not a new judgment call
for AR-1c — it is precisely the exception AR-1b's migration already
built into `009_customer_invoices_immutability_trigger.sql`, unused
until now (the trigger's own doc comment names "a later AR Work Item's
future receipt-allocation posting" as its intended first writer).
`updated_at` is deliberately **not** included in the allowed-to-change
set — the settlement `UPDATE` statement must never include `updatedAt`
in its `SET` clause (Drizzle does not auto-touch it unless explicitly
passed, so simply omitting the field, as `SupplierPaymentsService.post()`
already does for `supplier_bills`, satisfies this). Every other column
(`internal_reference`, `status`, `invoice_date`, `total_minor`,
`journal_entry_id`, etc.) stays fully immutable — settlement is a
narrowly-scoped side effect of receipt posting, never a rewrite of the
invoice's own history.

Recomputation on each settled invoice, identical formula to AP-1c's
bill settlement: `paidMinor === totalMinor ⇒ PAID`,
`0 < paidMinor < totalMinor ⇒ PARTIALLY_PAID` (an invoice already `PAID`
cannot be re-allocated against — its outstanding balance is `0`, so the
over-allocation guard in §10 rejects any further allocation attempt
without needing a separate status check).

## 12. GL / AR reporting integration

Two integration claims, both provable without any AR-1d code existing
(§1):

1. **GL integration** — a posted receipt's two journal lines appear in
   the existing, unmodified `GET /accounts/:id/balance`,
   `/accounts/:id/ledger`, and `/trial-balance` endpoints automatically,
   with zero AR-specific code in the GL read layer — proven the same way
   AR-1b proved it for invoices and AP-1c proved it for payments
   (`ar-receipt-gl-integration.e2e-spec.ts`, §15).
2. **Future AR-1d compatibility** — this Work Item's own e2e suite
   includes a sub-ledger/GL reconciliation invariant test, identical in
   spirit to AP-1c's own (§13 of that proposal) but stated here with the
   precise as-of semantics the CTO review requested, so a future AR-1d
   statement/ageing/reconciliation implementation can rely on an
   unambiguous invariant rather than an informally-stated one.

### 12.1 The reconciliation invariant — precise definition

Grounded directly in the existing, unmodified `GeneralLedgerService`
semantics (`src/general-ledger/general-ledger.service.ts`, confirmed by
re-reading it for this revision): every GL read query — `getTrialBalance`
and the account-balance query alike — resolves an `asOf` date (explicit
`asOf`, or `period.endDate` if a `periodId` is given, or
`this.todayUtc()` if neither is given — the existing "§4.8 today-default"
already documented in that service) and filters strictly on
`journal_entries.status = 'POSTED' AND journal_entries.transaction_date
<= asOf`. AR-1c introduces no new GL query — the invariant below is
defined so it lines up with that existing, unmodified filter exactly,
not a new semantics AR-1c invents.

**Given** a fixed `(tenantId, legalEntityId)` and a fixed `asOf` date
(defaulting to today when unspecified, identical to the GL layer's own
default):

```
GL side   (existing, unmodified GeneralLedgerService):
  arControlClosingBalance =
    GET /accounts/:arControlAccountId/balance?asOf=<asOf>  →  closingBalanceMinor

AR sub-ledger side (this Work Item's own tables, no new query infra):
  arSubledgerOutstanding =
    SUM(customer_invoices.totalMinor - customer_invoices.paidMinor)
    WHERE tenantId = X
      AND legalEntityId = Y
      AND status = 'POSTED'
      AND invoiceDate <= asOf

Invariant:  arSubledgerOutstanding == arControlClosingBalance
```

Precise scope of every element the CTO review asked to be pinned down:

- **Invoice status included**: `POSTED` only. A `DRAFT` invoice has
  posted no journal entry and contributes `0` to the GL side by
  construction, so including it on the sub-ledger side would compare
  unlike quantities; excluding it keeps both sides counting exactly the
  same set of real accounting events.
- **Receipt status included**: `POSTED` only, for the identical reason —
  a `DRAFT` receipt has neither posted a journal entry nor mutated any
  invoice's `paidMinor` (§11: `paidMinor` is written only inside
  `post()`), so it is already vacuously excluded from both sides; stated
  explicitly here for clarity, not because a filter needs to be added
  for it.
- **Legal entity / tenant scope**: the invariant is evaluated per single
  `(tenantId, legalEntityId)` pair, never aggregated across entities —
  matching `ar_settings` (one `arControlAccountId` per legal entity) and
  every existing GL query's own scoping.
- **Transaction date vs. accounting posting date**: there is only one
  date that matters here, and it is unambiguous — `journal_entries
.transaction_date` is set verbatim from the source document's own date
  field at posting time (confirmed by re-reading the actual code this
  revision: `CustomerInvoicesService.post()` sets
  `transactionDate: before.invoiceDate`,
  `SupplierPaymentsService.post()` sets `transactionDate:
before.paymentDate`, `SupplierBillsService.post()` sets `transactionDate:
before.billDate` — every posting flow in this codebase follows this
  rule with zero exceptions). AR-1c's own `CustomerReceiptsService.post()`
  will set `transactionDate: before.receiptDate`, the same way. There is
  no separate "posting date" distinct from the document's own date
  anywhere in Finance — `postedAt` is an audit timestamp (when the
  `POST` action was executed), never used as an accounting date. The
  invariant's `invoiceDate <= asOf` filter on the sub-ledger side is
  therefore comparing against the exact same date domain the GL side's
  `transaction_date <= asOf` filter uses for that invoice's own posting
  entry.
- **Future-dated invoices/receipts**: a `POSTED` invoice whose
  `invoiceDate` is after `asOf` is excluded from the sub-ledger sum by
  the explicit `invoiceDate <= asOf` filter above, symmetric with the GL
  side excluding its journal entry via `transaction_date <= asOf`. Both
  sides agree: a future-dated document (legal only if some `OPEN`
  accounting period already covers that future date) does not count
  toward either side's balance until `asOf` reaches its date.
- **Same as-of boundary on both sides**: both the GL query and the
  sub-ledger query above take the identical `asOf` value as input — the
  invariant is only ever evaluated with one shared `asOf`, never two
  independently-chosen dates.

**The one genuine, deliberate limitation, stated explicitly rather than
silently decided**: `customer_invoices.paidMinor` is a mutable running
total — it always reflects every `POSTED` receipt allocation applied to
that invoice _as of the moment the query runs_, not a value frozen "as
of" an arbitrary earlier `asOf`. There is no point-in-time snapshot of
`paidMinor` anywhere in this schema (AR-1c introduces none; that would
be new scope). Consequence: **the invariant above is exact whenever
`asOf` is today (the default) or later than every receipt's own
`receiptDate` already posted against that legal entity.** It is _not_
guaranteed to hold for a historical `asOf` that falls _before_ a
receipt that has already posted — such a receipt's effect is already
baked into `paidMinor`'s current value (reducing
`arSubledgerOutstanding`) even though the GL side would correctly
exclude that receipt's own journal lines from a balance computed as of
that earlier date (leaving `arControlClosingBalance` higher). This is
identical in kind to AP-1c's own reconciliation test, which is likewise
only ever evaluated at current-state `asOf` (today/unspecified), never
at a historical date — AR-1c does not introduce a new gap, it makes the
existing one explicit. A true point-in-time historical AR reconciliation
(e.g., "AR ageing as of last month-end" after receipts have since
posted) is out of scope for AR-1c; if a future AR-1d genuinely needs
that, it must either restrict itself to this same current-state
invariant, or introduce a proper point-in-time settlement ledger — a
decision for that future proposal, not this one.

`ar-receipt-gl-integration.e2e-spec.ts`'s reconciliation test (§15)
exercises the invariant exactly as defined above, with every invoice and
receipt in the test dated on or before the `asOf` value the test queries
— i.e., entirely within the invariant's proven-exact region, not its
documented limitation.

This is the concrete proof that `customer_invoices.paid_minor`/
`payment_status` and `customer_receipt_allocations.allocated_amount_minor`
are a complete, correct AR sub-ledger for current-state queries — the
same data shape AP-1d later read with **zero new schema** (per
`docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md`
§3's explicit "no new tables" stance). When AR-1d is eventually
proposed, it should be able to follow that same zero-schema, read-only
pattern against the tables this Work Item creates, subject to the
current-state limitation named above — but that is a claim for AR-1d's
own proposal document to verify at that time, not one this document can
prove today since AR-1d does not yet exist.

## 13. Concurrency / locking strategy

Mirrors `SupplierPaymentsService.post()`'s transaction shape (AP-1c
proposal §8), with AR-specific renames only. **The entire sequence below
— every step, from the initial header lock through the final audit
insert — executes inside the single database transaction `withTenant()`
opens for the `post()` call.** There is no intermediate `COMMIT`
anywhere in this sequence: Postgres does not durably persist any of
steps 1–14's writes until the transaction's real `COMMIT`, which
`withTenant()` issues once (and only once) the entire callback function
returns without throwing. If any step throws — a validation failure, a
constraint violation, a lock-acquisition failure — every write made by
every prior step in this same call is rolled back as if none of them
had happened. This is restated explicitly here because an earlier draft
of this document used the word "commit" to describe an intermediate
step (the receipt's own status transition), which read as though that
step durably persisted on its own — it does not; it is one more
statement inside the still-open transaction, exactly like every other
step around it.

1. Lock the receipt header (`SELECT ... FOR UPDATE`) — first statement.
2. `status === DRAFT` check.
3. `allocations.length >= 1` check (a receipt must allocate to post — no
   bare unapplied receipt, consistent with §10).
4. Validate `bank_cash_account_id` is still an `ACTIVE` `ASSET` account
   in scope (re-validated, same posture as AP-1c's bank/cash account).
5. Load AR settings (422 if unconfigured, same as invoices).
6. Resolve + lock the covering `OPEN` accounting period for
   `receipt_date`.
7. **Lock every allocated invoice in one statement, in a fixed
   order**: `SELECT * FROM customer_invoices WHERE id = ANY($ids) AND
tenant_id = $1 AND legal_entity_id = $2 ORDER BY id FOR UPDATE` —
   ascending `id` guarantees two concurrent receipts that both touch an
   overlapping invoice set always acquire row locks in the same relative
   order, so neither can deadlock the other (the kickoff instruction's
   own explicit requirement, and the literal application of the AP
   Foundation proposal's §15 locking strategy to the AR side).
8. Re-validate each locked invoice: `status = POSTED`, same customer,
   and `allocatedAmountMinor <= totalMinor - paidMinor` — 422 on any
   violation, whole transaction rolls back (no burned receipt number).
9. Full-allocation requirement (§10): `SUM(allocations) ===
receiptAmountMinor` — 422 otherwise.
10. Allocate receipt number (`ar_receipt_number_counters`, §14 decision
    1. and journal number (shared `journal_number_counters`).
11. Insert the journal entry **as DRAFT**, insert its 2 lines, **then**
    `UPDATE` to `POSTED` — the same ordering `journal_lines_immutable`
    requires (an INSERT after the parent is already `POSTED` is
    rejected), already correctly implemented in AR-1b/AP-1c and
    replicated here from the start.
12. Update the receipt's `status`/`internalReference`/`journalEntryId`/
    `periodId`/`postedBy`/`postedAt` within the same transaction. **Do
    not commit yet** — this is an `UPDATE` statement against the still-
    open transaction, not a durability boundary; steps 13 and 14 below
    still have to succeed before any of steps 1–14 becomes durable.
13. For each allocated invoice, still within the same transaction:
    `UPDATE customer_invoices SET paid_minor = paid_minor + $alloc,
payment_status = <recomputed> WHERE id = $id` — **critically, this
    UPDATE must not include `updated_at` in its SET clause** (§11).
14. Still within the same transaction, insert the audit rows: one
    `POST` row for the receipt, one `CREATE` row for the new journal
    entry, and one `UPDATE` row per settled invoice recording its
    `paidMinor`/`paymentStatus` transition — matching AP-1c's "audit all
    financially significant state changes" posture exactly (§16).

**Only after step 14 completes without error does the enclosing
`withTenant()` call issue the actual `COMMIT`.** The receipt's status
update (step 12), every invoice's settlement update (step 13), the
journal entry/lines (step 11), and every audit row (step 14) become
durable together, in one atomic `COMMIT`, or none of them do. A failure
at any step — including a failure in the audit insert itself — rolls
the whole transaction back: no burned receipt/journal number, no
partial invoice update, no orphaned journal entry, no receipt marked
`POSTED` without its audit trail, from a failed post. Same guarantee
AR-1b/AP-1c already established, stated here without the ambiguous
"commit" language the CTO review flagged.

**No new DB-level cross-table trigger** for the
`SUM(allocations) = receipt_amount_minor` invariant — mirrors AP-1a/
AP-1c's own explicit reasoning: a cross-table trigger spanning
`customer_receipt_allocations`/`customer_receipts` is more invasive
than the value it adds at this stage; the transactional, row-locked
service logic plus the e2e reconciliation test in §12/§15 is the chosen
level of rigor, matching precedent rather than exceeding it
speculatively.

## 14. Explicit design decisions requiring CTO approval

_Status after the first CTO review round: decision 1 below is still
open, awaiting sign-off. Decision 2 was re-evaluated per the CTO's
explicit direction and is now resolved (reuse `payment_method`) — kept
in this section for its rationale trail rather than moved out, since
its comparison is still useful context._

**1. `ar_number_counters`/receipt-numbering shape.** AR-1b's proposal
already left the numbering-widening-vs-separate-table question dormant
for this exact moment, following the AP-1b→AP-1c precedent (AP-1c
proposal §12 decision 1: widen `ap_number_counters` with a
`counter_type` discriminator vs. add a new, separate
`ap_payment_number_counters` table). AP-1c chose the separate table and
it shipped that way. **Recommendation: the separate table**
(`ar_receipt_number_counters`, this document's default, §6) — for
identical reasoning to AP-1c's own: every AR-1a/AR-1b schema change has
been purely additive (new tables, never an `ALTER` to an existing
table's primary key or an added discriminator column to data already in
production use), and `ar_number_counters`/`ar_receipt_number_counters`
being separate, single-purpose tables extends the exact pattern already
established rather than breaking it. Cost either way is one small
migration, not a redesign.

**2. `receipt_method` type — RESOLVED this revision: reuse the existing
`payment_method` enum.** Re-evaluated per the CTO review's explicit
direction, superseding this document's original "separate enum"
recommendation.

_Option A — reuse `payment_method` directly_ on
`customer_receipts.receipt_method` (column name stays `receipt_method`;
only the Postgres enum _type_ it's declared against is shared — this is
routine and unremarkable, the same way many differently-named columns
across this schema already share a type, e.g. every `*_by uuid`
audit-actor column). _Option B — create a separate `receipt_method`
enum_, structurally identical to `payment_method`.

Architectural comparison:

- **What kind of thing each option actually duplicates.** The AR-1a/
  AR-1b precedent this document originally leaned on (`ar_settings`
  separate from `ap_settings`, `ar_number_counters` separate from
  `ap_number_counters`, `customer_invoices` separate from
  `supplier_bills`) is about **tenant-scoped tables that own rows of
  independent business data**, each with its own lifecycle, its own RLS
  policy, and its own set of writers — genuine domain-owned entities
  that must be free to evolve independently. `payment_method` is not
  that: it is a small, closed, direction-agnostic vocabulary ("how did
  money move") with zero rows of its own, zero lifecycle, and zero
  tenant scoping — a descriptive tag on a document, not a business
  entity. Re-reading the actual precedent this revision, the codebase
  already draws exactly this distinction elsewhere: domain-owned tables
  are always duplicated per side (as above), but cross-cutting
  infrastructure/vocabulary is deliberately **shared unmodified** across
  AP and AR — `journal_entries`, `journal_lines`, `journal_number_counters`
  (§5/§17: "no AR-only journal series"), `chart_of_accounts`,
  `accounting_periods`, and `audit_logs` are all reused as-is by every
  AR Work Item so far, not forked. `payment_method` sits squarely in
  this second category, not the first. Applying the "AR/AP must not
  couple" principle to it was over-reading that precedent — the
  precedent's actual boundary is "don't share ownership of business
  data," not "don't share any type, ever."
- **Drift risk cuts in favor of reuse, not against it.** Two structurally
  identical enums evolving independently is a real hazard: if AP later
  gains a new method value (e.g. `WIRE`) and AR's parallel enum isn't
  updated in lockstep, AR would be unable to record a receipt method a
  customer actually used — an artificial capability gap with no
  business justification, purely a byproduct of the duplication. A
  single shared type has no such gap by construction.
- **Cost of being wrong either way is genuinely low** (a later
  split-or-merge migration, not a data-model rethink), so this was never
  a high-stakes choice — but between two low-cost options, reuse is the
  one that avoids introducing a second type that must be kept
  hand-in-sync with the first for no functional benefit.
- **No concrete future-domain requirement was found** during this
  revision's re-reading of the roadmap/schema that would need a receipt-
  only or payment-only method value — nothing in `docs/roadmap.md`'s
  Banking & Cash or AR sections names one. If such a requirement
  surfaces later (e.g. a receipt-only `CUSTOMER_PORTAL`/`AUTO_DEBIT`
  value with no AP equivalent), splitting a shared enum into two at that
  point is a normal, contained migration — not a reason to pre-emptively
  duplicate today against a hypothetical.

**Conclusion: reuse `payment_method`.** §6's schema and this document's
migration strategy (§19) are updated accordingly — `customer_receipts`
declares no new enum type for `receipt_method`; the column is typed
directly against the existing `payment_method` enum. This decision is
now resolved, not open for further approval unless new information
changes the calculus above.

No other decision in this document is presented as requiring approval.
Full-allocation-only posting (§10), no void/unwind (§4/§8), zero-
exception receipt immutability (§8/§17), the ascending-`id` locking
order (§13), the `paid_minor` CHECK-loosening target (§6), and the
settlement field set (§11) all directly restate an already-approved
source (the AP Foundation proposal itself, AP-1c's own decisions, or
AR-1b's own forward-declared structural exception) — none of them are
new judgment calls this Work Item is making on its own. The AR-1d
framing correction (§1) is a factual finding, not a decision — there is
nothing to approve, only a premise to correct before implementation
proceeds.

## 15. Test strategy (real Postgres e2e, matching AR-1b/AP-1c's rigor)

- `customer-receipts.e2e-spec.ts` — RBAC, validation (create/edit-time
  400s), draft CRUD (create with allocations, edit — full-array
  replacement, delete, both rejected once `POSTED` with 409), posting:
  full settlement (one invoice, exact payoff), partial settlement
  (receipt less than an invoice's total), multiple-invoice allocation in
  one receipt, over-allocation rejection (single invoice exceeds
  outstanding — 422; sum of allocations ≠ receipt amount — 422),
  posting against a `DRAFT` invoice (422), posting against another
  customer's invoice (422), immutability after posting (DB-trigger-
  level, raw-SQL, mirroring AR-1b's own immutability tests),
  cross-tenant/cross-legal-entity isolation (404-not-403).
- `ar-receipt-gl-integration.e2e-spec.ts` — a posted receipt's lines
  appear in `/accounts/:id/balance` (bank/cash debited, AR control
  credited), `/accounts/:id/ledger`, `/trial-balance` — same pattern as
  `ar-invoice-gl-integration.e2e-spec.ts`, plus the **sub-ledger/GL
  reconciliation invariant** defined precisely in §12.1: at a shared
  `asOf` (today/unspecified, matching the GL layer's own default),
  `SUM(customer_invoices.totalMinor - paidMinor)` over `POSTED` invoices
  with `invoiceDate <= asOf` in a legal entity equals that legal
  entity's AR control account closing balance via the unmodified
  `GET /accounts/:id/balance?asOf=<asOf>` endpoint — with every invoice
  and receipt in the test dated on or before the queried `asOf`, so the
  scenario stays inside the invariant's proven-exact region (§12.1's
  named limitation does not apply to this test).
- `ar-receipt-concurrency.e2e-spec.ts` — two concurrent receipts
  allocating to the same invoice where only one fits within the
  outstanding balance (exactly one 200, one 422, no over-allocation);
  two concurrent receipts allocating to disjoint amounts of the same
  invoice that both fit (both succeed, invoice ends `PARTIALLY_PAID`/
  `PAID` correctly — proving true concurrency-safe partial allocation,
  not just "first writer wins"); no burned receipt/journal number from a
  failed post between two successful ones; concurrent receipt-post vs.
  period-close (row-lock serialization, same shape as AR-1b's).
- DTO unit specs for `CreateCustomerReceiptDto`,
  `CreateCustomerReceiptAllocationDto`, `UpdateCustomerReceiptDto`.
- `route-role-matrix.spec.ts` extended: `CustomerReceiptsController`'s 6
  routes added (54 → 60, 13 controllers).
- Full regression: the entire existing suite (28 unit spec files / 240
  cases, 24 e2e spec files / 388 cases as of `1257b4b`) re-run and must
  stay green — no dedicated new file needed for this; it is the standard
  final verification gate, run at least twice for stability per prior
  Work Items' convention.

## 16. RLS / security, audit requirements, and immutability

Same conventions as every table in AR-1a/AR-1b/AP-1c, no deviation:

- **RLS**: `tenant_isolation` policy (with the `= ''` bypass-fix branch
  from day one) on all three new tables, in a new
  `008_ar_receipts_rls.sql` (continuing `001_enable_rls.sql` …
  `007_ar_invoices_rls.sql` in filename order). `legal_entity_id`
  isolation stays an explicit service-layer predicate, same reasoning as
  every other Finance table. RLS is force-enabled
  (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`) on all three tables.
- **RBAC**: `finance.poster` writes (create/edit/delete/post), any
  `finance.*` role reads — matching `SupplierPaymentsController`'s/
  `CustomerInvoicesController`'s split exactly (receipts are a
  transactional/posting document, not master data, same category as
  invoices, bills, and payments). **No new role is introduced** — the
  kickoff instruction explicitly asks this to be confirmed against the
  actual route-role matrix rather than invented, and the matrix's
  existing three-role shape already covers this cleanly.
- **Audit**: `entityType: "customer_receipt"` for receipt
  CREATE/UPDATE/DELETE/POST rows, `entityType: "journal_entry"` for the
  posting-time CREATE row, `entityType: "customer_invoice"` for each
  settled invoice's settlement-effect UPDATE row (§13 step 14) —
  identical shape to AP-1c's dual/N-row audit pattern.
- **Immutability**: two new trigger files —
  `011_customer_receipts_immutability_trigger.sql` (zero-exception: once
  `status = POSTED`, no UPDATE or DELETE permitted at all — no narrow
  exception, mirroring `007_supplier_payments_immutability_trigger.sql`)
  and `012_customer_receipt_allocations_immutability_trigger.sql`
  (zero-exception, joins to the parent receipt's `status`, mirroring
  `008_supplier_payment_allocations_immutability_trigger.sql`'s
  join-to-parent shape exactly, blocking INSERT as well as UPDATE/
  DELETE once the parent receipt is `POSTED`). `customer_invoices`
  itself needs **no new trigger file** — its existing narrow exception
  already covers this Work Item (§6/§11).

## 17. Numbering strategy

Race-free `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` against
`ar_receipt_number_counters`, identical atomic pattern to every other
Finance numbering sequence (`ap_number_counters`,
`ap_payment_number_counters`, `ar_number_counters`,
`journal_number_counters`) — a SEPARATE, single-purpose table per §14
decision 1, scoped per `(tenant_id, legal_entity_id)`. Format:
`RCT-{n:06d}` (e.g. `RCT-000001`) — chosen to avoid visual/textual
collision with `REV`(revenue) or `REC`(a natural abbreviation for
"reconciliation" elsewhere in this domain); this is a low-stakes
formatting choice, decided directly rather than gated in §14, the same
way AR-1b decided `INV-NNNNNN` directly. Journal numbers continue to
draw from the single shared `journal_number_counters` sequence — no
parallel AR-receipt-only journal series, matching every prior Work
Item's explicit invariant.

## 18. Required APIs

```
POST   /v1/finance/receipts                create DRAFT incl. allocations   finance.poster
GET    /v1/finance/receipts                 list                            any finance.* role
GET    /v1/finance/receipts/:id             detail incl. allocations        any finance.* role
PATCH  /v1/finance/receipts/:id             edit — DRAFT only                finance.poster
DELETE /v1/finance/receipts/:id             delete — DRAFT only              finance.poster
POST   /v1/finance/receipts/:id/post        DRAFT → POSTED                   finance.poster
```

`GET /receipts` filters: `status`, `customerId`, `dateFrom`/`dateTo` —
identical filter set to `GET /payments`. `GET /invoices` gains one
additional filter, `paymentStatus` (§3/§4) — a one-line extension to
`ListCustomerInvoicesFilters` and its controller query param, not a new
endpoint (mirrors `GET /bills`' own `paymentStatus` addition in AP-1c).

Response/error semantics follow existing convention exactly: `201` on
create, `200` on `/post` (`@HttpCode(200)` — transitions an existing
resource rather than creating one), `200` (Nest's default `@Delete()`
status — not `204`; verified against `supplier-payments.e2e-spec.ts`'s
own delete assertion) returning the deleted receipt in the standard
success envelope on delete (matching `SupplierPaymentsController`'s
exact shape), `400` for
create/edit-time shape validation failures, `404` for a nonexistent or
cross-scope id (never `403` — RLS plus the explicit legal-entity
predicate together produce a clean not-found rather than leaking
existence), `409` for a state-conflict action (edit/delete/post against
an already-`POSTED` receipt), `422` for posting-time business-rule
failures (unconfigured AR settings, no covering/open accounting period,
inactive bank/cash account, invoice not `POSTED`, invoice belongs to a
different customer, over-allocation, allocation sum ≠ receipt amount).

DTOs: `CreateCustomerReceiptDto` (`customerId`, `receiptDate`,
`receiptAmountMinor`, `receiptMethod`, `bankCashAccountId`, optional
`reference`/`memo`, `allocations: CreateCustomerReceiptAllocationDto[]`
with `@ArrayMinSize(1)`), `CreateCustomerReceiptAllocationDto`
(`invoiceId`, `allocatedAmountMinor`), `UpdateCustomerReceiptDto` (every
field optional, `customerId` not editable — same posture as
`UpdateSupplierPaymentDto.supplierId`). `currencyCode`/`status`/
`internalReference`/`journalEntryId`/`periodId` deliberately absent from
every DTO — all server-resolved, never client input.

## 19. Migration strategy

One Drizzle migration, generated the standard way
(`pnpm run generate`, reviewed line-by-line against schema.ts before
being applied to any database — same discipline as every prior Work
Item): adds `customer_receipt_status` enum (no new `receipt_method`
enum — §14 decision 2 resolves to reusing the existing `payment_method`
type), `ar_receipt_number_counters`, `customer_receipts`,
`customer_receipt_allocations`, and swaps the one CHECK constraint on
`customer_invoices` (§6). One new RLS file (`008_ar_receipts_rls.sql`,
covering all three new tables, per the established
one-file-per-Work-Item RLS convention) and two new immutability trigger
files (§16), applied via the existing `apply-rls.ts`/
`apply-db-constraints.ts` scripts, unchanged. Purely additive — no
existing table's column set changes, no existing trigger function's
logic changes (only `customer_invoices`' CHECK constraint, which is
schema-level, not trigger-level).

## 20. Implementation sequence

1. Schema: enums, `ar_receipt_number_counters`, `customer_receipts`,
   `customer_receipt_allocations`, `customer_invoices` CHECK swap;
   generate + review + apply migration to dev and test databases.
2. RLS file + immutability trigger files; apply; verify via `psql \d`
   and `pg_trigger`, same discipline as AR-1b.
3. DTOs (`CreateCustomerReceiptDto`,
   `CreateCustomerReceiptAllocationDto`, `UpdateCustomerReceiptDto`) +
   unit specs.
4. `CustomerReceiptsService` (draft CRUD + `post()`), replicating
   `SupplierPaymentsService`'s shape with AR renames and the polarity
   flip from §9.
5. `CustomerReceiptsController`, wired into `AccountsReceivableModule`.
6. `route-role-matrix.spec.ts` extended (54 → 60 routes, 13
   controllers).
7. `GET /invoices` `paymentStatus` filter (one-line addition to
   `CustomerInvoicesController`/`CustomerInvoicesService`).
8. e2e specs: `customer-receipts.e2e-spec.ts`,
   `ar-receipt-gl-integration.e2e-spec.ts` (incl. the reconciliation
   invariant), `ar-receipt-concurrency.e2e-spec.ts`.
9. Full verification: monorepo typecheck/lint/build, full unit suite,
   full sphere-finance e2e suite run at least twice for stability.
10. Careful `git diff` scoping (excluding the standing hardening
    exceptions), one clean commit, bundle, fresh-clone fast-forward
    verification against real origin, delivery — same closing procedure
    as AR-1a/AR-1b.

## 21. Acceptance criteria

- All items in §3's in-scope list implemented and passing real-Postgres
  e2e tests.
- A posted receipt produces a balanced two-line journal entry (Dr
  bank/cash, Cr AR control) that appears correctly in the GL read layer
  (balance, ledger, trial balance).
- Every allocated invoice's `paid_minor`/`payment_status` updates
  atomically with the receipt's own posting — both succeed or both roll
  back together, proven by at least one deliberately-failing posting
  scenario (e.g. a closed accounting period) leaving zero side effects.
- Over-allocation, double-allocation, and cross-customer allocation are
  all rejected, proven under genuine concurrent load (not merely
  sequential test cases).
- No burned receipt/journal number from a failed post, proven the same
  way AR-1b/AP-1c proved it.
- Posted receipts and posted-receipt allocations are immutable at the
  DB trigger level, proven by raw-SQL bypass-the-service-layer tests.
- Cross-tenant and cross-legal-entity isolation proven with real
  Postgres e2e tests (404, not 403, on out-of-scope access).
- The §12.1 reconciliation invariant holds exactly as defined: at a
  shared `asOf` boundary (today/unspecified, matching the GL layer's
  own default), `SUM(customer_invoices.totalMinor - paidMinor)` over
  `POSTED` invoices with `invoiceDate <= asOf` in a legal entity equals
  that legal entity's AR control account closing balance, after a mixed
  sequence of invoice and receipt postings all dated on or before that
  `asOf` — the invariant's proven-exact region, not its documented
  historical-`asOf` limitation.
- Full monorepo typecheck/lint/build clean; full existing regression
  suite (units + e2e) stays green with zero modification to any
  pre-existing test's expected behavior.
- `route-role-matrix.spec.ts` reflects the new controller with no role
  invented beyond the existing three.

## 22. Explicitly deferred (unchanged from AR-1b's own §9, restated)

AR-1d (customer balance, statement, ageing, AR/GL reconciliation
endpoints — §1/§4), credit/debit notes, void/unwind of a posted receipt
or invoice, real bank-account entities/bank feeds/reconciliation
(receipts keep using a manually-selected `chart_of_accounts` row, the
same documented seam AP-1a names for a future Banking & Cash Management
module), multi-currency/FX receipts, "receipt on account" partial
allocation of the receipt itself, and a DB-level cross-table trigger for
the allocation-sum invariant (an e2e reconciliation test is the chosen
rigor level, matching AP-1a/AP-1c's own stated reasoning, not a gap).
