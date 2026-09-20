# CTO Finance Core Reassessment — repository HEAD `91b9d47`

Prepared by: Principal Engineer
Scope: Discovery / architecture assessment only. No implementation, schema, test, commit, or push activity occurred in producing this document. `docs/hardening/` and the standing Milestone 3.x hardening exceptions were not touched.

---

## A. Current Finance State

### A.1 What is actually implemented and proven at `91b9d47`

Verified directly against the repository (schema, module tree, controllers, route-role-matrix, and — for AP-1d/AR-1d specifically — real e2e tests against PostgreSQL), not against documentation claims:

**Accounting Core — complete.**
`chartOfAccounts`, `accountingPeriods`, `journalNumberCounters`, `journalEntries`, `journalLines` (5 tables). Full CRUD-appropriate lifecycle: account create/list/get/archive (no rename/update — accounts are immutable post-create, a known minor gap); period create/list/close with overlap prevention; journal entry create/list/get/update(draft-only)/delete(draft-only)/post/reverse. Immutability of posted entries and balance enforcement are DB-trigger/constraint-backed, not application-only. General Ledger read layer (`general-ledger` module) provides `GET accounts/:id/ledger`, `GET accounts/:id/balance`, `GET trial-balance` — all read-only, all three finance roles, `REPORT_TX_CONFIG` (repeatable-read/read-only transaction) established here first and reused by every later report layer.

**Accounts Payable — complete, full stack.**
`suppliers`, `apSettings`, `apNumberCounters`, `supplierBills`, `supplierBillLines`, `apPaymentNumberCounters`, `supplierPayments`, `supplierPaymentAllocations` (8 tables). Supplier master, bill lifecycle, payment + allocation, and a full reports layer (`ap-reports`: supplier balance, supplier statement, AP ageing, AP↔GL reconciliation with the `LIABILITY`/credit-normal control-account check).

**Accounts Receivable — complete, full stack, feature-parity with AP.**
`customers`, `arSettings`, `arNumberCounters`, `customerInvoices`, `customerInvoiceLines`, `arReceiptNumberCounters`, `customerReceipts`, `customerReceiptAllocations` (7 tables). Customer master, invoice lifecycle, receipt + allocation, and a full reports layer (`ar-reports`: customer balance, customer statement, AR ageing, AR↔GL reconciliation with the `ASSET`/debit-normal control-account check, `/ar/reconciliation` deliberately legal-entity-wide with no `customerId`).

**Totals confirmed directly from schema/route inspection:** 20 Drizzle tables, all belonging to Accounting Core, AP, or AR. Zero tables exist for banking/cash, expenses, fixed assets, tax, or budgets. 14 controllers, 64 routes per `route-role-matrix.spec.ts`. Single-currency only: `currencyCode` is fixed at creation from the legal entity's functional currency, non-convertible, present on `journalEntries`, `supplierBills`, `supplierPayments`, `customerInvoices`, `customerReceipts` — explicitly documented in-schema as "a multi-currency extension point — additive columns only, no rename," i.e. a placeholder, not functional multi-currency.

**FK/invariant convention (confirmed):** cross-service references (tenantId/legalEntityId) are app-validated, no Postgres FK. References within Finance's own schema (journal lines → journal entries → accounting periods → chart of accounts, and by extension every AP/AR table's references into that core) use real Postgres FKs and DB-level invariant enforcement (balance, immutability, numbering uniqueness, period-overlap).

**Security posture (per `docs/security.md`, cross-checked against Milestone 3.1/3.2 status in the roadmap):** tenant isolation via Postgres RLS, immutable audit trail on `audit_logs` (DB-trigger-enforced), MFA, short-lived tokens, rate limiting, security headers, and CI-layer SAST/SCA/secrets/IaC/container scanning are all in place at the platform level. Milestone 3.1 (Tenant/RLS Hardening) and 3.2 (RBAC & Authorization Hardening, Work Items 1–8 and 10) are complete; 3.2 Work Items 9 and 11 remain formally deferred pending unrelated prerequisites (a `TENANT_EXTERNAL` persona and a future role-assignment capability, neither of which exists yet). Milestones 3.3 (Transaction/Concurrency), 3.4 (Accounting & Audit Integrity), and 3.5 (Production Readiness) are **explicitly deferred in the roadmap itself** until the complete Finance functional surface exists — this reassessment's "do not start hardening" instruction is consistent with standing, already-recorded policy, not a new constraint.

### A.2 Roadmap-vs-actual drift found (surfaced only, not corrected)

`docs/roadmap.md`'s locked capability tree (lines 73–90, 159–186) still marks the following as **PLANNED** / unchecked, when the repository proves them **COMPLETE**:

- Line 76–77: `Accounts Payable (PLANNED)`, `Accounts Receivable (PLANNED)` — both fully implemented (AP-1a–1d, AR-1a–1d).
- Line 79: `Payments / Receipts (PLANNED)` — implemented as part of AP-1c/AR-1c.
- Line 161: AP checklist — every box unchecked, including `[ ] AP ageing`, `[ ] AP reporting`, `[ ] Payment processing`, `[ ] Payment allocation` — all implemented.
- Line 163: AR checklist — every box unchecked, including `[ ] AR ageing`, `[ ] AR reporting`, `[ ] Receipts`, `[ ] Receipt allocation` — all implemented.
- Line 179: Financial Reporting checklist shows `[ ] Account statements` and `[ ] AP/AR ageing reports` as not done — both now exist (AP-1d/AR-1d's balance/statement/ageing endpoints).

This is pure documentation lag from the AP-1a→AR-1d build-out not yet being reflected back into `roadmap.md`'s checklists (the narrative sections of the roadmap — the ones describing the re-baseline decision itself — are internally consistent; it is specifically the capability-tree checkboxes that are stale). Per instruction 8, this is reported here and **not corrected** in this pass.

No other material drift was found: the module tree, schema, and route-role-matrix all match what a reader of the AP-1a through AR-1d proposals would expect, with no undocumented capability and no documented-but-missing capability beyond the checklist staleness above.

---

## B. Finance Capability Map

Grouped strictly by domains already named in `docs/roadmap.md`'s locked capability tree — no invented domains. Status reflects actual repository state, not the roadmap's (stale) checkboxes.

| Domain                                                         | Status (actual)                         | Evidence                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core Accounting (CoA, Periods, Journal Entries, GL read layer) | **Complete**                            | 5 tables, `general-ledger` read layer, DB-enforced invariants                                                                                                                                                                                                                                                                       |
| Accounts Payable                                               | **Complete**                            | 8 tables, `ap-reports` full report layer                                                                                                                                                                                                                                                                                            |
| Accounts Receivable                                            | **Complete**                            | 7 tables, `ar-reports` full report layer                                                                                                                                                                                                                                                                                            |
| Invoicing / Billing                                            | **Partial**                             | Invoice/bill creation + lines exist inside AP/AR; **credit/debit notes, invoice lifecycle beyond DRAFT→POSTED (no void/cancel/amend path), and invoice-to-accounting integration beyond the direct AP/AR posting path are not implemented**                                                                                         |
| Payments / Receipts                                            | **Complete** (as a capability of AP/AR) | Payment/receipt entities + allocation, both subledgers                                                                                                                                                                                                                                                                              |
| Banking / Reconciliation                                       | **Not started**                         | No bank-account entity, no bank-statement import, no bank-to-GL reconciliation. `bankCashAccountId` on payments/receipts is an unconstrained reference into `chartOfAccounts` — nothing enforces it actually points at a bank/cash-type account                                                                                     |
| Cash Management                                                | **Not started**                         | No cash-position report, no cash forecasting, no dedicated cash subledger                                                                                                                                                                                                                                                           |
| Expense Management                                             | **Not started**                         | No tables, no module                                                                                                                                                                                                                                                                                                                |
| Fixed Assets                                                   | **Not started**                         | No tables, no module                                                                                                                                                                                                                                                                                                                |
| Budgeting / Planning                                           | **Not started**                         | No tables, no module                                                                                                                                                                                                                                                                                                                |
| Tax / VAT                                                      | **Not started** (partially wired)       | `taxAmountMinor` fields exist on invoice/bill line DTOs as pass-through amounts; no tax configuration, rate table, calculation engine, or tax reporting exists                                                                                                                                                                      |
| Multi-Currency                                                 | **Not started** (extension point only)  | Fixed, non-convertible `currencyCode` column present; no rate table, conversion, or FX gain/loss handling                                                                                                                                                                                                                           |
| Financial Reporting                                            | **Partial**                             | Trial Balance + GL reports (Core), Account Statements + AP/AR Ageing (AP-1d/AR-1d) are done; **Profit & Loss, Balance Sheet, Cash Flow, Management reporting, Consolidated reporting are not implemented**                                                                                                                          |
| WIP / Accrual Engine                                           | **Not started**                         | No tables, no module, no design document exists anywhere in the repository beyond the historical rebaseline discovery note naming it as future scope                                                                                                                                                                                |
| Audit / Compliance                                             | **Partial**                             | Journal/period/CoA audit trail and immutable posted history are complete (DB-trigger-backed); approval-history-beyond-DRAFT→POSTED, broader accounting-integrity hardening (Milestone 3.4, deferred by design), compliance reporting, and full source-to-GL traceability once non-JE source transactions multiply are not yet built |
| Advanced Finance & AI                                          | **Not started**                         | Explicitly reserved scope per roadmap, no implementation expected at this stage                                                                                                                                                                                                                                                     |

Everything above is either directly observed in the repository (schema, controllers, tests) or is the roadmap's own stated scope for a named domain — no domain was added or removed from what `docs/roadmap.md` and the repository jointly establish.

---

## C. Dependency Analysis

**What Accounting Core + AP + AR jointly now newly enable, that did not exist before:**

1. **Real, multi-account-type transaction volume flowing through the ledger.** Before AP/AR, the only way `journal_lines` got populated was direct, manual journal-entry posting through the Core. Now every AP bill/payment and AR invoice/receipt generates real `ASSET`/`LIABILITY`/`REVENUE`/`EXPENSE` postings through two independent, already-proven subledger paths. This is the precondition for any report that needs realistic data across account _types_ rather than one account at a time (Trial Balance already reads across all types; Financial Statements — P&L, Balance Sheet — are the next natural consumers).

2. **A working control-account reconciliation pattern, proven twice, in both signs.** AP-1d proved the pattern for a credit-normal (`LIABILITY`) control account; AR-1d proved it for a debit-normal (`ASSET`) control account, including the harder as-of/point-in-time reconstruction case. Any future capability that needs to reconcile a subledger to a GL control account (e.g. a future Bank/Cash subledger reconciling to a bank-control GL account) now has two working, tested reference implementations to mirror rather than a novel design problem.

3. **A validated "pure read-layer" delivery pattern**, used three times now (GL's Trial Balance/Ledger/Balance, AP-1d, AR-1d): `REPORT_TX_CONFIG` for snapshot consistency under concurrent posting, tenant/legal-entity security via `requireTenantContext`, DTO+service+controller+module shape, route-role-matrix wiring, e2e-against-real-Postgres verification, direct psql cross-check. This lowers the risk and cost of the next reporting-layer capability specifically — which matters for prioritization, because it means a Financial Statements work item is now structurally cheap and low-risk to execute, not just valuable.

4. **A concrete, non-hypothetical gap in Banking/Cash.** AP-1c and AR-1c introduced `bankCashAccountId` on `supplierPayments`/`customerReceipts` as a plain reference into `chartOfAccounts`, with no dedicated bank-account entity and no constraint that the referenced account is actually bank/cash-typed. AP/AR's existence is what exposes this — it wasn't visible as a gap before payments/receipts existed to reference "a bank account" in the first place.

5. **A concrete, non-hypothetical gap in invoice/bill correction.** Neither AP nor AR has a credit/debit-note or void/amend path for a posted document. Today the only way to correct a posted bill or invoice is a manual, out-of-band journal entry — which bypasses the exact subledger-to-GL reconciliation invariant AP-1d/AR-1d were built to prove. This is a real integrity gap created by AP/AR going live, not a pre-existing one.

**What still has no dependency satisfied by AP/AR** (i.e., candidates whose case for "next" would have to rest on business value or roadmap history alone, not on anything AP/AR specifically unlocked): WIP/Accrual Engine, Tax/VAT, Fixed Assets, Budgeting/Planning, Multi-Currency, Advanced Finance/AI. All of these sit on the Accounting Core directly and would have been equally buildable (or not) whether or not AP/AR existed.

---

## D. Next-Work Recommendation

**Recommend: Financial Statements — Profit & Loss and Balance Sheet (read layer).**

This is not recommended because of its position in any sequence — it has no work-item number in the roadmap at all, unlike AP-1e/AR-1e style continuations that this reassessment was explicitly told not to assume. It is recommended because it is the strongest fit against every criterion the CTO asked this assessment to weigh:

- **Business value.** A finance suite that can post transactions and reconcile subledgers but cannot produce a Profit & Loss or Balance Sheet is not yet usable as an accounting system for its core purpose — every other stakeholder (the business itself, auditors, lenders, tax authorities) eventually needs these two statements. Trial Balance exists but is a working paper, not a statement anyone external reads.
- **Data already available.** 100% of the required source data — `journal_lines` (debit/credit minor amounts, account references), `chart_of_accounts` (account `type`), `accounting_periods` — already exists and requires no new master-data domain, unlike every other remaining PLANNED domain (Banking needs a bank-account entity; Tax needs a rate/config model; Fixed Assets needs an asset register; Budgeting needs a budget entity; WIP/Accrual needs new posting semantics).
- **Architectural dependency / lowest risk.** This is a pure read layer over data structures that are already complete and stable (Accounting Core has needed zero schema changes since AP-1a). It requires no schema, migration, or RLS change — the same "pure read layer" characterization the CTO used to scope both AP-1d and AR-1d, now with a third precedent (GL's own Trial Balance) to mirror.
- **What AP/AR specifically newly enable.** Per §C.1, AP/AR are what turned the ledger from manually-posted single-purpose test data into a realistic multi-account-type stream. A P&L/Balance Sheet exercised only against hand-crafted Core-only journal entries would be far less representative than one exercised against real AP/AR-driven activity across `REVENUE`, `EXPENSE`, `ASSET`, and `LIABILITY` accounts — which is now available.
- **Future reporting/operations.** P&L and Balance Sheet are the two statements every subsequent Financial Reporting item (Cash Flow, Management Reporting, Consolidated Reporting) is built from. Sequencing them first is a genuine architectural prerequisite for the rest of that domain, not just a convenient next step.
- **Product direction.** `docs/roadmap.md` line 87 already singles out Financial Reporting as the one domain that is explicitly _partially_ complete rather than fully PLANNED, and line 179 explicitly names P&L, Balance Sheet, and Cash Flow as the specific remaining gaps in that domain (Account Statements and AP/AR Ageing, also named there, are — per §A.2 — already done).

This recommendation is deliberately **not** WIP/Accrual Engine, despite that domain's long, well-documented history in this repository's roadmap discovery — see §E for why it ranks below.

---

## E. Alternatives Considered

**1. WIP / Accrual Engine.**
The strongest historical claim: it is the one Finance capability explicitly named, repeatedly, across multiple roadmap revisions, with zero design ever produced (`docs/hardening/finance-functional-rebaseline-proposal.md` §4, predating AP/AR entirely). But that history is exactly why it should not be picked on that basis alone here — the CTO's own subsequent "Finance-First Product Build Strategy" already superseded that discovery document's implied sequencing once, choosing AP→AR instead. WIP/Accrual sits directly on the Accounting Core and has no dependency on AP/AR at all (§C.2) — nothing about AP/AR going live makes WIP/Accrual more or less ready to build than it was before. It also carries materially higher design risk than Financial Statements: it introduces new posting semantics (deferred recognition, reversal-on-a-future-period, period-end automation) rather than being a pure read layer, and would need its own schema/migration decisions — a different risk class from the three "pure read layer" deliveries just proven. It remains a strong candidate for a _following_ work item, just not this one.

**2. Banking / Cash Management.**
The strongest "AP/AR-created-this-gap" claim (§C.4): `bankCashAccountId` is live in both subledgers today with no real bank-account entity behind it. But closing that gap properly needs new master data (a Bank Account entity, at minimum) and very likely new schema (bank transactions, a bank-statement-import shape) before any reconciliation logic can be written — this is a materially larger, higher-risk scope than a read layer, closer in shape to a new AP-1a/AR-1a foundation item than to AP-1d/AR-1d. It is a strong second candidate, but Financial Statements delivers comparable or greater business value at a fraction of the schema/design risk, and does so first.

**3. Invoicing/Billing completion — Credit/Debit Notes.**
The strongest "AP/AR integrity gap" claim (§C.5): today, correcting a posted invoice or bill requires an out-of-band manual journal entry that bypasses the reconciliation invariant AP-1d/AR-1d exist to prove. This is real and should not stay unaddressed indefinitely. It ranks below the recommendation because it is a correctness/completeness gap in an already-complete domain (Invoicing sits inside AP/AR, which are marked complete above) rather than a new capability the business is currently blocked on, and because — unlike Financial Statements — it requires new document-lifecycle design (does a credit note reference an original invoice/bill 1:1 or N:1, does it require its own approval workflow, does it get its own numbering sequence) that is a genuine open design question, not a mechanical read-layer extension.

---

## F. Proposed Work-Item Boundary — Financial Statements (P&L & Balance Sheet)

_(A descriptive name is used deliberately, per instruction 5 — actual work-item numbering/naming is a CTO/PM decision, not assumed here.)_

**Proposed scope:**

- `GET /financial-statements/profit-and-loss` — aggregates `journal_lines` by `chart_of_accounts.type` (`REVENUE`, `EXPENSE`) over a period range (`periodStart`/`periodEnd`, or an `accountingPeriodId` range), producing revenue, expense, and net-income totals per account, legal-entity-scoped.
- `GET /financial-statements/balance-sheet` — aggregates `journal_lines` by `chart_of_accounts.type` (`ASSET`, `LIABILITY`, `EQUITY`) as of a point in time (`asOf`), with the same debit/credit-normal-sign handling already established by GL/AP-1d/AR-1d.
- New `financial-statements` module, service, controller, DTOs, tests — sibling to `general-ledger` at the Accounting Core level (not nested under AP or AR, since it draws on the whole ledger).
- Reuse of `REPORT_TX_CONFIG`, `requireTenantContext`, and the established route-role-matrix/e2e-against-real-Postgres verification pattern.

**Explicit non-scope:**

- Cash Flow Statement (direct or indirect method) — depends on comparative Balance Sheet deltas across periods and is naturally a follow-on once Balance Sheet exists, not part of this item.
- Management reporting, consolidated/multi-entity reporting, comparative (prior-period or budget-vs-actual) columns, and export formats (PDF/Excel) — all deferred.
- Any schema, migration, RLS, or constraint change — this is proposed as a pure read layer, identical in kind to AP-1d/AR-1d/GL's Trial Balance.
- No changes to AP, AR, or Accounting Core write paths.

**Expected tables:** none new. Reads only `journal_lines`, `journal_entries`, `chart_of_accounts`, `accounting_periods`.

**Expected APIs/modules:** `financial-statements` module (service/controller/module + 2 DTOs + specs), route-role-matrix extended to 66 routes / 15 controllers.

**Accounting impact:** none — read-only, no posting logic touched.

**Dependencies:** Accounting Core (complete), GL read layer (complete, establishes the sign/aggregation conventions to mirror). No AP/AR-specific dependency beyond the transaction volume argument in §D.

**Testing requirements:** e2e against real PostgreSQL exercising multi-account-type activity (mirroring the AP-1a→AR-1d fixture style), a balance-sheet identity check (Assets = Liabilities + Equity + current-period net income) verified both through the service and via an independent direct-psql query, and a P&L-to-Trial-Balance cross-check for the same period.

**Design questions requiring CTO approval:** see §G.

---

## G. CTO Decisions

Only decisions that genuinely require CTO/Product judgment — none manufactured to create a review step.

1. **Confirm the recommended next Finance work item.** Do you want to proceed with Financial Statements (P&L & Balance Sheet) as recommended in §D, or direct one of the §E alternatives (WIP/Accrual Engine, Banking/Cash Management, Credit/Debit Notes) instead?

2. **Chart-of-accounts hierarchy in statement presentation.** `chartOfAccounts.parentId` (self-referential) exists in the schema but is not used by any report today (GL, Trial Balance, AP/AR reports are all flat, per-account). Should Balance Sheet/P&L v1 present a flat listing of accounts grouped only by `type`, or should it roll up by the parent/child hierarchy (e.g., subtotal "Current Assets," "Current Liabilities")? This is the first time this schema field would actually matter to a report's output shape.

3. **Retained earnings / period-close handling.** There is currently no year-end-close or closing-journal-entry process — `accounting_periods` can be closed to further posting, but nothing zeroes REVENUE/EXPENSE accounts into an Equity/Retained-Earnings balance. Should the Balance Sheet compute current-period net income as a live plug line into Equity (no new posting, purely a report-time calculation), or does this work item need to define an actual period-close/closing-entry mechanism first?

4. **Scope boundary — include Cash Flow now or defer it.** §F proposes deferring Cash Flow Statement to a follow-on item, since it depends on comparative Balance Sheet data this item introduces. Confirm that split, or direct that Cash Flow be included in this same work item's scope.

---

**STOP HERE per instruction. No implementation proposal, code, schema, test, commit, or push has been produced. Awaiting CTO review of this assessment and a decision on §G before any further work begins.**
