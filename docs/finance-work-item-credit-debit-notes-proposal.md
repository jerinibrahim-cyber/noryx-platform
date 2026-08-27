# Finance Work Item Proposal: Credit Notes (AR) & Debit Notes (AP)

Discovery basis: repository HEAD `2f19e1f` ("feat(finance): implement
Financial Statements (P&L + Balance Sheet) read layer"), live-inspected
for this proposal, not inferred from prior session summaries.

**Revision note (CTO review round 1):** the CTO reviewed this proposal
directionally approved and resolved §19's open decision as **Option A —
reuse `paidMinor`/`paymentStatus`** — but corrected two inaccuracies in
the original submission: (1) Option A does **not** mean zero
`ar-reports`/`ap-reports` changes — current-mode Balance/Ageing/
Reconciliation read `paidMinor` directly and are unaffected, but
**historical as-of reconstruction** (`asOfTotals` in both report
services, and Customer/Supplier Statement's opening balance) rebuilds
settlement purely from receipt/payment allocations and has no knowledge
of credit/debit notes at all; (2) the claim that tax control accounts
are "first consumed" by this work item was wrong — `taxOutputAccountId`/
`taxInputAccountId` are already actively consumed by
`customer_invoices`/`supplier_bills` posting today (AR-1b/AP-1b); this
work item is a second consumer of an already-live mechanism, not the
first. Both corrections are folded into this revision below, along with
the minimal corresponding report changes and new historical/statement
acceptance tests this requires. **No implementation has occurred** —
this remains a proposal awaiting CTO review.

## 1. Executive summary

The next Finance work item should be **Customer Credit Notes (AR side)
and Supplier Debit Notes (AP side)** — a correction/adjustment document
type for POSTED customer invoices and supplier bills, built as two
symmetric subledger modules that post through the existing Journal
Engine exactly the way Customer Receipts (AR-1c) and Supplier Payments
(AP-1c) already do.

This closes the one structural gap left in an otherwise-complete AR/AP
invoice lifecycle: today a POSTED customer invoice or supplier bill is
permanently immutable with **no in-subledger way to reduce it** — no
returns, no pricing corrections, no disputed-amount write-downs, no
goodwill adjustments. The only workaround today would be a raw,
subledger-bypassing journal entry, which breaks the traceability the
rest of AP/AR carefully preserves. It also completes the "Credit/debit
notes" line item that `docs/roadmap.md` already lists, unchecked, under
Invoicing/Billing.

The design reuses the Customer Receipts / Supplier Payments allocation
pattern almost verbatim (same DRAFT→POSTED lifecycle, same
per-document-type number counter, same `SELECT ... FOR UPDATE`
concurrency model, same full-allocation-required-to-post policy, same
immutability/RLS/audit conventions), requires **zero changes to any
existing table's write path**, and does not touch General Ledger,
Financial Statements, or the Journal Engine itself. It adds 8 new
additive tables and 2 new sibling modules.

**§19's decision is resolved: Option A — reuse
`customer_invoices.paidMinor`/`paymentStatus` and
`supplier_bills.paidMinor`/`paymentStatus`.** This correctly means
current-mode Customer/Supplier Balance, AR/AP Ageing, and current-mode
AR/AP Reconciliation need no changes — they already read `paidMinor`
directly. It does **not** mean `ar-reports`/`ap-reports` are untouched
overall: historical as-of reconstruction (`asOfTotals`, used by
as-of-mode Balance, Statement opening balances, and as-of-mode
Reconciliation) rebuilds settlement from receipt/payment allocation
rows alone and must be extended to also include credit/debit-note
allocations, and Customer/Supplier Statement's transaction history must
gain explicit `CREDIT_NOTE`/`DEBIT_NOTE` rows so a credit/debit note
doesn't silently vanish from the statement's chronological record. Both
changes are additive (new query branches, one new `StatementLine.type`
value each) — no new tables, no changes to any _current-mode_ report
logic, and no changes to Trial Balance, General Ledger, or Financial
Statements. See §5, §9a, and §16 below for the corrected, minimal scope.

## 2. Current repository evidence

All of the following was confirmed by direct inspection of the
repository at `2f19e1f`, not carried forward from an earlier summary:

- `git log --oneline -5` confirms local `main` HEAD is `2f19e1f`,
  parent `91b9d47` (AR-1d). `git status --short` shows only the two
  pre-existing, out-of-scope hardening artifacts
  (`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md`,
  `docs/hardening/`) as modified/untracked — nothing else.
- `services/sphere-finance/src/db/schema.ts` (1295 lines):
  `customerInvoiceStatusEnum = ["DRAFT", "POSTED"]` and
  `supplierBillStatusEnum = ["DRAFT", "POSTED"]` — **no `VOID`,
  `CANCELLED`, or any correction-related status exists on either
  table.**
- A repository-wide case-insensitive grep for `credit.?note|debit.?note`
  across `services/sphere-finance` returns **zero matches** — the
  capability is completely unbuilt, not partially built.
- `customer-invoices.controller.ts` exposes only
  create/list/findOne/update/remove/post routes — no void, cancel,
  credit, or debit route of any kind.
- `ar_settings` already carries `arControlAccountId` (validated
  `ASSET`-typed at write time) and an **optional** `taxOutputAccountId`.
  `ap_settings` mirrors this exactly with `apControlAccountId`
  (validated `LIABILITY`) and optional `taxInputAccountId`.
- **Correction (CTO review round 1):** `CustomerInvoicesService.post()`
  **already** posts, today, whenever an invoice line carries a nonzero
  `taxAmountMinor`: **Dr** `arControlAccountId` (total) / **Cr** each
  line's `accountId` (subtotal per line) / **Cr** `taxOutputAccountId`
  (tax) — confirmed by direct inspection of the insert into
  `journalLines` in the already-shipped AR-1b implementation.
  `SupplierBillsService.post()` mirrors this in the opposite direction
  and is equally already-live (AP-1b). **These tax control accounts are
  therefore already actively consumed today, not first used by this
  work item** — the original submission's framing of this as "the first
  real consumer" was inaccurate and is corrected here. This work item's
  credit/debit-note posting is a **second, independent consumer** of the
  same already-proven mechanism, using the identical
  `taxOutputAccountId`/`taxInputAccountId` fields and the identical
  "reject if nonzero tax but account unconfigured" validation
  `customer_invoices`/`supplier_bills` posting already enforces.
- `ArReportsService.asOfTotals()` / `ApReportsService.asOfTotals()`
  (the historical/as-of reconstruction used by as-of-mode Customer/
  Supplier Balance, Statement opening balances, and as-of-mode AR/AP
  Reconciliation) compute `totalReceivedMinor`/`totalPaidMinor` **purely
  from a join across `customer_receipt_allocations` →
  `customer_receipts` → `customer_invoices`** (mirrored on the AP side),
  filtered by `receipt_date`/`payment_date` against the cutoff —
  confirmed by direct inspection. This query has **no knowledge of
  `paidMinor` at all** and, as written, would have no knowledge of
  credit/debit-note allocations either — this is the gap the CTO
  identified. By contrast, `currentTotals()` (current-mode Balance/
  Reconciliation) and `getArAgeing()`/`getApAgeing()` read
  `customer_invoices.paidMinor`/`supplier_bills.paidMinor` directly, so
  those three report paths are correctly, automatically fixed by Option
  A with **zero code changes** — confirmed by direct inspection of both
  methods.
- `ArReportsService.getCustomerStatement()` /
  `ApReportsService.getSupplierStatement()` build their chronological
  transaction history from exactly two hardcoded row types —
  `StatementLine.type: "INVOICE" | "RECEIPT"` (AR) and
  `"BILL" | "PAYMENT"` (AP) — confirmed by direct inspection. A posted,
  allocated credit/debit note has no corresponding row type today and
  would not appear in a statement at all, even though it changes the
  customer's/supplier's balance — confirmed gap, not assumed.
- `CustomerReceiptsService` / `SupplierPaymentsService` (AR-1c/AP-1c)
  are a complete, proven structural template: DRAFT→POSTED lifecycle;
  a dedicated document-number counter table separate from the invoice
  number counter but drawing journal numbers from the **shared**
  journal-number sequence; allocations validated under
  `SELECT ... FOR UPDATE` locks (header row, every allocated invoice
  row, the accounting period row — locked in ascending-id order);
  **full-allocation-required-to-post** — `CustomerReceiptsService.post()`
  explicitly rejects (422) if `Σ allocations.allocatedAmountMinor !==
receiptAmountMinor`, with the code comment _"no 'receipt on account'
  in this Work Item"_; a per-table Postgres immutability trigger; an
  `audit_logs` write (`action: "CREATE"` / `"POST"` etc.,
  `beforeState`/`afterState`) inside the same transaction as the
  mutating write.
- `customerReceiptAllocations` increments the target invoice's
  `paidMinor` and recomputes `paymentStatus`
  (`UNPAID`/`PARTIALLY_PAID`/`PAID`) — the exact mechanism AR/AP
  ageing, statements, and balance reports already read.
- `drizzle/constraints/*.sql` (immutability triggers) is numbered
  001–012, latest `012_customer_receipt_allocations_immutability_trigger.sql`.
  `drizzle/rls/*.sql` is numbered up to `007_ar_invoices_rls.sql`.
  `drizzle/migrations/` runs `0000`–`0010`; the next migration is `0011`.
- `route-role-matrix.spec.ts` currently discovers **66 routes across 15
  controllers**, reflecting `2f19e1f`'s Financial Statements addition.
- The AP reports module's "reconciliation" endpoint
  (`GET /ap/reconciliation`) is an **AP-subledger-vs-GL** balance check,
  not bank reconciliation. Both `supplierPayments.bankCashAccountId` and
  `customerReceipts.bankCashAccountId` are, per their own code comments,
  _"Manually-selected GL cash/bank account ... No real bank-account
  entity yet"_ — Banking/Cash Management remains genuinely,
  structurally absent (confirms the Phase 1 reassessment's finding still
  holds at this HEAD).
- `docs/roadmap.md`'s locked capability tree lists, under **Invoicing /
  Billing**: `[ ] Customer invoicing, [ ] Supplier billing, [ ]
Credit/debit notes, [ ] Invoice lifecycle, [ ] Invoice-to-accounting
integration` — all unchecked. Customer invoicing, supplier billing,
  and invoice-to-accounting integration are in fact already built
  (pre-existing, already-reported documentation drift, not corrected
  here per standing instruction). **Credit/debit notes specifically is
  the one sub-item with genuinely zero corresponding code**, confirmed
  by the grep above — the roadmap and the code agree on this one.
- `docs/architecture.md` and the tenancy/RLS/RBAC conventions it
  describes (two-hierarchy tenant/legal-entity model, DB-enforced RLS
  for tenant only, `withTenant()`) apply unchanged; nothing in this
  proposal needs a new trust boundary or identity tier.

## 3. Why this is the next work item

Weighed against the eight stated criteria:

1. **Business value** — high. A POSTED invoice/bill today is a dead
   end for correction. Returns, pricing disputes, and goodwill
   adjustments are routine in any real AP/AR operation; without this,
   the only way to reduce a posted balance is a subledger-bypassing raw
   journal entry, which silently breaks AR/AP-to-GL traceability.
2. **Dependency readiness** — complete. Everything this needs already
   exists: Chart of Accounts, Journal Engine, Accounting Periods,
   Customer Invoices/Supplier Bills, and — critically — the exact
   allocation pattern (Customer Receipts/Supplier Payments) to clone.
3. **Accounting correctness** — well-understood, low-novelty double
   entry (a credit note is the mirror image of the invoice it
   corrects). No new accounting theory is introduced.
4. **Reuse of existing architecture** — very high. This is close to a
   structural clone of AR-1c/AP-1c, not a new pattern.
5. **Unlocks other capabilities** — moderate. It's a prerequisite for
   any future "returns" or "disputes" workflow, and for AR/AP ageing
   and statements to ever reflect real-world corrections.
6. **Required master data already exists** — yes. No new master data
   (no bank accounts, no tax codes, no asset categories) is needed;
   customers/suppliers/chart-of-accounts/settings are all already in
   place.
7. **Risk of incorrect accounting semantics** — low, because the
   design is a direct structural mirror of an already-implemented,
   already-tested pattern (AR-1c/AP-1c), not a novel one.
8. **Can be implemented cleanly without prematurely solving unrelated
   future problems** — yes. It does not require deciding Tax/VAT
   architecture (reuses the existing optional flat-tax-amount
   convention), does not require Banking/Cash Management, and does not
   touch Financial Statements or General Ledger.

### Alternatives considered

- **Banking & Cash Management** — genuinely absent, but requires new
  master data (a real bank-account entity), new transaction concepts
  (statement import, matching), and materially more design ambiguity
  (file formats, reconciliation rules). Larger, riskier, and not
  blocking anything else currently planned.
- **WIP / Accrual Engine** — explicitly the one item repeatedly named
  in the roadmap's prior version as remaining Phase 1 scope, but its
  natural trigger (project/job costing, service delivery timing) isn't
  in the repository yet (no Projects module). Building it now risks
  guessing at recognition rules the business hasn't specified.
  Deferred as premature per criterion 8.
- **Tax / VAT** — the repository already has a deliberately minimal,
  flat-amount tax mechanism (`taxAmountMinor` per line +
  `taxOutputAccountId`/`taxInputAccountId`). A real Tax/VAT capability
  (tax codes, rates, jurisdiction rules, tax reporting) is a
  significantly larger, jurisdiction-dependent design the repository
  gives no signal about yet — out of scope for now, consistent with the
  roadmap's own "jurisdiction-dependent, out of scope for this
  increment" language already in `ap_settings`/`ar_settings`.
- **Fixed Assets, Budgeting, Multi-Currency, Cash Flow Statement,
  Management/Consolidated Reporting** — each requires new master data
  or was explicitly deferred by prior CTO decision (Cash Flow, Phase
  2/3 of the Financial Statements work). Lower business value right now
  than closing the AR/AP correction gap.
- **Scoping AR Credit Notes and AP Debit Notes as two separate work
  items** (matching the AP-1c / AR-1c precedent of one domain per work
  item) was considered and rejected in favor of combining them, for the
  same reason Financial Statements combined P&L and Balance Sheet: the
  roadmap's own "Credit/debit notes" line groups them as one capability,
  they are exact structural mirrors of each other, and the marginal
  cost of doing both together (vs. one now and one as an near-identical
  follow-up) is close to zero.

## 4. Business purpose

Give Finance a proper, auditable way to reduce a customer's receivable
or a supplier's payable after the originating invoice/bill has been
posted — for returns, pricing corrections, disputed-amount write-downs,
and goodwill adjustments — without bypassing the AP/AR subledger the
way a raw journal entry would. Each credit/debit note is traceable to
the specific invoice(s)/bill(s) it corrects via the same allocation
mechanism receipts/payments already use for settlement.

## 5. Exact scope

- New AR module: `services/sphere-finance/src/accounts-receivable/customer-credit-notes/`
  (`dto/`, `.service.ts`, `.controller.ts`, `.module.ts`) — structural
  clone of `accounts-receivable/customer-receipts/`.
- New AP module: `services/sphere-finance/src/accounts-payable/supplier-debit-notes/`
  — structural clone of `accounts-payable/supplier-payments/`.
- Full DRAFT lifecycle (create/list/get/update/delete) + `POST :id/post`
  for both.
- Allocation of a credit/debit note's total against one or more POSTED
  invoices/bills of the **same** customer/supplier and legal entity,
  full-allocation-required-to-post (mirrors AR-1c/AP-1c exactly).
- New dedicated number counters
  (`customerCreditNoteNumberCounters`, `supplierDebitNoteNumberCounters`),
  journal numbers drawn from the existing shared sequence.
- New RLS policy files, new immutability trigger files, one new
  migration (`0011_...`) — all additive.
- Wiring into `app.module.ts` and `route-role-matrix.spec.ts`.
- **Minimal, additive changes inside `ar-reports.service.ts` and
  `ap-reports.service.ts`** (corrected scope, CTO review round 1 — see
  §9a for the exact change):
  - Extend `asOfTotals()` (both files) to also sum credit/debit-note
    allocations dated on-or-before the cutoff, alongside the existing
    receipt/payment allocation sum.
  - Extend `getCustomerStatement()`/`getSupplierStatement()` to add a
    `"CREDIT_NOTE"`/`"DEBIT_NOTE"` row type alongside the existing
    `INVOICE`/`RECEIPT` (`BILL`/`PAYMENT`) rows, sourced from POSTED
    credit/debit notes and their allocations.
  - `currentTotals()`, `getArAgeing()`, and `getApAgeing()` require
    **no changes** — they already read `paidMinor` directly, which
    Option A causes to reflect credit/debit notes automatically.
- Unit tests (DTO specs) + two new e2e spec files covering the full
  acceptance matrix in §16, plus new historical-as-of and statement
  test cases inside the _existing_ `ar-reports`/`ap-reports` e2e specs
  (§16).

## 6. Explicit exclusions

- **No changes to `customer_invoices` or `supplier_bills` schema, or
  to `CustomerInvoicesService`/`SupplierBillsService`'s posting logic.**
  Credit/debit notes are a new, separate document type that references
  existing invoices/bills by id — they do not alter how invoices/bills
  are created or posted.
- **No `VOID`/`CANCEL` status added to invoices or bills.** A full
  invoice/bill reversal is a related but distinct future capability;
  this work item is the correction mechanism (a new, separate document
  that reduces an outstanding balance), not a void mechanism.
- **Corrected (CTO review round 1) — this is narrower than "no changes
  to `ar-reports`/`ap-reports`," which was inaccurate.** Ageing and
  current-mode Balance/Reconciliation need no changes (they already
  read `paidMinor`, per §2/§9a). Historical as-of reconstruction
  (`asOfTotals`) and Customer/Supplier Statement's row listing **do**
  need the minimal, additive changes specified in §5/§9a — these are
  in scope for this work item, not deferred. What remains explicitly
  **excluded**: no changes to the _current-mode_ query paths, no new
  report endpoints, no changes to AR/AP Ageing bucketing logic, and no
  changes to Trial Balance, General Ledger, or Financial Statements.
- **No General Ledger, Financial Statements, or Journal Engine code
  changes.** Credit/debit notes post through the existing
  `journal_entries`/`journal_lines` tables using the same account-type
  conventions those read layers already understand generically; no
  reporting code needs to know a credit/debit note exists.
- **No Tax/VAT master data, tax codes, or tax rate configuration.**
  Reuses the existing flat per-line `taxAmountMinor` +
  `taxOutputAccountId`/`taxInputAccountId` convention verbatim.
- **No Banking/Cash Management.** `bankCashAccountId`-style real bank
  accounts remain out of scope; nothing in this work item requires them.

## 7. Existing modules/services to reuse

- `CustomerReceiptsService` / `SupplierPaymentsService` as direct
  file-for-file structural templates: create/update/delete/post,
  allocation validation, `SELECT ... FOR UPDATE` locking order, number
  counter allocation, draft-then-post journal entry insertion sequence,
  audit logging.
- `AccountingPeriodsService`'s `resolveAndLockOpenPeriod` query/lock
  shape — duplicated per this codebase's established
  duplication-over-coupling convention (same as every AP-1d/AR-1d
  precedent), not imported.
- `ar_settings.arControlAccountId`/`taxOutputAccountId` and
  `ap_settings.apControlAccountId`/`taxInputAccountId` — already exist,
  unchanged, and are **already actively consumed today** by
  `customer_invoices`/`supplier_bills` posting whenever a line carries
  tax (AR-1b/AP-1b, corrected per §2 — not a dormant reservation this
  work item activates for the first time). Credit/debit-note posting
  becomes a second, independent consumer of the identical mechanism and
  identical validation.
- `ArReportsService`/`ApReportsService`'s existing `asOfTotals()` and
  `getCustomerStatement()`/`getSupplierStatement()` — extended, not
  replaced (§9a); `currentTotals()`/`getArAgeing()`/`getApAgeing()`
  reused completely unchanged.
- `journalNumberCounters` (shared sequence) plus new
  `customerCreditNoteNumberCounters`/`supplierDebitNoteNumberCounters`
  mirroring `arReceiptNumberCounters`/`apPaymentNumberCounters` exactly.
- `audit_logs` table and write pattern — unchanged.
- RLS convention (`withTenant()`, explicit `legalEntityId` predicate in
  every query) — unchanged.
- `route-role-matrix.spec.ts`'s live-reflection `discoverRoutes()` —
  unchanged mechanism, two more controllers registered.

## 8. Proposed schema changes

All additive. No `ALTER` on any existing table (contingent on §19
resolving to reuse `paidMinor`/`paymentStatus` — see that section for
the alternative).

### `customer_credit_notes`

| Column                                    | Type                                                  | Notes                                                                                            |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                                      | uuid PK                                               | `defaultRandom()`                                                                                |
| `tenant_id`                               | uuid NOT NULL                                         | RLS                                                                                              |
| `legal_entity_id`                         | uuid NOT NULL                                         | explicit predicate, not RLS-enforced                                                             |
| `customer_id`                             | uuid NOT NULL                                         | FK → `customers.id`                                                                              |
| `internal_reference`                      | varchar(20)                                           | null while DRAFT, assigned at POST via the new counter, immutable after                          |
| `status`                                  | `customer_credit_note_status` enum (`DRAFT`,`POSTED`) | default `DRAFT`                                                                                  |
| `credit_note_date`                        | date NOT NULL                                         | client-supplied                                                                                  |
| `currency_code`                           | varchar(3) NOT NULL                                   | resolved from legal entity, never client-supplied — identical to `customerInvoices.currencyCode` |
| `subtotal_minor`                          | bigint NOT NULL                                       | server-computed: `Σ line.amountMinor`                                                            |
| `tax_minor`                               | bigint NOT NULL default 0                             | server-computed: `Σ line.taxAmountMinor`                                                         |
| `total_minor`                             | bigint NOT NULL                                       | server-computed: `subtotal_minor + tax_minor`                                                    |
| `reason`                                  | varchar(500)                                          | optional free text (e.g. "Return", "Pricing correction")                                         |
| `memo`                                    | varchar(2000)                                         | optional                                                                                         |
| `journal_entry_id`                        | uuid                                                  | null until POST, FK → `journal_entries.id`                                                       |
| `accounting_period_id`                    | uuid                                                  | null until POST, FK → `accounting_periods.id`                                                    |
| `created_by` / `posted_by`                | uuid                                                  | nullable                                                                                         |
| `created_at` / `updated_at` / `posted_at` | timestamptz                                           |                                                                                                  |

Constraints: `UNIQUE (tenant_id, internal_reference)` where
`internal_reference IS NOT NULL` (mirrors `customer_invoices`' own
uniqueness constraint). Indexes: `(tenant_id, legal_entity_id,
customer_id)`, `(tenant_id, legal_entity_id, status)`. FKs:
`customer_id → customers.id`, `journal_entry_id → journal_entries.id`,
`accounting_period_id → accounting_periods.id`. RLS: tenant-only, new
file in `drizzle/rls/` (next number after `007_ar_invoices_rls.sql`).
Immutability: POSTED rows immutable except the status-transition
fields themselves, mirroring
`009_customer_invoices_immutability_trigger.sql` — new trigger file in
`drizzle/constraints/` (next number after `012`).

### `customer_credit_note_lines`

`id` uuid PK, `tenant_id` uuid NOT NULL (denormalized for RLS),
`credit_note_id` uuid NOT NULL FK → `customer_credit_notes.id` (cascade
delete, DRAFT-only enforced in service), `line_number` int NOT NULL,
`account_id` uuid NOT NULL FK → `chart_of_accounts.id` (validated
ACTIVE at write time, identical to invoice line validation — no
enforced "must be contra-revenue" type constraint, matching invoice
lines' own looseness), `description` varchar(500) optional,
`amount_minor` bigint NOT NULL `> 0`, `tax_amount_minor` bigint NOT
NULL default 0 `>= 0`. Immutability trigger mirrors
`010_customer_invoice_lines_immutability_trigger.sql`.

### `customer_credit_note_allocations`

`id` uuid PK, `tenant_id` uuid NOT NULL, `credit_note_id` uuid NOT NULL
FK → `customer_credit_notes.id` (cascade delete), `invoice_id` uuid NOT
NULL FK → `customer_invoices.id` (no cascade — a POSTED invoice is
never deleted, identical reasoning to `customerReceiptAllocations`),
`allocated_amount_minor` bigint NOT NULL `> 0`, `created_at`
timestamptz. `UNIQUE (credit_note_id, invoice_id)` — mirrors
`customer_receipt_allocations_receipt_invoice_unique`. Immutability
trigger mirrors
`012_customer_receipt_allocations_immutability_trigger.sql`.

### `customer_credit_note_number_counters`

Mirrors `ar_receipt_number_counters` exactly: `(tenant_id,
legal_entity_id)` composite key, `next_number` int.

### AP mirror tables

`supplier_debit_notes`, `supplier_debit_note_lines`,
`supplier_debit_note_allocations`, `supplier_debit_note_number_counters`
— an exact structural mirror of the four AR tables above, with
`customer_id → supplier_id` (FK → `suppliers.id`), `invoice_id →
bill_id` (FK → `supplier_bills.id`), and line `account_id` validated
the same way (no enforced "must be contra-expense" type constraint).

### Migration

One new Drizzle migration (`0011_...`, name generated by
`drizzle-kit generate`) containing all 8 new tables and the 2 new
status enums. Purely additive — no `ALTER TABLE` on any existing table.

## 9. Accounting model and journal-entry behaviour

### Customer Credit Note — POST

- **Dr** each credit-note line's `account_id`, `amount_minor` (per
  line) — reduces revenue (or a contra-revenue account, if the tenant's
  Chart of Accounts has one; the line's account is caller-selected, not
  hardcoded, matching invoice lines' own convention)
- **Dr** `ar_settings.taxOutputAccountId`, `tax_minor` (only if
  `tax_minor > 0`; if nonzero and `taxOutputAccountId` is unconfigured,
  posting fails with the same validation error `customer_invoices`
  posting already raises) — reduces output-tax liability
- **Cr** `ar_settings.arControlAccountId`, `total_minor` — reduces the
  AR asset

Amount basis: `subtotal_minor = Σ line.amount_minor`, `tax_minor = Σ
line.tax_amount_minor`, `total_minor = subtotal_minor + tax_minor` —
identical derivation to `customer_invoices`. Transaction date:
`credit_note_date` (client-supplied, must fall inside an OPEN
accounting period at POST time). Accounting period: resolved via a
duplicated `resolveAndLockOpenPeriod(creditNoteDate)`, identical
pattern to every existing posting method. Journal entry behaviour: a
DRAFT journal entry is inserted first, its lines inserted, then the
entry is flipped to POSTED in a separate `UPDATE` — the same sequence
`CustomerReceiptsService.post()` uses to work around the
`journal_lines_immutable` trigger. Failure/rollback: the entire
`post()` call runs inside one DB transaction; any validation failure
(an allocated invoice not POSTED, wrong customer, allocation exceeding
outstanding balance, unconfigured tax account, period closed or not
found, allocation total ≠ credit note total) throws before any write
commits, and the transaction rolls back atomically — identical
behaviour to every existing POSTED-transition method in this codebase.

### Supplier Debit Note — POST (exact mirror)

- **Dr** `ap_settings.apControlAccountId`, `total_minor` — reduces the
  AP liability
- **Cr** each debit-note line's `account_id`, `amount_minor` (per
  line) — reduces expense
- **Cr** `ap_settings.taxInputAccountId`, `tax_minor` (only if
  `tax_minor > 0`) — reduces input-tax asset/recoverable

Same transaction-date, accounting-period, journal-entry-sequencing, and
failure/rollback behaviour as the AR side.

### Allocation behaviour (both sides)

At POST time, for each allocation row: lock the target invoice/bill
`FOR UPDATE`, verify `status = POSTED`, verify it belongs to the same
customer/supplier and legal entity as the credit/debit note, verify
`allocated_amount_minor <= (total_minor - paid_minor)` on the target,
then increment the target's `paid_minor` by `allocated_amount_minor`
and recompute `payment_status`
(`UNPAID`/`PARTIALLY_PAID`/`PAID`) — reusing the exact same
outstanding-balance/payment-status computation
`CustomerReceiptsService`/`SupplierPaymentsService` already use.
**This reuse is §19's open decision, not assumed silently.**

Full-allocation-required-to-post: `Σ allocations.allocated_amount_minor`
must equal `total_minor`, else the POST request is rejected (422) —
identical policy to AR-1c/AP-1c ("no receipt/payment on account"), not
a new decision this work item is introducing.

## 9a. Corrected reporting integration (CTO review round 1)

This section is new in this revision — it did not exist in the original
submission, which incorrectly claimed no `ar-reports`/`ap-reports`
changes were needed. Both changes below are additive query-logic
changes only; neither adds a table, a column, or a new report endpoint.

### 9a.1 — `asOfTotals()` (both `ar-reports.service.ts` and

`ap-reports.service.ts`)

Today this method's `total_received`/`total_paid` subquery sums only
`customer_receipt_allocations`/`supplier_payment_allocations` rows
dated on-or-before the cutoff. It must gain a second summed subquery,
unioned into the same total, over
`customer_credit_note_allocations`/`supplier_debit_note_allocations`
joined to `customer_credit_notes`/`supplier_debit_notes` and
`customer_invoices`/`supplier_bills`, applying the identical predicate
shape already used for receipts/payments: the credit/debit note's own
`status = 'POSTED'` and `credit_note_date`/`debit_note_date <=/<
cutoffDate` (same `strict` flag semantics as the existing receipt/
payment predicate — `<=` for Balance/Reconciliation as-of mode, `<` for
Statement's opening-balance mode), plus the same tenant/legal-entity/
optional-customer-or-supplier filters already applied to the
receipt/payment subquery. `total_received = Σ(receipt allocations
matching cutoff) + Σ(credit-note allocations matching cutoff)` — same
structure for the AP side with payments and debit notes. This exactly
mirrors the additive-union shape, not a rewrite of the existing
subquery.

### 9a.2 — `getCustomerStatement()` / `getSupplierStatement()`

`StatementLine.type` gains one new literal value:
`"INVOICE" | "RECEIPT" | "CREDIT_NOTE"` (AR) and
`"BILL" | "PAYMENT" | "DEBIT_NOTE"` (AP). A new query block, structured
identically to the existing RECEIPT/PAYMENT block, loads POSTED credit/
debit notes for this customer/supplier dated within
`[dateFrom, dateTo]`, joins their allocations (for the `allocations:
StatementAllocation[]` field, reusing that existing interface
unchanged), and contributes one `StatementLine` per credit/debit note
with `amountMinor` signed the same direction as a receipt/payment
(negative — it reduces the customer's/supplier's balance), `reference`
= the credit/debit note's own `internalReference`, and `description` =
its `reason` field (falling back to a generic label, mirroring
RECEIPT's `memo ?? reference ?? "Receipt"` fallback chain). The new
rows are merged into the same chronological `unsorted` array and sorted
by the same `(date, reference)` tie-break already used for every other
row type — no new sort logic. `openingBalanceMinor` is computed by the
same `asOfTotals(..., strict: true)` call already used today, which
picks up the §9a.1 change automatically — no separate opening-balance
logic for credit/debit notes is needed.

### 9a.3 — What needs no change, and why

- `currentTotals()` (current-mode Balance/Reconciliation): sums
  `customer_invoices.paidMinor`/`supplier_bills.paidMinor` directly.
  Once credit/debit-note allocations write to `paidMinor` (§9, Option
  A), this method reflects them with no code change.
- `getArAgeing()`/`getApAgeing()`: reads `invoice.paidMinor`/
  `bill.paidMinor` directly for its outstanding calculation — same
  reasoning, no code change.
- Trial Balance, General Ledger, and Financial Statements: all compute
  purely from `journal_entries`/`journal_lines` by account type: they
  already correctly reflect any POSTED journal entry regardless of
  which subledger document produced it, so credit/debit-note postings
  are correctly included with zero code change, exactly as every prior
  AP-1c/AR-1c posting already proved for receipts/payments.

## 10. Transaction boundaries and concurrency rules

- One DB transaction per `post()` call, default (`READ COMMITTED`)
  isolation — the same as `CustomerReceiptsService`/
  `SupplierPaymentsService`. **Not** `REPORT_TX_CONFIG`'s
  `REPEATABLE READ`/read-only mode, which is reserved for pure-read
  report endpoints (Trial Balance, GL reports, Financial Statements);
  this is a write-path work item.
- `SELECT ... FOR UPDATE` on: the credit/debit-note header row itself,
  every allocated invoice/bill row (locked in ascending-id order to
  avoid deadlock, identical to `CustomerReceiptsService.post()`), and
  the accounting period row via `resolveAndLockOpenPeriod`.
- Atomic document-number allocation via the new dedicated counter
  table's own `UPDATE ... RETURNING`, identical pattern to
  `allocateReceiptNumber`/`allocateJournalNumber`.
- No new isolation level and no new locking primitive are introduced —
  this intentionally reuses the exact concurrency model already proven
  correct (and adversarially tested) for receipts and payments.

## 11. Tenant/legal-entity/RLS model

Every new table carries `tenant_id` (RLS-enforced, tenant-only policy)
and `legal_entity_id` (explicit predicate required in every query, not
covered by RLS — the same standing convention documented at the top of
`schema.ts` and applied to every existing Finance table).
`requireTenantContext(user, ...)` resolves both from the verified JWT
only, never from request params or body, identical to every existing
controller. New RLS SQL files are added under
`services/sphere-finance/drizzle/rls/`, same shape as
`006_ar_rls.sql`/`007_ar_invoices_rls.sql`.

## 12. RBAC and route-role requirements

Mirrors `CustomerReceiptsController`/`SupplierPaymentsController`
exactly:

| Route                                                                                                      | Roles                                               | Notes               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| `GET /credit-notes`, `GET /credit-notes/:id`                                                               | `finance.viewer`, `finance.poster`, `finance.admin` | read                |
| `POST /credit-notes`, `PATCH /credit-notes/:id`, `DELETE /credit-notes/:id`, `POST /credit-notes/:id/post` | `finance.poster` only                               | write/transactional |

Same table for `/debit-notes`. Unauthenticated → 401 on every route;
`finance.viewer` alone → 403 on every write route.
`route-role-matrix.spec.ts` gains two new controllers
(`CustomerCreditNotesController`, `SupplierDebitNotesController`), each
exposing 6 routes (create/list/findOne/update/remove/post) — final
route/controller counts to be computed once implementation fixes the
exact route list, not fabricated here.

## 13. API design

### AR — `CustomerCreditNotesController`

- `POST /credit-notes` — `finance.poster` — body
  `CreateCustomerCreditNoteDto` — 201, returns the created
  credit note with its lines and allocations — validates `customerId`
  resolves to an ACTIVE customer in scope, `lines` `ArrayMinSize(1)`,
  `allocations` `ArrayMinSize(1)` — `tenantId`/`legalEntityId` from JWT.
- `GET /credit-notes` — `finance.viewer/poster/admin` — optional query
  `status`/`customerId`/`dateFrom`/`dateTo` — 200 list, scoped to
  tenant + legal entity.
- `GET /credit-notes/:id` — same roles — 200 or 404 (cross-tenant/
  cross-legal-entity access always 404, never 403, matching existing
  convention).
- `PATCH /credit-notes/:id` — `finance.poster` — body
  `UpdateCustomerCreditNoteDto` — DRAFT-only, 200, 422 if not DRAFT.
- `DELETE /credit-notes/:id` — `finance.poster` — DRAFT-only, 200.
- `POST /credit-notes/:id/post` — `finance.poster` — `@HttpCode(200)`
  (transitions an existing resource, not `@Post()`'s default 201,
  matching `SupplierPaymentsController.post()`'s own reasoning) — 200,
  transitions DRAFT→POSTED per §9/§10.

### AP — `SupplierDebitNotesController`

Exact mirror at `/debit-notes`.

## 14. DTO validation

`CreateCustomerCreditNoteDto`: `customerId` (`@IsUUID`, resolved
against an ACTIVE customer in scope), `creditNoteDate`
(`@IsDateString`), `reason`/`memo` (optional, `@MaxLength`), `lines`
(`@IsArray @ArrayMinSize(1) @ValidateNested({each:true})` of
`CreateCustomerCreditNoteLineDto`: `accountId` UUID, `description`
optional, `amountMinor` `@IsInt @Min(1)`, `taxAmountMinor` optional
`@IsInt @Min(0)`), `allocations` (`@IsArray @ArrayMinSize(1)
@ValidateNested({each:true})` of
`CreateCustomerCreditNoteAllocationDto`: `invoiceId` UUID,
`allocatedAmountMinor` `@IsInt @Min(1)`). `currencyCode` / `status` /
`internalReference` / `journalEntryId` / `accountingPeriodId` are
deliberately absent — all server-resolved, identical convention to
every existing create DTO in this codebase. `UpdateCustomerCreditNoteDto`
mirrors the create DTO with every field optional; DRAFT-only enforced
in the service, not the DTO. AP `Create/UpdateSupplierDebitNoteDto` and
its nested line/allocation DTOs are an exact mirror.

## 15. Audit requirements

Identical to receipts/payments: `tx.insert(auditLogs)` inside the same
transaction as the mutating write, on `CREATE`, `UPDATE`, `DELETE`, and
`POST` actions, `entityType: "customer_credit_note"` (and
`"supplier_debit_note"` on the AP side), `entityId`, `actorUserId` from
the JWT, `beforeState`/`afterState` full-row snapshots — no new audit
infrastructure, no new audit event taxonomy.

## 16. Test strategy and complete e2e acceptance matrix

**Unit:** DTO validation specs for both new create/update DTOs and
their nested line/allocation DTOs, mirroring the existing
`*.dto.spec.ts` shape used throughout AR-1c/AP-1c.

**e2e:** two new spec files,
`customer-credit-notes.e2e-spec.ts` and
`supplier-debit-notes.e2e-spec.ts`, mirroring
`customer-receipts.e2e-spec.ts`/`supplier-payments.e2e-spec.ts` in
harness shape. Acceptance matrix (both sides, symmetric):

- Auth matrix per route: unauthenticated → 401; `finance.viewer` on a
  write route → 403; all three finance roles → 200 on read routes.
- Happy path: create DRAFT with lines + allocations → post → verify
  the journal entry's Dr/Cr amounts (via direct GL/journal query) match
  §9's derivation exactly → verify the allocated invoice's/bill's
  `paidMinor`/`paymentStatus` updated correctly.
- Over-allocation rejected (422): allocation exceeds an invoice's/
  bill's outstanding balance.
- Allocation against a non-POSTED (still-DRAFT) invoice/bill rejected.
- Allocation against an invoice/bill belonging to a different customer/
  supplier rejected.
- Partial allocation split across two invoices/bills in one credit/
  debit note.
- Full-allocation-required-to-post: total allocated ≠ credit/debit note
  total → 422.
- Tax handling: nonzero `taxAmountMinor` with an unconfigured
  `taxOutputAccountId`/`taxInputAccountId` → rejected, mirroring
  invoice/bill posting's existing validation.
- DRAFT-only edit/delete enforcement (422 once POSTED).
- Cross-tenant / cross-legal-entity access → 404, never a data leak.
- Posting against a CLOSED accounting period → rejected, matching
  existing period-closure enforcement.
- Immutability: a POSTED row's mutation attempt at the DB layer is
  rejected by the new trigger (extends the existing
  `journal-engine-db-constraints.e2e-spec.ts`-style coverage, or adds a
  parallel spec for the new tables).
- **Independent PostgreSQL verification** (post-implementation, same
  raw-SQL-against-e2e-fixture-data technique used for Financial
  Statements): confirm the exact Dr/Cr postings and AR/AP control
  account balance movements match the API's own reported totals, and
  that Trial Balance / General Ledger continue to reconcile after
  credit/debit notes are posted.

**New — historical as-of and statement acceptance tests (CTO review
round 1), added to the _existing_ `ar-reports`/`ap-reports` e2e specs,
not the two new module specs above:**

- **Historical as-of Customer/Supplier Balance**: post an invoice, post
  a credit note dated after the invoice and allocate it, then query
  Customer Balance with `asOf` set (a) before the credit note's date
  (must exclude it — `totalOutstandingMinor` unaffected) and (b) on or
  after it (must include it — `totalOutstandingMinor` reduced by the
  allocated amount). Mirrored for Supplier Balance/debit notes.
- **Current-mode Balance/Reconciliation reflects credit/debit notes
  with no `asOf`**: same fixture, current-mode (no `asOf`) query
  reflects the reduced outstanding balance immediately post-allocation
  — proves the `paidMinor` fast path (Option A) works with zero report
  code changes for this mode.
- **As-of AR/AP Reconciliation stays reconciled**: post a credit/debit
  note and allocate it, then confirm as-of-mode `/ar/reconciliation`
  (`/ap/reconciliation`) still reports `differenceMinor: 0` both before
  and after the credit/debit note's date — proves §9a.1's extended
  `asOfTotals()` and the GL-side balance (which already includes the
  credit/debit note's own journal entry) move together.
- **Customer/Supplier Statement shows an explicit `CREDIT_NOTE`/
  `DEBIT_NOTE` row**: statement over a date range containing a posted,
  allocated credit/debit note shows a row with `type: "CREDIT_NOTE"`
  (`"DEBIT_NOTE"`), correct sign, correct `reference`/`description`,
  correct `allocations[]`, and a `runningBalanceMinor` that correctly
  reflects it in chronological order alongside invoice/receipt
  (bill/payment) rows.
- **Statement opening balance reflects a credit/debit note dated before
  the window**: a credit/debit note dated strictly before `dateFrom`
  and allocated is reflected in `openingBalanceMinor` (via §9a.1's
  `strict: true` opening-balance call) without appearing as its own row
  inside the statement's date-windowed body.
- **Zero regression**: every pre-existing `ar-reports`/`ap-reports` e2e
  case (Balance, Statement, Ageing, Reconciliation — current and
  as-of, with no credit/debit notes involved) remains green and
  unmodified, proving the additive query changes don't alter any
  existing result.

## 17. Migration/backward-compatibility considerations

Schema-wise, purely additive: 8 new tables, 2 new enums, **zero**
`ALTER` on any existing table — per §19's now-resolved Option A. No
data backfill is needed (there are no pre-existing credit/debit notes
to migrate). Every existing invoice/bill/receipt/payment write path is
completely unaffected. The `ar-reports`/`ap-reports` changes in §9a are
source-code-only (no migration, no schema impact) and are purely
additive at the query level — every existing query branch
(`currentTotals`, Ageing, the INVOICE/RECEIPT and BILL/PAYMENT rows in
Statement) is unchanged; only new branches/row types are added, and the
new e2e regression tests in §16 exist specifically to prove this.

## 18. Risks and edge cases

- **§19's semantic reuse of `paidMinor` (resolved: Option A).**
  `paidMinor` broadens from "cash paid" to "cash paid or credited" — a
  real semantic shift on an existing column, even though its schema is
  unchanged. Mitigated by documenting the broadened meaning clearly in
  code, exactly as this proposal does.
- **Historical/as-of reporting requires the §9a changes, not zero
  changes.** This was the original submission's inaccuracy, now
  corrected: `asOfTotals()` and Statement's row listing must be
  extended (§9a) or historical Balance/Reconciliation/Statement would
  silently under-report settlement and Statement would silently omit
  credit/debit notes from transaction history entirely. §16's new test
  cases exist specifically to prove this gap is closed, not merely
  documented.
- **Statement row ordering for same-day documents.** A credit/debit
  note dated the same day as an invoice/receipt (bill/payment) sorts by
  the existing `(date, reference)` tie-break (§9a.2) — internal
  reference prefixes (`INV-`/`RCT-`/the new credit/debit note series)
  never collide, so this requires no new tie-break logic, but is worth
  an explicit e2e case (§16) since it's a new three-way interleaving
  that didn't exist before.
- **No enforced account-type constraint on credit/debit-note lines.**
  A line's `accountId` can be any ACTIVE account of any type, not
  provably a contra-revenue/contra-expense account — this mirrors
  invoice/bill lines' own existing looseness exactly, not a new gap
  this work item introduces.
- **No VOID/CANCEL of a POSTED credit/debit note itself.** Once
  POSTED, a credit/debit note is immutable and permanent, identical to
  every other posted document in this subledger (invoices, bills,
  receipts, payments). Correcting a wrongly-posted credit/debit note
  requires a new, separate correcting document — consistent with, not
  an exception to, the rest of the subledger's design.
- **Tax remains a flat, client-supplied per-line amount.** No tax
  rate/code master data is introduced (Tax/VAT remains PLANNED per the
  roadmap) — this is an accepted, pre-existing limitation, not a new
  one.
- **Concurrent posting against the same invoice/bill** (e.g. a receipt
  and a credit note allocated to the same invoice at the same moment)
  is correctly serialized by the existing ascending-id `FOR UPDATE`
  lock ordering — the same proven-safe pattern already adversarially
  tested for concurrent receipts.

## 19. Open CTO decisions

**Decision #1 — RESOLVED (CTO review round 1): Option A.** Credit/
debit-note allocations reuse the existing
`customer_invoices.paidMinor`/`paymentStatus` and
`supplier_bills.paidMinor`/`paymentStatus` columns, treating a
credit/debit note as another way an invoice/bill gets "settled,"
alongside cash receipts/payments. No schema change to
`customer_invoices`/`supplier_bills`. This does **not** mean zero
`ar-reports`/`ap-reports` changes overall — current-mode paths that
already read `paidMinor` (Balance, Ageing, current-mode Reconciliation)
need none, but historical as-of reconstruction and Statement's
transaction listing need the minimal, additive changes specified in
§9a, now folded into this proposal's in-scope work rather than treated
as a follow-up. No further decisions remain open — every other design
choice in this proposal follows directly from already-established
repository conventions and required no CTO judgment call.

## 20. Acceptance criteria

- All 8 new tables migrated; RLS policies and immutability triggers
  applied and independently verified.
- `CustomerCreditNotesModule` and `SupplierDebitNotesModule` wired into
  `app.module.ts`.
- `route-role-matrix.spec.ts` updated and green with the exact new
  route/controller counts computed at implementation time.
- Full verification green: typecheck, lint, build, unit tests, and the
  complete e2e suite run twice for stability — matching the bar set by
  Financial Statements' own verification.
- Independent PostgreSQL verification of: (a) credit note Dr/Cr posting
  amounts match line/tax/total exactly, (b) debit note Dr/Cr posting
  amounts match line/tax/total exactly, (c) allocated invoices'/bills'
  `paidMinor`/`paymentStatus` are correctly updated post-allocation,
  (d) AR/AP control account balances computed via Trial Balance,
  General Ledger, and the new postings directly all agree.
- Every existing AP-1a–d, AR-1a–d, and Financial Statements e2e suite
  remains 100% green and **unmodified** — proving zero regression to
  any existing subledger or reporting behavior.
- `git diff` scope limited to: the two new module directories,
  `app.module.ts`, `route-role-matrix.spec.ts`, one new migration file,
  new RLS/constraint SQL files, additive-only changes to `schema.ts`,
  **and the §9a additive query changes inside
  `ar-reports.service.ts`/`ap-reports.service.ts`** (their `*.controller.ts`
  and DTO files are unchanged — only the two services' `asOfTotals()`/
  `getCustomerStatement()`/`getSupplierStatement()` methods gain new
  branches) — corrected from the original submission, which
  under-scoped this to exclude `ar-reports`/`ap-reports` entirely. No
  changes inside `general-ledger/`, `financial-statements/`,
  `journal-entries/`, `accounting-periods/`, or any existing
  `accounts-payable/`/`accounts-receivable/` file outside the two
  reports services named above.
- New historical-as-of and statement e2e cases (§16) added to the
  _existing_ `ar-reports`/`ap-reports` e2e specs pass, alongside every
  pre-existing case in those same specs remaining green and unmodified.

## 21. Implementation sequence

1. Schema: add the 8 new tables and 2 new enums to `schema.ts`,
   generate migration `0011`.
2. DB constraints: RLS policy files and immutability trigger files for
   all 8 new tables.
3. AR module: `customer-credit-notes/` (dto/service/controller/module),
   mirroring `customer-receipts/` file-for-file.
4. AP module: `supplier-debit-notes/` (dto/service/controller/module),
   mirroring `supplier-payments/` file-for-file.
5. Wire both modules into `app.module.ts`.
6. Update `route-role-matrix.spec.ts` with both controllers' expected
   routes and roles.
7. Unit tests: DTO specs for both modules and their nested DTOs.
8. e2e tests: the two new spec files covering the full acceptance
   matrix in §16.
9. **Reporting integration (§9a, added in this revision):** extend
   `asOfTotals()` in both `ar-reports.service.ts`/`ap-reports.service.ts`
   to include credit/debit-note allocations; add the
   `CREDIT_NOTE`/`DEBIT_NOTE` row type to
   `getCustomerStatement()`/`getSupplierStatement()`.
10. New e2e cases inside the _existing_ `ar-reports`/`ap-reports` specs
    covering §16's historical-as-of and statement acceptance matrix,
    confirming zero regression to every pre-existing case in those
    specs.
11. Full verification: typecheck, lint, build, unit tests, e2e suite
    run twice.
12. Independent PostgreSQL verification of postings, control-account
    balances, and historical as-of/statement correctness.
13. Review `git diff` scope, commit, create and verify the delivery
    bundle — matching every prior Finance Work Item's process exactly.
