# Finance Work Item 1d — Accounts Receivable Reporting / Read Layer

Status: **discovery/design — awaiting CTO review**. This document is a
proposal only. No source, schema, migration, or test file has been
created or modified as part of producing it. Implementation has not
started.

## 0. What was read before writing this proposal

Platform-level context:

- `docs/roadmap.md` — confirms current actual repository state (see §1
  below — the roadmap's own checklists have not been updated as AP/AR
  Work Items landed, which is itself a finding, not a blocker).
- `docs/architecture.md` — tenancy model (`tenant_id`/`legal_entity_id`,
  Postgres RLS), identity tiers, trust boundaries.
- `docs/security.md` — confirms RLS/audit/validation controls this Work
  Item must continue to respect; nothing here changes any of them (a
  pure read layer).
- `docs/plug-and-play-modules.md` — confirms this Work Item needs no
  gateway/module-manifest change: `sphere-finance`'s `noryx.module.json`
  already covers the whole `/v1/finance` `basePath`, and a new
  read-only controller inside the existing service is not a new
  pluggable module in the platform sense.

AP-1d — the direct precedent this Work Item mirrors:

- `docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md`
  (full) — governing design document for AP-1d, read in full; every
  section below cites the specific AP-1d design point it reuses or
  deliberately adapts.
- `services/sphere-finance/src/accounts-payable/ap-reports/` (full) —
  `ap-reports.service.ts`, `.controller.ts`, `.module.ts`, and all four
  query DTOs (`supplier-balance-query.dto.ts`,
  `supplier-statement-query.dto.ts`, `ap-ageing-query.dto.ts`,
  `ap-reconciliation-query.dto.ts`) — read in full, not just the
  proposal's description of them, since a proposal and its
  implementation can drift.
- `test/ap-supplier-balance.e2e-spec.ts`, `test/ap-supplier-statement.e2e-spec.ts`,
  `test/ap-ageing.e2e-spec.ts`, `test/ap-gl-reconciliation.e2e-spec.ts` —
  every `it()` case name read, to build §10's test matrix from the
  actual proven coverage, not a re-derivation from first principles.

AR-1a/1b/1c — the actual current AR domain this Work Item reports on:

- `docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md`,
  `docs/finance-work-item-ar-1b-customer-invoicing-proposal.md`,
  `docs/finance-work-item-1c-customer-receipts-proposal.md` (all three,
  full) — governing design for every table this Work Item reads.
- `services/sphere-finance/src/db/schema.ts` (the AR section in full:
  `customers`, `arSettings`, `arNumberCounters`, `customerInvoices`,
  `customerInvoiceLines`, `arReceiptNumberCounters`, `customerReceipts`,
  `customerReceiptAllocations`) — every column, type, and constraint
  this Work Item's queries depend on, confirmed directly against the
  actual current schema, not a prior summary of it.
- `src/accounts-receivable/customers/`, `.../ar-settings/`,
  `.../customer-invoices/`, `.../customer-receipts/` — the actual
  services/controllers, to confirm which fields are truly
  server-computed/authoritative versus client-supplied, and the exact
  create/edit/post validation and status-transition rules already
  enforced (so this Work Item's read queries assume nothing beyond what
  those services actually guarantee).

Shared infrastructure this Work Item reuses:

- `src/general-ledger/general-ledger.service.ts` (full) —
  `REPORT_TX_CONFIG` (exported for cross-file reuse), `getBalance`'s
  exact debit/credit-normal sign convention
  (`normalBalanceSign(type)`: `+1`/DEBIT-normal for ASSET/EXPENSE,
  `-1`/CREDIT-normal for LIABILITY/EQUITY/REVENUE), and confirmation
  that `getBalance` is **not** exported as a standalone
  account-id-parameterized helper other services can call directly
  (same finding AP-1d's own §6.4 recorded) — so this Work Item, like
  AP-1d, must write its own local raw-SQL AR-control-account-balance
  query rather than injecting `GeneralLedgerService`.
- `src/accounts-receivable/ar-settings/ar-settings.service.ts` —
  confirms `arControlAccountId` is validated `ASSET`-only at write time
  (`ArSettingsService.upsert`, line ~138), the AR-side mirror of AP's
  `apControlAccountId` being `LIABILITY`-only — this is the one place
  AP-1d's reconciliation sign convention cannot be copied verbatim; see
  §6.4 below.
- `src/common/validators/is-same-or-after-date.validator.ts` —
  `IsSameOrAfterDate`, already generic (not AP-specific), reused as-is
  for the statement's `dateTo >= dateFrom` check.
- `src/common/interceptors/response.interceptor.ts` — `ApiSuccessWithMeta`,
  already generic, reused as-is for statement/ageing responses.
- `src/route-role-matrix.spec.ts` — current state confirmed directly:
  **60 routes across 13 controllers** (post-AR-1c). This Work Item would
  extend it to 64 routes / 14 controllers.
- `src/accounts-receivable/accounts-receivable.module.ts` — its own doc
  comment already anticipates this Work Item verbatim: "Later AR Work
  Items (reporting) will add further sibling imports here, the same way
  AP-1d continued AccountsPayableModule."

## 1. Correction to a premise in the kickoff instruction, and other current-state findings

The kickoff instruction says "Do not assume AR-1d already exists just
because a roadmap or previous discussion may have described it as
planned. Confirm actual repository state first." Confirmed directly:

- **No `ar-reports` directory exists.** `services/sphere-finance/src/accounts-receivable/`
  contains exactly `customers/`, `ar-settings/`, `customer-invoices/`,
  `customer-receipts/` — no reporting module of any kind. AR-1d has not
  been started in any form.
- **`docs/roadmap.md` has not been updated to reflect AR-1a/1b/1c, or
  AP-1a–1d, landing.** Its "SPHERE FINANCE — remaining locked scope"
  table still lists every AR checkbox unchecked (`[ ] Customer master`,
  `[ ] Customer invoices`, `[ ] Receipts`, `[ ] Receipt allocation`,
  `[ ] AR ageing`, `[ ] AR reporting`) and every AP checkbox unchecked
  the same way, despite AP-1a–1d and AR-1a–1c all being implemented,
  tested, and committed (`4570f8a` through `a2c02ea`). This is a
  pre-existing documentation drift, not something this Work Item
  introduced or needs to fix to proceed — flagged here per the "confirm
  actual state, don't assume" instruction, same posture as the AR-1c
  proposal's own §1 finding about the AR-1d-already-exists premise in
  that Work Item's kickoff. **Recommendation, not a blocker:** the
  roadmap's checklists should be brought current in a small
  documentation-only pass at some point, independent of this Work
  Item's implementation.
- **`git log`/HEAD confirmed**: current `main` is `a2c02ea`
  ("feat(finance): implement AR-1c customer receipts & settlement"),
  matching the kickoff instruction's stated HEAD. AR-1a (`c85f1b9`),
  AR-1b (`1257b4b`), AR-1c (`a2c02ea`) are all present and, per the
  kickoff, pushed.
- **No `VOID` status exists anywhere in the AR schema** — same as AP.
  `customerInvoiceStatusEnum` is `["DRAFT", "POSTED"]`,
  `customerReceiptStatusEnum` is `["DRAFT", "POSTED"]`. A "void/credit
  note" workflow is out of scope for every AR Work Item so far, exactly
  mirroring AP-1d's own §0 finding — "exclude VOID" is satisfied
  vacuously (nothing to exclude yet).
- **No genuine correctness defect was found in AR-1a/1b/1c's accounting
  semantics or schema while producing this proposal.** Had one been
  found, this document would stop and report it rather than silently
  designing around it, per the kickoff's boundary instruction.

## 2. Objective

Build the Accounts Receivable reporting/read layer — the AR-side
conceptual equivalent of AP-1d — covering: customer balance, customer
statement, AR ageing, and AR/GL reconciliation. Pure read layer: no
new tables, no schema change, no new write path, no interaction with
posting/immutability/RLS beyond the read-scoping every other Finance
report already uses.

## 3. Scope

1. **Customer balance** — current and as-of-date outstanding
   receivable per customer (total invoiced, total received, total
   outstanding), reconciled against `customer_receipt_allocations` +
   posted `customer_invoices`.
2. **Customer statement** — chronological invoice/receipt/allocation
   history for one customer with opening balance, running balance,
   closing balance, date filtering.
3. **AR ageing** — bucketed (Current, 1-30, 31-60, 61-90, 91-120, 120+)
   report across all customers in a legal entity, using
   outstanding-after-allocations, excluding DRAFT invoices, as-of-date
   configurable, per-customer rows plus report-wide totals.
4. **AR/GL reconciliation** — an explicit invariant proving
   `sum(all customer outstanding balances) = AR control account
balance`, exposed as a dedicated read endpoint (extending, not
   replacing, the invariant AR-1c's own `ar-receipt-gl-integration.e2e-spec.ts`
   already tests once — see §6.4).

## 4. Explicit non-scope

AR hardening, Milestone 3.x, Accounts Payable (already built), Invoicing/
Billing beyond what AR-1b already shipped, Banking/reconciliation (bank
feeds), Cash management, Tax engine, FX/multi-currency, Fixed assets,
budgeting, any new customer-invoice or customer-receipt functionality
beyond what AR-1a/1b/1c already shipped, credit notes/void workflow, UI.
No change to the Journal Engine, `JournalEntriesModule`/`Service`/
`Controller`, the General Ledger read layer, or AR-1a/1b/1c's own
schema, services, or accounting semantics — this Work Item is additive
read-only code on top of data those Work Items already write correctly.

## 5. Data sources — proof the existing tables are sufficient

Every number this Work Item reports is derivable, with plain reads,
from tables AR-1a/1b/1c already created and populate correctly:

| Data needed                                         | Source                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer identity (code/name), scoping              | `customers` (`id`, `code`, `name`, `tenantId`, `legalEntityId`)                                                                                           |
| AR control account for a legal entity               | `ar_settings.ar_control_account_id` (validated `ASSET`, §0)                                                                                               |
| Invoiced amounts, invoice status, due date          | `customer_invoices` (`total_minor`, `status`, `invoice_date`, `due_date`, `internal_reference`)                                                           |
| Amount already received against an invoice          | `customer_invoices.paid_minor`/`payment_status` (written exclusively by `CustomerReceiptsService.post()`, per AR-1c)                                      |
| Receipt amounts, receipt status/date                | `customer_receipts` (`receipt_amount_minor`, `status`, `receipt_date`, `internal_reference`)                                                              |
| Which invoice(s) a receipt settled, and by how much | `customer_receipt_allocations` (`allocated_amount_minor`, `receipt_id`, `invoice_id`)                                                                     |
| GL-side balance of the AR control account           | `journal_entries`/`journal_lines` (already the AR control account's ledger — AR-1b/1c post real rows against it, no AR-reporting-specific columns needed) |

This is the exact same proof AP-1d's §3 already gave for the AP side —
`customer_invoices.total_minor`/`paid_minor`/`status`/`due_date`,
`customer_receipts.status`/`receipt_date`/`receipt_amount_minor`, and
`customer_receipt_allocations.allocated_amount_minor` are the complete,
authoritative AR sub-ledger. **No schema change of any kind is
required or proposed** — see §12 for the explicit no-schema-change
justification.

## 6. Customer balance

Directly mirrors AP-1d §6.1's two-mode `asOf` design
(`ApReportsService.getSupplierBalance`/`currentTotals`/`asOfTotals`),
substituted customer-for-supplier/invoice-for-bill/receipt-for-payment:

- **Current mode** (no `asOf`): `totalInvoicedMinor`/`totalReceivedMinor`
  summed directly from `customer_invoices.total_minor`/`paid_minor` for
  this customer's `POSTED` invoices — the same stored fields
  `CustomerReceiptsService.post()` maintains under the exact-allocation-
  sum and re-validated-under-lock invariants AR-1c's proposal §11/§13
  established. Cheapest query, and the same fast path §9's current-mode
  reconciliation reads from — but note this is genuinely a _different_
  computation from as-of mode called with an explicit `asOf` of today's
  date, not merely a cheaper equivalent of it: current mode's
  `paid_minor` can already reflect a POSTED receipt whose own
  `receipt_date` is after today (nothing prevents posting a
  future-dated receipt into an open period), a case as-of mode at
  `asOf = today` would correctly exclude. See §9.1's correction and
  §14 decision 2 for the full explanation — the two modes agree
  whenever no such future-dated-but-already-posted document exists,
  not because "today" makes them the same query.
- **As-of mode** (`asOf` given): an invoice only counts if
  `invoice_date <= asOf` (`totalInvoicedMinor`), and a receipt
  allocation only counts toward `totalReceivedMinor` if **both** its
  receipt's `receipt_date <= asOf` **and** its invoice's
  `invoice_date <= asOf` — a real historical reconstruction via
  `customer_receipt_allocations` joined to `customer_receipts` and
  `customer_invoices`, exactly AP-1d's `asOfTotals` query shape
  (`supplier_payment_allocations` → `supplier_payments` →
  `supplier_bills`), substituted 1:1. This does **not** rely on
  `paid_minor`'s current value at all — necessary because, as AR-1c's
  own approved proposal §12.1 documented and the CTO explicitly
  accepted, `paid_minor` is a mutable running total with no
  date-versioned history of its own. **This is a genuine improvement
  over AR-1c's own §12.1 invariant for historical `asOf` values** — see
  the explicit callout in §6.4/§11.

`totalOutstandingMinor = totalInvoicedMinor - totalReceivedMinor` in
both modes. A customer with zero posted invoices returns all-zero
totals, never a 404 — only a nonexistent/out-of-scope `customerId`
404s (mirrors `ApReportsService.resolveSupplier`'s convention,
itself mirroring `GeneralLedgerService.resolveAccount`).

Proposed route: `GET /v1/finance/customers/:id/balance?asOf=<date>`.

## 7. Customer statement

Directly mirrors AP-1d §6.2's chronological-rows-plus-running-balance
design, with one deliberate, explained AR-specific adaptation.

One flat, date-sorted list mixing two row kinds — `INVOICE` (a posted
invoice dated in range: `+totalMinor`, increases the amount owed) and
`RECEIPT` (a posted receipt dated in range: `-receiptAmountMinor`,
decreases it) — sorted by `(date, internalReference)` ascending. The
two prefixes, `INV-` and `RCT-`, never collide, and each is
zero-padded/fixed-width within its own series (AR-1b's/AR-1c's own
numbering convention), so lexicographic order matches numeric order —
identical reasoning to AP-1d's `BILL-`/`PAY-` sort, itself citing
`general-ledger.service.ts`'s `journal_number` string-sort doc comment.

`openingBalanceMinor` reuses §6's as-of-mode computation, evaluated
strictly before `dateFrom` when `dateFrom` is given, else `0` —
identical convention to AP-1d/`GeneralLedgerService.getLedger`.
`closingBalanceMinor` is the final running value (or the opening value
if no rows fall in range). Each `RECEIPT` row carries its own
`allocations` array (`invoiceId`, the invoice's `internalReference`,
`allocatedAmountMinor`).

Deliberately **not** phrased as `debitMinor`/`creditMinor` — same
reasoning as AP-1d §6.2 (a sub-ledger statement is read from the
customer's own point of view, "what do I owe them" becomes "what do I
owe us"; a signed `amountMinor` plus an explicit `type` field avoids
leaking GL sign convention into a customer-facing document).

**AR-specific adaptation (must be resolved — see §14 decision 1):**
AP-1d's statement description for a `BILL` row is
`Bill ${supplierBillNumber}` — the **supplier's own external** bill
number. `customer_invoices` has **no external-number field at all** —
per AR-1b's own proposal §2 decision 1, a customer invoice is a
document _we_ originate, so `internalReference` (e.g. `INV-000123`,
already surfaced as the row's `reference` field, exactly like AP-1d's
`BILL-000123`) is its only number, and there is nothing analogous to
`supplierBillNumber` to put in a description. This proposal recommends
`description: invoice.memo ?? "Invoice"` for `INVOICE` rows (falling
back to a generic label when no memo was recorded, rather than
repeating the reference that already has its own field) — and, for
symmetry, `description: receipt.memo ?? receipt.reference ?? "Receipt"`
for `RECEIPT` rows (AP-1d's own `PAYMENT` row uses
`p.reference ?? "Payment"`; AR's `customer_receipts` has **both**
`memo` and `reference`, so this recommends preferring `memo` when
present, since it is more likely to be a human-written note, falling
back to the free-text external `reference` and then the generic
label). This is a real design choice, not a mechanical copy — flagged
explicitly per the kickoff's "where AR is intentionally different,
explain why" instruction.

**Secondary clarification required by CTO review — full-allocation
invariant behind the `RECEIPT` row (must be documented, not just
assumed):** a `RECEIPT` statement row is represented by a single
signed amount, `-receiptAmountMinor`, rather than by summing that
receipt's individual `customer_receipt_allocations` rows. This is only
correct because AR-1c's own `post()` step 9 enforces, as a hard
invariant at posting time, that a receipt cannot be POSTED unless it
is **fully allocated**: `allocatedTotal !== before.receiptAmountMinor`
throws. In other words, under the current AR-1c implementation there
is no such thing as a POSTED "receipt on account" or "unapplied
receipt" — every POSTED receipt's allocations sum to exactly its own
`receiptAmountMinor`, so `-receiptAmountMinor` and
`-SUM(allocations.allocatedAmountMinor)` are always identical for any
POSTED receipt, and either is a correct statement-row amount today.
This proposal deliberately records that equivalence here, in writing,
so that if a future Work Item ever introduces partial allocation or
"receipt on account" functionality (receipts postable before being
fully applied), that future proposal is forced to revisit **this**
statement design rather than silently inheriting a `RECEIPT` row
amount that would then no longer equal the sum of what was actually
applied to invoices in the statement's date range. AR-1d itself adds
no such functionality and takes no dependency on it; this is a
forward-compatibility note, not a scope change.

Proposed route: `GET /v1/finance/customers/:id/statement?dateFrom=&dateTo=`.

## 8. AR ageing

Directly mirrors AP-1d §6.3's design and its established bucket
convention verbatim — the kickoff instruction says to reuse AP-1d's
bucket convention "unless there is a concrete AR reason not to," and
no such reason exists: an ageing report's purpose (how overdue are
today's open balances, as of a given date) is identical in direction
for AR as for AP, only the party owing money is reversed.

`outstandingMinor` per invoice is always `total_minor - paid_minor`
(current stored value, "after receipt allocations") — **not** a
date-filtered historical reconstruction (that is Balance's as-of mode,
§6). `asOf` only changes which bucket an invoice's `due_date` falls
into (`daysPastDue = asOf - due_date`).

Bucketing, identical boundaries to AP-1d: `daysPastDue <= 0` →
**Current / Not Due**; `1-30`, `31-60`, `61-90`, `91-120` inclusive;
`> 120` → **120+**. An invoice with a `null` due_date (schema allows
it — AR-1b never requires one, same as AP-1b) is bucketed as
**Current / Not Due**, same reasoning as AP-1d.

Only `POSTED` invoices with `outstandingMinor > 0` are considered —
`DRAFT` invoices excluded, a fully settled invoice
(`outstandingMinor = 0`) excluded entirely rather than appearing at
zero in every bucket. A customer with no bills in any nonzero bucket
does not appear as a report row; report-level totals sum only over
visible rows.

Proposed route: `GET /v1/finance/ar/ageing?asOf=&customerId=` — the
`customerId` filter is the same additive, non-AP-Foundation-sketch
convenience filter AP-1d's own `ApAgeingQueryDto.supplierId` already
established.

## 9. AR/GL reconciliation — the invariant

**This is the most important design area, per the kickoff instruction
— worked from first principles against the actual repository, not
copied from "same as AP."**

### 9.1 The two invariant modes, and why AR-1d needs both

AR-1c's own approved proposal §12.1 already defines and its
`ar-receipt-gl-integration.e2e-spec.ts` already proves **one** specific
form of this invariant: at `asOf` defaulting to today,

```
SUM(customer_invoices.total_minor - customer_invoices.paid_minor)
  WHERE tenant_id = :tenantId AND legal_entity_id = :legalEntityId
    AND status = 'POSTED' AND invoice_date <= :asOf
  =
AR control account's GL closing balance at the same :asOf
```

— with the explicitly accepted limitation that this is only
guaranteed exact for `asOf = today` or later, because `paid_minor` has
no date-versioned history (proposal §12.1, CTO-approved, "KEEP this
limitation, not build point-in-time settlement infrastructure").

AP-1d's §6.4 resolves the equivalent limitation for AP not by adding
infrastructure, but by using a **second query shape** for the as-of
case: a historical reconstruction via the allocation join
(`supplier_payment_allocations` → `supplier_payments.payment_date` →
`supplier_bills.bill_date`) instead of trusting today's stored
`paid_minor`. That reconstruction is **pure SQL over existing tables**
— not new infrastructure, just a different query — so it is directly
available on the AR side too, via
`customer_receipt_allocations` → `customer_receipts.receipt_date` →
`customer_invoices.invoice_date`.

**This proposal recommends AR-1d adopt AP-1d's exact two-mode
structure, with the mode dispatch resolved by parameter presence, not
by comparing dates** — current mode reads stored `paid_minor` directly
and is used **only when the caller supplies no `asOf` query parameter
at all**; as-of mode reconstructs from the allocation join and is used
for **any explicit `asOf` value whatsoever** — past, equal to today, or
after today. There is no date-comparison branch anywhere in this
dispatch (an earlier draft of this section incorrectly described one —
see the correction note immediately below).

**Why "asOf given but >= today" cannot fall into current mode (CTO
correction, required before coding):** `paid_minor` is updated the
instant a receipt _posts_, unconditionally — independent of that
receipt's own `receipt_date`. A receipt can be posted today with a
`receipt_date` next month (nothing prevents it, as long as an OPEN
accounting period covers that future date), so `paid_minor` can
already reflect money that, by its own `receipt_date`, has not
happened yet "as of" some earlier or even same-day explicit `asOf` the
caller asked for. Concretely: today = 2026-08-26, an invoice dated
2026-08-01 for 1000, a receipt dated 2026-09-01 for 1000 already
POSTED (fully settling the invoice, so `paid_minor = 1000`). A call to
`GET /ar/reconciliation?asOf=2026-08-31` must report this invoice as
still fully outstanding as of that date — the receipt's own
`receipt_date` (Sept 1) is after the requested `asOf` (Aug 31), so it
should not count yet. But current mode's sub-ledger side
(`total_minor - paid_minor`) would already show it as settled (0
outstanding), while the GL side (`transaction_date <= asOf` correctly
excludes the September journal entry, since Sept 1 > Aug 31) still
shows the AR control account carrying the full balance. The two sides
would disagree — a false "not reconciled" (or, symmetrically, a false
"reconciled" if some other transaction happened to offset it),
entirely an artifact of the wrong mode being selected, not a real
accounting discrepancy. Note this failure mode is **not** limited to a
future `asOf` — the same mismatch occurs for any explicit `asOf` at or
after today for which a later-dated-but-already-posted document
exists, which is exactly why the dispatch rule is "no parameter at
all," not any date comparison, however phrased.

Concretely, this means **AR-1d's own as-of-mode reconciliation is more
precise than AR-1c's own §12.1 invariant for a historical `asOf`** — a
genuine improvement, achieved with zero new tables, by reusing exactly
the technique AP-1d already established. This is flagged as an
explicit CTO decision (§14 decision 2), not silently adopted, since it
means AR-1d's reconciliation endpoint and AR-1c's own existing
GL-integration test compute the invariant two different ways for a
historical `asOf` (they agree by construction whenever no
already-posted document is dated between the two computations' implicit
"as of" points — see the correction above for the one case where they
would not, which is exactly why as-of mode is dispatched on parameter
presence, never on a date comparison against "today").

### 9.2 The exact mathematical invariant this Work Item implements

**Sub-ledger side** (current mode — used if, and only if, the caller
supplies no `asOf` query parameter at all; not selected by any
date comparison, per the correction in §9.1):

```
subLedgerTotalOutstandingMinor =
  SUM(total_minor) - SUM(paid_minor)
  OVER customer_invoices
  WHERE tenant_id = :tenantId
    AND legal_entity_id = :legalEntityId
    AND status = 'POSTED'
```

**Sub-ledger side** (as-of mode — used for any explicit `asOf` query
parameter at all, regardless of whether that date is before, equal to,
or after today):

```
totalInvoicedMinor(asOf) =
  SUM(ci.total_minor)
  WHERE ci.tenant_id = :tenantId AND ci.legal_entity_id = :legalEntityId
    AND ci.status = 'POSTED' AND ci.invoice_date <= :asOf

totalReceivedMinor(asOf) =
  SUM(cra.allocated_amount_minor)
  FROM customer_receipt_allocations cra
  JOIN customer_receipts cr ON cr.id = cra.receipt_id
  JOIN customer_invoices ci2 ON ci2.id = cra.invoice_id
  WHERE cra.tenant_id = :tenantId
    AND cr.tenant_id = :tenantId AND cr.legal_entity_id = :legalEntityId
    AND cr.status = 'POSTED' AND cr.receipt_date <= :asOf
    AND ci2.tenant_id = :tenantId AND ci2.legal_entity_id = :legalEntityId
    AND ci2.status = 'POSTED' AND ci2.invoice_date <= :asOf

subLedgerTotalOutstandingMinor(asOf) = totalInvoicedMinor(asOf) - totalReceivedMinor(asOf)
```

**GL side** (both modes, evaluated at the same `asOf`):

```
glArControlAccountBalanceMinor(asOf) =
  SUM(jl.debit_minor) - SUM(jl.credit_minor)     <-- ASSET is DEBIT-normal, sign = +1
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  WHERE jl.account_id = :arControlAccountId
    AND jl.tenant_id = :tenantId
    AND je.tenant_id = :tenantId AND je.legal_entity_id = :legalEntityId
    AND je.status = 'POSTED'
    AND je.transaction_date <= :asOf
```

**This is the one place AP-1d's implementation cannot be copied
verbatim**: AP's control account is a `LIABILITY` (credit-normal,
`rawCredit - rawDebit`, confirmed at `ApSettingsService.upsert`); AR's
control account is validated `ASSET`-only at
`ArSettingsService.upsert` (§0), which is DEBIT-normal
(`rawDebit - rawCredit`, per `GeneralLedgerService`'s own
`normalBalanceSign` — ASSET/EXPENSE → `+1`, the opposite sign branch
from AP's LIABILITY/EQUITY/REVENUE → `-1`). The query shape is
identical; the sign is deliberately flipped. This must be gotten
exactly right in implementation — misreading it would silently invert
every "reconciled: true/false" result.

**The invariant**: `differenceMinor = subLedgerTotalOutstandingMinor(asOf) - glArControlAccountBalanceMinor(asOf)`;
`reconciled = differenceMinor === 0`. Both are reported, so a real
drift is diagnosable from the response itself.

### 9.3 Precise scope of every term

- **Document scope**: `POSTED` only, on both sides — `DRAFT`
  invoices/receipts never counted (a draft never posted a real journal
  row, so counting it would immediately break the invariant against
  the GL side, which only ever reflects `POSTED` `journal_entries`).
- **Tenant scope**: `tenant_id = :tenantId` on every table touched,
  enforced twice — once by RLS (`withTenant()`, unconditional) and once
  as an explicit predicate in every raw-SQL query, same double-enforcement
  convention as every other Finance report/service in this codebase.
- **Legal entity scope**: `legal_entity_id = :legalEntityId`, always an
  explicit service-layer predicate (RLS here is `tenant_id`-only,
  confirmed across every AR-1a/1b/1c RLS file) — a single reconciliation
  call always answers for exactly one legal entity, matching AP-1d's
  own posture and the AR control account itself being a
  per-legal-entity configuration (`ar_settings`'s primary key is
  `(tenantId, legalEntityId)`).
- **Customer scope**: always legal-entity-wide — **there is no
  `customerId` parameter on `/ar/reconciliation`, by CTO decision (§14
  decision 3, resolved).** A single customer's invoices don't
  correspond to any sub-account of the GL's AR control account (the
  chart of accounts has no per-customer AR sub-ledger account), so a
  customer-filtered sub-ledger total would have no meaningful GL-side
  figure to compare it against — exposing such a filter here would
  read as a per-customer reconciliation proof the endpoint structurally
  cannot make. Customer-level outstanding balance is available, fully
  reconciled to nothing but itself, via `/customers/:id/balance` (§6)
  and `/customers/:id/statement` (§7) — those two endpoints are the
  correct place to answer "what does this one customer owe," and
  neither claims a GL-reconciliation property, so there is no gap.
  `/ar/ageing` (§8) is the one report in this Work Item that does keep
  an optional `customerId` filter, and deliberately so: ageing is a
  bucketed report filter, not a reconciliation invariant, so the same
  objection doesn't apply to it (see §8 and §14 decision 3).
- **`asOf` semantics**: inclusive (`<=`) on every date comparison —
  "as of this date" includes that date, consistent with every other
  `asOf` parameter in this codebase (`GeneralLedgerService`,
  AP-1d, AR-1c's own §12.1).
- **`invoiceDate`/`receiptDate` semantics**: exactly the source
  document's own date field, verbatim — no fallback to `postedAt`,
  `createdAt`, or `transaction_date`. Confirmed directly against
  `CustomerInvoicesService.post()` and `CustomerReceiptsService.post()`:
  both set `journal_entries.transactionDate` from `before.invoiceDate`/
  `before.receiptDate` verbatim, with zero exceptions — the same fact
  AR-1c's own §12.1 already verified and this proposal re-confirms
  independently against the current repository rather than trusting
  the prior write-up.
- **Future-dated documents (relative to the requested `asOf`, not
  relative to today)**: applies within **as-of mode only** — an
  invoice or receipt dated after the requested `asOf` is excluded from
  the as-of-mode sub-ledger side (`invoice_date <= asOf`/
  `receipt_date <= asOf`) and, symmetrically, its journal entry is
  excluded from the GL side (`transaction_date <= asOf`) — both sides
  treat a document dated after `asOf` identically, so the invariant
  holds regardless of whether any test data happens to include one.
  **Current mode applies no date filter of any kind** to either its
  sub-ledger side (`paid_minor` is a live running total, not filtered
  by any document date) or, by construction, is never entered for a
  request that supplied an explicit `asOf` in the first place — so
  "future-dated relative to asOf" is not a concept current mode ever
  needs to reason about. This is precisely the distinction the §9.1
  correction turns on: the moment a request supplies any `asOf` at
  all, this bullet's exclusion rule applies in full, with no
  date-value exception. No special-casing beyond the mode-dispatch
  rule itself is needed or proposed.
- **AR control account selection**: exactly `ar_settings.ar_control_account_id`
  for the caller's `(tenantId, legalEntityId)` — a 404 (not 422) if AR
  settings aren't configured, matching AP-1d's `loadApSettingsOrThrow`
  posture ("a report can't identify the control account without it";
  this is a read precondition, distinct from AR-1c's own posting-time
  422 re-validation of the same fact, which is a business-rule
  failure, not a missing-precondition read failure).
- **Rounding/minor-unit arithmetic**: none needed — every amount in
  this codebase is already an integer minor-unit (`bigint`, `mode:
"number"`), and every aggregate here is a plain integer `SUM`. No
  floating-point risk anywhere in this design, identical to AP-1d.

Proposed route: `GET /v1/finance/ar/reconciliation?asOf=` — no
`customerId` parameter (§14 decision 3, resolved: do not expose one).

## 10. API surface, DTOs, response envelope, security

Verbatim adaptation of AP-1d §5/§7:

```
GET /v1/finance/customers/:id/balance       open receivable balance       any finance.* role
GET /v1/finance/customers/:id/statement     invoice/receipt history       any finance.* role
GET /v1/finance/ar/ageing                   bucketed ageing report        any finance.* role
GET /v1/finance/ar/reconciliation           sub-ledger/GL reconciliation  any finance.* role
```

All four are pure reads — same RBAC posture as `ApReportsController`/
`GeneralLedgerController` (`@Roles("finance.viewer", "finance.poster",
"finance.admin")` on every route, no write-side split since nothing
here mutates), not `CustomerInvoicesController`/
`CustomerReceiptsController`'s poster-writes/any-role-reads split,
which exists specifically for transactional/posting documents this
module has none of.

Controller shape mirrors `ApReportsController` exactly: `@Controller()`
with no prefix, each method supplying its own full path (routes live
under two different prefixes, `customers/:id/...` and `ar/...`, inside
one controller — the same pattern `ApReportsController` already
established for `suppliers/:id/...` + `ap/...`, itself following
`GeneralLedgerController`).

`tenantId`/`legalEntityId` always come from the verified JWT via
`requireTenantContext()`, never from a request param/body.

Proposed DTOs (`class-validator`, all query params optional):

- `CustomerBalanceQueryDto` — `asOf?: string` (`@IsDateString`).
- `CustomerStatementQueryDto` — `dateFrom?: string`, `dateTo?: string`
  (`@IsSameOrAfterDate("dateFrom")` on `dateTo`, reusing the existing
  generic validator as-is).
- `ArAgeingQueryDto` — `asOf?: string`, `customerId?: string`
  (`@IsUUID`).
- `ArReconciliationQueryDto` — `asOf?: string` only. No `customerId`
  field (§14 decision 3, resolved: `/ar/reconciliation` is always
  legal-entity-wide).

Response envelope: bare `ApiSuccess<T>` for balance/reconciliation
(`{ ok, data }`, no `meta` needed — everything is already inside the
single result object, identical to `ApReportsController.balance`/
`.reconciliation`); `ApiSuccessWithMeta<Row[], Meta>` for
statement/ageing (`{ ok, data: Row[], meta: Meta }`, identical to
`ApReportsController.statement`/`.ageing`).

`route-role-matrix.spec.ts`: import `ArReportsController`, add it to
`discoverRoutes()`, add its 4 `EXPECTED` entries (60 → 64 routes,
13 → 14 controllers).

## 11. Architecture / module structure / reuse

A new sibling module under `accounts-receivable/`, exactly as
`accounts-receivable.module.ts`'s own doc comment anticipated:

```
src/accounts-receivable/ar-reports/
  ar-reports.service.ts
  ar-reports.controller.ts
  ar-reports.module.ts
  dto/customer-balance-query.dto.ts (+ .spec.ts)
  dto/customer-statement-query.dto.ts (+ .spec.ts)
  dto/ar-ageing-query.dto.ts (+ .spec.ts)
  dto/ar-reconciliation-query.dto.ts (+ .spec.ts)
```

Wired into `accounts-receivable.module.ts`'s `imports` array as a
fifth sibling, alongside `CustomersModule`/`ArSettingsModule`/
`CustomerInvoicesModule`/`CustomerReceiptsModule` — file:
`src/accounts-receivable/accounts-receivable.module.ts`.

Explicit reuse, with exact file references:

- `withTenant()`/`TxClient` — `src/db/db.ts`, unchanged.
- `REPORT_TX_CONFIG` — imported directly from
  `src/general-ledger/general-ledger.service.ts` (already exported for
  cross-file reuse, exactly as AP-1d imports it), not duplicated. Every
  method in this Work Item's service runs inside
  `withTenant(tenantId, ..., REPORT_TX_CONFIG)` — REPEATABLE READ +
  READ ONLY, for the identical reason AP-1d/GL adopted it: a report
  built from several separate `SELECT`s needs one consistent snapshot,
  or a concurrent invoice/receipt posting between two of a report's own
  statements could produce a response whose parts don't reconcile with
  each other.
- `@noryx/auth-core`'s `JwtAuthGuard`/`RolesGuard`/`Roles`/`CurrentUser`/
  `requireTenantContext` — unchanged, same as every controller.
- `ApiSuccess`/`ApiSuccessWithMeta` —
  `src/common/interceptors/response.interceptor.ts`, unchanged.
- `IsSameOrAfterDate` —
  `src/common/validators/is-same-or-after-date.validator.ts`, unchanged
  (already generic, not AP-specific — confirmed by reading it).
- No new RBAC role — the existing `finance.viewer`/`finance.poster`/
  `finance.admin` three-role model is unchanged, identical instruction
  the AR-1c kickoff already gave and this Work Item re-confirms applies
  here too.
- **`ApReportsService` itself is not imported or reused as code** — its
  query _shape_ (current/as-of split, raw-SQL aggregate helpers,
  `todayUtc()`/`toNumber()` conventions) is followed, but every query
  is rewritten against AR's own tables, column names, and (per §9.2)
  flipped GL sign convention. This mirrors AP-1d's own posture toward
  `GeneralLedgerService` — the _pattern_ is reused, not a cross-module
  service dependency, keeping `ar-reports` (like `ap-reports`)
  self-contained and reading only its own domain's tables plus
  `journal_entries`/`journal_lines` directly.

## 12. No-schema-change justification

Per the kickoff instruction's explicit steer, and proven concretely in
§5's table: **zero schema changes**. No new table, no new column, no
new migration, no `drizzle/rls/*.sql`, no `drizzle/constraints/*.sql`.
Every figure this Work Item reports — customer balance, statement
rows, ageing buckets, and both reconciliation modes (§9) — is derivable
with plain `SELECT`s (including the as-of reconstruction, which is a
join across three already-existing tables, not new infrastructure)
from `customers`, `ar_settings`, `customer_invoices`,
`customer_receipts`, `customer_receipt_allocations`,
`journal_entries`, and `journal_lines`, all already correctly written
by AR-1a/1b/1c. No schema change is proposed; had one been found
necessary, this document would stop here and report why rather than
silently designing one, per the kickoff's explicit instruction.

## 13. Test strategy

Following AP-1d's established real-Postgres e2e convention exactly
(`tokenFor()`, full Nest app boot with the same pipe/interceptor/filter
wiring as every other spec) — **not written yet, specified here for
CTO review**:

`test/ar-customer-balance.e2e-spec.ts` (mirrors
`ap-supplier-balance.e2e-spec.ts`'s 12 cases):
no transactions (all-zero); one unpaid invoice; multiple invoices;
partial receipt; full receipt; multiple receipts accumulating;
multiple customers isolated from each other; as-of-date behavior (a
receipt dated after `asOf` does not reduce the as-of balance);
cross-tenant isolation (404); cross-legal-entity isolation (404);
nonexistent `customerId` (404); readable by every finance role.

`test/ar-customer-statement.e2e-spec.ts` (mirrors
`ap-supplier-statement.e2e-spec.ts`'s 5 cases): empty statement
(zero rows, opening = closing = 0); invoices + receipts + allocations

- running balance + chronological ordering full walkthrough; date
  ranges (opening balance reflects everything strictly before
  `dateFrom`, rows outside range excluded); cross-tenant isolation
  (404); `dateTo` before `dateFrom` rejected with 400.

`test/ar-ageing.e2e-spec.ts` (mirrors `ap-ageing.e2e-spec.ts`'s 9
cases): every bucket, one invoice per bucket at a fixed `asOf`; an
invoice with no due date bucketed as current; partial receipt (invoice
appears only for its remaining balance, in its due-date bucket); a
fully received invoice excluded entirely; a DRAFT invoice never
appears; multiple customers, each row reflecting only its own
invoices; as-of date changes which bucket the same invoice lands in;
report totals equal the sum of visible per-customer rows;
reconciliation to customer balances (a customer's ageing
`totalOutstandingMinor` equals its own `/balance` `totalOutstandingMinor`).

`test/ar-gl-reconciliation.e2e-spec.ts` (mirrors
`ap-gl-reconciliation.e2e-spec.ts`'s 4 cases, **plus** three new cases
this Work Item's own §9.1 finding requires that AP-1d's precedent
doesn't need to cover): reconciled with no activity (both sides zero);
sub-ledger total equals the GL AR control account balance across
multiple invoices, multiple receipts, multiple customers, and partial
settlement; legal-entity isolation (entity B's reconciliation
unaffected by entity A's activity, each reconciles independently);
404 if AR settings aren't configured; **as-of mode at a historical
(past) date correctly reconstructs via the allocation join and still
reconciles, proving §9.1's two-mode design is actually necessary and
correct** (construct a case where `paid_minor`'s current value would
give a wrong answer for a past `asOf` — a receipt posted after that
`asOf` against an invoice dated before it — and confirm as-of mode
still reconciles while a naive current-mode read at that same past
`asOf` would not); **the CTO-corrected acceptance case — an explicit
`asOf` at or after today must still use as-of reconstruction, never
the `paid_minor` fast path, because `paid_minor` updates at
receipt-_posting_ time regardless of the receipt's own `receipt_date`**
(this is the exact scenario the CTO's review flagged and is the
Work Item's single most important reconciliation test): set up
`today = 2026-08-26`; a POSTED invoice dated `2026-08-01`
(`invoiceDate <= asOf` for the `asOf` used below); a receipt dated
`2026-09-01` — after both `today` and the `asOf` used below — already
POSTED and fully allocated against that invoice, so
`customer_invoices.paid_minor` for that invoice is already equal to
its `total_minor` _right now_; call
`GET /ar/reconciliation?asOf=2026-08-31` (an explicit `asOf` that is
itself at/after `today`, not a historical date in the colloquial
sense) and assert: (a) the sub-ledger side, reconstructed via
`customer_receipt_allocations` joined to
`customer_receipts.receipt_date <= asOf`, still shows the invoice as
fully **outstanding** (the `2026-09-01` receipt's allocation is
correctly excluded because its `receipt_date > asOf`); (b) the GL
side, filtered by `journal_entries.transaction_date <= asOf`, also
excludes that receipt's journal entry for the identical reason; (c)
both sides therefore agree and `reconciled: true`; (d) as a negative
control in the same test, assert that a **naive** `paid_minor`-based
read (i.e., what current mode would have returned had it been
incorrectly selected for this request) would show the invoice as
fully settled — proving the corrected dispatch rule, not just the
as-of reconstruction formula itself, is what this test protects. A
second, minimal variant of this case additionally asserts the same
outcome for `GET /ar/reconciliation` called with **no** `asOf` at all
(current mode, correctly using `paid_minor` directly with no date
filtering), confirming current mode is not broken by the fix — only
reachable when the caller supplies no `asOf`, per §9.1; **future-dated
documents are excluded symmetrically from both sides in as-of mode**
(an invoice/receipt dated after `asOf` affects neither the sub-ledger
nor the GL side of that `asOf`'s computation, and current mode is
simply never entered when an explicit `asOf` — of any value — was
supplied).

DTO unit specs (`*.dto.spec.ts`) for all four (or three, pending §14
decision 3) new query DTOs, mirroring AP-1d's DTO spec shape exactly.

`route-role-matrix.spec.ts` extended per §10.

**Concurrency**: per AP-1d's own §8 finding and the kickoff's "add
concurrency tests only where the actual implementation introduces
concurrency-sensitive behavior" instruction — this Work Item introduces
none (plain multi-statement reads under `REPORT_TX_CONFIG`, no
`SELECT ... FOR UPDATE`, a reader is never blocked by a writer's row
lock under Postgres MVCC). No dedicated `ar-reports-concurrency.e2e-spec.ts`
is proposed; ordinary posting concurrency is already covered by
`ar-invoice-concurrency.e2e-spec.ts` (AR-1b) and
`ar-receipt-concurrency.e2e-spec.ts` (AR-1c).

## 14. Decisions requiring CTO approval

**Decision 1 — statement row `description` for `INVOICE`/`RECEIPT`
rows (§7).** Recommended: `invoice.memo ?? "Invoice"` for `INVOICE`
rows, `receipt.memo ?? receipt.reference ?? "Receipt"` for `RECEIPT`
rows. Rationale: `customer_invoices` has no external-number field
analogous to `supplierBillNumber`, so AP-1d's exact description
expression cannot be reused verbatim; this is the closest natural
adaptation, preferring a human-written memo over repeating the
reference (which already has its own dedicated field on both row
kinds). Alternative considered and rejected: a bare `"Invoice"`/
`"Receipt"` literal with no memo fallback — rejected because it
discards genuinely useful information (an invoice or receipt memo)
that a supplier-side reader would in fact see reflected via
`supplierBillNumber`/`p.reference` today.

**Decision 2 — adopt AP-1d's two-mode (current fast path when no
`asOf` is supplied at all, plus allocation-join as-of reconstruction
for any explicit `asOf`) reconciliation design, rather than AR-1c's
own single-formula §12.1 invariant, for AR-1d's `/ar/reconciliation`
endpoint (§9.1, corrected per CTO review — see below).** Recommended:
adopt it — it strictly improves historical-`asOf` accuracy at zero
schema cost, using only the same query technique AP-1d already
established and this repository's CI/e2e discipline already trusts.

The one thing to flag explicitly, restated here after the CTO's §9.1
correction so this decision does not itself drift back into the
corrected mistake: **AR-1c's own §12.1 invariant
(`SUM(totalMinor - paidMinor)` over `invoiceDate <= asOf`, no receipt-date
filtering of any kind) and AR-1d's proposed as-of-mode query
(allocation-join reconstruction filtered on `receipt_date <= asOf`)
are two different formulas, and they are only guaranteed to agree when
every POSTED receipt contributing to `paid_minor` has its own
`receipt_date <= asOf`.** That holds for `ar-receipt-gl-integration.e2e-spec.ts`
today because that test's fixture data contains no receipt dated after
its own `asOf`, not because `asOf = today` is itself special — the
same future-dated-but-POSTED-receipt scenario the CTO's correction
addresses in §9.1/§9.3 would, if it existed in that fixture, break
AR-1c's simpler invariant too (`paid_minor` would already include the
receipt while the GL side, filtered by `transaction_date <= asOf`,
would not), regardless of whether `asOf` happened to equal today. This
is not a defect in AR-1c to fix here — its own proposal §12.1
explicitly scoped the invariant to ordinary, non-future-dated posting
sequences, and AR-1c is already implemented and committed, out of
scope for this Work Item — but this decision must not claim a general
"consistent at `asOf = today`" guarantee that does not actually hold.
Once AR-1d is implemented, both files' doc comments should note this
cross-reference explicitly, so a future reader does not mistake
AR-1c's simpler invariant for load-bearing historical correctness it
was never designed to have.

**Decision 3 — whether `/ar/reconciliation` should accept an optional
`customerId` filter at all (§9.3). RESOLVED by CTO review: no.**
AP-1d's own `/ap/reconciliation` has no `supplierId` filter (only
`/ap/ageing` does) — the reconciliation endpoint's entire point is a
legal-entity-wide GL invariant, and a customer-filtered sub-ledger
total does not correspond to any meaningful GL-side figure to compare
it against (the GL doesn't sub-account the AR control account per
customer). **Decision: follow AP-1d exactly — `/ar/reconciliation` has
no `customerId` parameter, in the DTO, the route, the SQL, or the
implementation.** It is offered only on `/ar/ageing`, matching AP-1d's
own precedent precisely rather than introducing an asymmetry with no
concrete AR-specific justification. §9.2's SQL and §9.3's "Customer
scope" bullet, §9's route line, and §10's `ArReconciliationQueryDto`
have all been updated to reflect this directly — no conditional or
optional `customerId` reference remains anywhere in the reconciliation
design. Customer-level outstanding balance remains fully available via
`/customers/:id/balance` and `/customers/:id/statement`, neither of
which claims (or needs) a GL-reconciliation property.

**Decision 4 — file/type naming: `ArReportsService`/`ArReportsController`/
`ArReportsModule` under `ar-reports/`, exactly mirroring
`ApReportsService`/`ApReportsController`/`ApReportsModule` under
`ap-reports/`.** No alternative naming was found to have any
justification — flagged only for formal sign-off, not because a real
alternative was considered.

## 15. Acceptance criteria

- Zero schema/migration/RLS/constraint changes (§12) — confirmed by an
  empty `git diff` against `schema.ts`/`drizzle/` at delivery time.
- All four endpoints implemented exactly as approved in §10/§14,
  returning `ApiSuccess`/`ApiSuccessWithMeta` per §10.
- `/ar/reconciliation`'s approved API surface has **no** `customerId`
  parameter — `GET /v1/finance/ar/reconciliation?asOf=` only, backed by
  `ArReconciliationQueryDto { asOf?: string }`, and always
  legal-entity-wide in its SQL (§9.2/§9.3, §14 decision 3, resolved).
  `/ar/ageing` retains its `customerId` filter; the other two endpoints
  are unaffected.
- `route-role-matrix.spec.ts` extended and green (64 routes / 14
  controllers).
- Every test named in §13 implemented and passing against real
  Postgres, including the three AR-specific reconciliation cases §13
  adds beyond AP-1d's own precedent (historical as-of correctness,
  the CTO-corrected asOf-at-or-after-today acceptance case, and
  future-dated-document symmetry).
- Full sphere-finance e2e suite (currently 27 suites / 427 tests) run
  at least twice for stability with the new suites added, all green.
- Monorepo typecheck/lint/build clean.
- No change to any AR-1a/1b/1c file's behavior — a diff review confirms
  every touched/new file belongs to this Work Item's own `ar-reports`
  module, `accounts-receivable.module.ts` (one-line sibling-import
  addition), and `route-role-matrix.spec.ts`.

## 16. Risks / limitations

**A. Must resolve before implementation:** none identified. Every
open question in this proposal is posed as a CTO decision in §14, with
a stated recommendation — none of them blocks writing correct code
either way once resolved.

**B. Recommended decisions:** §14's four decisions, all with a stated
recommendation above.

**C. Known limitations accepted by design:**

- `/ar/ageing`'s `outstandingMinor` is always current-stored
  `total_minor - paid_minor`, never a historical reconstruction — by
  design, matching AP-1d's own §6.3 reasoning (an ageing report answers
  "how overdue would today's open balances have been as of this date,"
  not "replay history"), not a gap.
- No pagination on statement/ageing (bounded by real business data
  volume, matching the Trial Balance precedent — AP-1d §10).
- No CSV/PDF export, no statement email/delivery (UI/reporting-layer
  concern, out of scope for every Finance Work Item so far).
- Per §14 decision 3 (resolved), `/ar/reconciliation` has no
  `customerId` filter, so there is intentionally no single-customer
  reconciliation endpoint — a customer's own outstanding total is
  still fully available via `/balance`, just not cross-checked against
  a GL figure, because no such GL figure exists at that granularity
  (the chart of accounts has no per-customer AR control-account
  sub-account).

**D. Future work / later Work Items:**

- Bringing `docs/roadmap.md`'s checklists current (§1) — a
  documentation-only pass, independent of this Work Item.
- A `customerId`-scoped variant of reconciliation, if a future Work
  Item introduces per-customer GL sub-accounts (not part of the
  current chart-of-accounts design) — not proposed now, since nothing
  in the current schema would make such a comparison meaningful.
- CSV/PDF/export delivery for any of these four reports (explicitly
  out of scope here, same as AP-1d).

## 17. What's still deliberately left for later

Everything named out-of-scope in §4, plus the future-work items in
§16.D. Within this Work Item's own subject area: no configurable
bucket widths beyond the six named buckets (same as AP-1d — the
instruction's "configurable" refers to the as-of date, not the bucket
boundaries).
