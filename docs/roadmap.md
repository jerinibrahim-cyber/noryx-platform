# Roadmap

Condensed from the _Pre-Development Readiness Review_ §6. Full scope,
exit criteria, and indicative durations live in that document — this is
just a status tracker for the repo.

## Current execution status — 2026-09-21

**Current baseline:** `main` at `2bcb13130eb322cf5810410c0e3ffe06e8f0d8e6` — Tax/VAT Phase 6 (Manual Journal Tax Coverage) is implemented, verified (clean unit, e2e, lint, typecheck; migration `0024_tax_vat_phase_6_manual_journal_tax_coverage.sql` applied), and delivered to `main`. See `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/COMPLETION_REPORT.md` for the full verification record.

**Completed immediately before Tax/VAT Phase 6:** Budgeting Phase 1 Foundation (`ac16fa0e...`); before that Tax/VAT Phase 5 (Per-Tax-Code GL Account Mapping); before that Tax/VAT Phase 4 (VAT Position Report, `ba607b8`/`8ccdec5`); before that Tax/VAT Phase 3 (AR Tax Calculation, `ad71a50`/`263354b`); before that Tax/VAT Phase 2 (AP Tax Calculation, `ae4b073`/`6229bc6`); before that Tax/VAT Phase 1 (Tax Configuration Foundation, `dd6d135`); before that, Banking 1A–1E, Banking Reconciliation, and Scheduled Reversal are treated as complete per the governing Finance baseline.

**Current work item:** Repository reverification, cleanup, and CI restoration (`chore/repository-governance-and-cleanup-2026-09`).

**Tax/VAT Phase 1 — COMPLETE:** Tax Code master, effective-dated Tax Rate master, tenant/RLS isolation, RBAC, audit logging, database-level rate-overlap protection, migration-pipeline wiring, and configuration APIs. Verified with the Phase 1 regression/e2e suite and pushed as `dd6d135`.

**Tax/VAT Phase 2 — COMPLETE:** Wires the approved Tax Code/Rate model into Supplier Bills and Supplier Debit Notes — optional line-level `taxCodeId`, rate resolution by the document's own transaction date, line-level integer minor-unit rounding, snapshot (immutable `taxRateId` FK), and override semantics (Decision 4) — with legacy `taxAmountMinor` behavior fully preserved when `taxCodeId` is omitted. Debit-note tax resolves independently per line, by the debit note's own `debitNoteDate`, never inherited from any allocated bill — the CTO-confirmed correction to the originally-proposed Decision 1 (`docs/work-items/tax-vat-phase-2-ap-tax-calculation/DISCOVERY.md` §13), because a debit note has no single "original document" and no line-level linkage to any bill line. Also corrected a pre-existing Phase 1 bug found while verifying the half-open effective-date boundary: `TaxRatesService.create()`'s overlap pre-check used inclusive comparisons, stricter than the actual (correct) EXCLUDE constraint — narrowed to strict comparisons so the pre-check matches the constraint it exists to preview; no change to the constraint itself or to any other approved behavior.

**Tax/VAT Phase 3 — COMPLETE:** Wires the same approved Tax Code/Rate model into Customer Invoices and Customer Credit Notes — optional line-level `taxCodeId`, rate resolution by the document's own transaction date (`invoiceDate`/`creditNoteDate`), line-level integer minor-unit rounding, snapshot (immutable `taxRateId` FK), and override semantics identical to Phase 2's Decision 4 — with legacy `taxAmountMinor` behavior fully preserved when `taxCodeId` is omitted. Credit-note tax resolves independently per line, by the credit note's own `creditNoteDate`, never inherited from any allocated invoice — carrying forward Phase 2's CTO-confirmed no-inheritance correction, because `customer_credit_note_allocations` is a header-level many-to-many table with no line-level linkage to any invoice line. Reused `TaxConfigurationModule`/`TaxRatesService`/`calculateTaxAmountMinor` unmodified via DI — no new tax-calculation logic was written, only AR wiring, per the discovery document's finding that this infrastructure was already AP/AR-agnostic. See `docs/work-items/tax-vat-phase-3-ar-tax-calculation/DISCOVERY.md` for the discovery record and `docs/work-items/tax-vat-phase-3-ar-tax-calculation/COMPLETION_REPORT.md` for the full verification record.

**Tax/VAT Phase 4 — COMPLETE:** A new read-only `TaxReportsController`/`TaxReportsService` (`GET /v1/finance/tax-reports/vat-position`) reports the VAT position for a legal entity over a `dateFrom`/`dateTo` window (or a resolved `periodId`) — net output tax (posted Customer Invoices net of posted Customer Credit Notes), net input tax (posted Supplier Bills net of posted Supplier Debit Notes), and the net VAT position, broken down by tax code/treatment with supply-value and calculated-vs-overridden visibility, plus an optional GL movement cross-check against the two singleton tax accounts. No schema change, no migration — built entirely on the four line tables Phases 2/3 already wrote, never on `journal_lines` (which carries no `tax_code_id` and cannot support a per-code breakdown — confirmed by direct inspection of the posting code). See `docs/work-items/tax-vat-phase-4-vat-position/DISCOVERY.md` for the discovery record (all six §11 decisions resolved per its own recommendations) and `docs/work-items/tax-vat-phase-4-vat-position/COMPLETION_REPORT.md` for the full verification record.

**Tax/VAT Phase 5 — COMPLETE:** Optional, nullable per-tax-code GL account overrides — `tax_codes.ap_tax_account_id` (input/AP direction) and `tax_codes.ar_tax_account_id` (output/AR direction), migration `0020_tax_vat_phase_5_gl_account_mapping.sql` — resolved and SNAPSHOTTED onto each tax-bearing document line (`resolved_tax_account_id`, new nullable FK column on `supplier_bill_lines`, `supplier_debit_note_lines`, `customer_invoice_lines`, `customer_credit_note_lines`) at the existing `resolveLineTax()` stage, while the document is still DRAFT — never re-derived at `post()` time, and never written by `post()` at all, since the same database-level immutability triggers that already protect every other tax snapshot field (`taxRateId`, `taxAmountCalculatedMinor`, …) protect this one for free once the parent document is POSTED (directly verified at the DB level: a raw `UPDATE` against a posted line's `resolved_tax_account_id` is rejected by the existing trigger). A code with no override falls back to the existing AP/AR-settings singleton account, resolved at that same moment — 100% backward-compatible: a tenant with no Phase 5 configuration sees byte-for-byte the same posting behavior as before this phase (confirmed by the full pre-existing e2e suite passing unmodified). `post()` now emits one tax journal line per DISTINCT resolved account (aggregating same-account lines, never aggregating different accounts together), preserves each document type's existing debit/credit polarity exactly, and rejects posting (422) when a tax-bearing line resolved to no account at all or its resolved account was deactivated before posting — "every posted tax line has a deterministic accounting destination." The VAT Position Report's `glCrossCheck` gained two additive-only fields (`outputTaxAccounts`/`inputTaxAccounts`), a full multi-account breakdown derived from the lines' own historical `resolvedTaxAccountId` snapshots (not current configuration) — the existing 8 singleton fields keep their exact pre-Phase-5 names/types/meanings, so no existing consumer is broken. New `PATCH /tax-codes/:id/gl-accounts` route (`finance.admin`) sets/clears the two overrides, reusing the AP/AR-settings tax-account validation pattern (exists/active/same legal entity, no `accountType` check). See `docs/work-items/tax-vat-phase-5-gl-account-mapping/DISCOVERY.md`, `docs/work-items/tax-vat-phase-5-gl-account-mapping/PROPOSAL.md`, and `docs/work-items/tax-vat-phase-5-gl-account-mapping/COMPLETION_REPORT.md` for the full discovery, architecture review, and verification record.

**Tax/VAT Phase 6 — COMPLETE:** Manual Journal Tax Coverage — optional, nullable `journal_lines.tax_code_id`/`journal_lines.tax_direction` (migration `0024_tax_vat_phase_6_manual_journal_tax_coverage.sql`), for explicitly tax-classifying a manually-posted journal line (no AP/AR document behind it). Deliberately no tax calculation for manual lines — a tagged line's own debit/credit amount _is_ the tax amount attributed to that code+direction (a journal line has no taxable-base concept the way an AP/AR document line does); direction is always explicitly supplied, never inferred. Both-or-neither pairing enforced by a DTO validator and two DB CHECK constraints. Validated at draft create/edit AND independently re-validated at post time (a tax code can be deactivated in between). Reversal carries the original's classification unchanged (debit/credit still swap) — combined with the VAT Position Report's signed-contribution formula, a reversed manual entry's net contribution is always exactly zero. The VAT Position Report's `outputTaxMinor`/`inputTaxMinor` headline totals now include classified manual-journal tax (CTO decision: unified headline, not a separate one), with two new additive `meta` fields (`manualOutputTaxMinor`/`manualInputTaxMinor`) and one new additive per-tax-code field (`manualTaxMinor`) preserving full source-level (AP/AR vs. manual) attribution. No new routes, no RLS change (existing tenant policy filters rows, not columns), no change to the existing generic posted-line immutability trigger (proven, not just asserted, to already cover the two new columns via a direct raw-SQL test). This closes the exact gap a pre-existing e2e test already demonstrated (`vat-position-report.e2e-spec.ts`'s "manual journal entry posts to the tax-output account outside any AR document" scenario, still passing unmodified — an _untagged_ manual line is still correctly excluded, matching Phase 6's explicit no-retroactive-classification design). See `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/` (`CONTRACT.md`, `ACCEPTANCE.md`, `COMPLETION_REPORT.md`) for the discovery, contract, acceptance criteria, and full verification record.

**Next approved work item:** Not yet discovered or authorized. Tax/VAT Phase 7 (and subsequent Finance features) are NOT authorized for implementation on `main`.

**Execution gate:** The next phase's discovery/implementation starts only after a separate, explicit CTO discovery/authorization prompt. No feature choice may be inferred from stale roadmap text.

| Phase                             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Phase 0 — Foundation**          | Monorepo, CI/CD security gates, tenant/legal-entity schema + RLS, Identity (auth, MFA, tenant-aware JWTs), API Gateway (module-manifest routing), design system + web shell, Subscription & Entitlement schema                                                                                                                                                                                                                                                                                                                              | **In progress** — see below                          |
| **Phase 1 — Sphere & Orbis Core** | **Sphere Finance — complete finance suite** (Accounting Core, AP, AR, Invoicing/Billing, Payments/Receipts, Banking & Reconciliation, Cash Management, Expense Management, Fixed Assets, Budgeting/Planning, Tax/VAT, Multi-Currency, Financial Reporting, WIP/Accruals, Audit & Compliance, Advanced Finance/AI — see "Finance-First Product Build Strategy" below), Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Contract Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, field technician mobile app | **In progress** — Finance functional build is active |
| **Phase 2 — Core hardening**      | SLA & Command Centre, Master Data Hub governance UI, Reporting & BI foundation, Notifications, Document/e-Sign registry                                                                                                                                                                                                                                                                                                                                                                                                                     | Not started                                          |
| **Phase 3 — Service Business**    | Service Project/job-costing, Customer Portal v1 (read-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not started                                          |
| **Phase 4 — Intelligence**        | Persona dashboards, Orbis Command Centre recommendations, financial intelligence aggregations                                                                                                                                                                                                                                                                                                                                                                                                                                               | Not started                                          |
| **Phase 5 — Ecosystem**           | Public API productization, Supplier Portal, document OCR/AI extraction, remaining persona mobile apps                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not started                                          |
| **Future**                        | Embedded AI, ESG contribution, full multi-company activation, Workflow & Automation Studio, on-prem/dedicated deployment tier                                                                                                                                                                                                                                                                                                                                                                                                               | Named, not scheduled                                 |

## Phase 0 — what's built as of this commit

- [x] Monorepo scaffold (pnpm workspaces + Turborepo), shared TS config, ESLint, Husky pre-commit
- [x] `packages/db-core` — Tenant/LegalEntity/User/Subscription/AuditLog schema, RLS policies, tenant context propagation
- [x] `packages/shared-types` — API envelope, JWT claims, event envelope, `ModuleManifest`
- [x] `packages/event-bus-client` — in-memory + Azure Service Bus adapters
- [x] `packages/ui-kit` — design tokens, runtime tenant theming, base components
- [x] `services/identity` — login/refresh/logout, MFA (TOTP), account lockout, subscription-state enforcement
- [x] `services/api-gateway` — module-manifest routing, entitlement + RBAC gating, health/readiness
- [x] `apps/web` — app shell, login screen, dashboard nav stub for both product families
- [x] CI pipeline — lint/typecheck/test, SAST, SCA, secrets scan, IaC scan, container build+scan+sign+SBOM
- [x] `docker-compose.yml` for local dev
- [ ] Cloud service-parity spike (Azure Qatar Central) — needs a real cloud subscription, not doable from this environment
- [ ] Subscription & Entitlement Service as a standalone service with an admin API (currently: schema only, checked directly by Identity/Gateway)
- [ ] Kubernetes manifests / Terraform (`infra/k8s`, `infra/terraform` — scaffolding only so far)
- [ ] Tenant Provisioning Service

## Phase 1 — what's built so far

Phase 1 covers Sphere Finance (the complete finance suite — see below),
Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Contract
Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM,
and the field technician mobile app. The Finance implementation is now
well beyond the original Accounting Core foundation and is being built
capability-by-capability under the locked Finance-First strategy.

## Finance-First Product Build Strategy

**Locked strategic direction (re-baseline, superseding the prior
"Finance Core → 3.x hardening → additional Finance capabilities"
sequencing below `docs/hardening/finance-functional-rebaseline-proposal.md`
recorded as the discovery basis for this change):** Sphere Finance is an
ERP-grade, complete finance suite, not the narrower Journal-Engine-only
scope the roadmap previously reflected. The existing Finance Core
(Chart of Accounts, Journal Engine, General Ledger — detailed below) is
the **foundation** of that suite, not the finished Finance product.

The build sequence is now:

```
COMPLETE FINANCE SUITE
        ↓
FINANCE-DEPENDENT OPERATIONS
        ↓
CROSS-MODULE INTEGRATION
        ↓
HARDENING / PRODUCTION READINESS
```

Full structure:

```
PHASE 1
│
├── SPHERE FINANCE — COMPLETE FINANCE SUITE
│   │
│   ├── Accounting Core                (COMPLETE — see below)
│   ├── Accounts Payable                (COMPLETE — functional AP surface implemented)
│   ├── Accounts Receivable             (COMPLETE — functional AR surface implemented)
│   ├── Invoicing / Billing             (COMPLETE within current AP/AR document surfaces; broader billing remains)
│   ├── Payments / Receipts             (COMPLETE for current AP/AR/banking payment and receipt surfaces)
│   ├── Banking / Reconciliation        (COMPLETE — Banking 1A–1E + Reconciliation)
│   ├── Cash Management                 (COMPLETE for current banking/cash surface)
│   ├── Expense Management              (PLANNED)
│   ├── Fixed Assets                    (PLANNED)
│   ├── Budgeting / Planning            (PLANNED)
│   ├── Tax / VAT                       (COMPLETE for the current MVP scope — Phase 1, 2, 3, 4 & 5 all COMPLETE; statutory filing/reverse charge/multi-jurisdiction deferred, see below)
│   ├── Multi-Currency                  (PLANNED)
│   ├── Financial Reporting             (PLANNED — beyond Trial Balance/GL, already COMPLETE)
│   ├── WIP / Accrual Engine            (PLANNED)
│   ├── Audit / Compliance              (PARTIAL — journal-level audit log COMPLETE; broader compliance PLANNED)
│   └── Advanced Finance & AI           (PLANNED)
│
├── FINANCE-DEPENDENT OPERATIONS
│   ├── Procurement
│   ├── Inventory
│   ├── CRM
│   ├── HRMS / Payroll
│   ├── Projects / WIP integrations
│   └── Other approved operational modules
│
├── CROSS-MODULE INTEGRATION
│   ├── Procurement → AP
│   ├── Sales / CRM → AR
│   ├── Inventory → COGS / GL
│   ├── HRMS → Payroll / GL
│   ├── Projects → WIP / Accruals
│   └── Banking → Cash / GL
│
└── HARDENING / PRODUCTION READINESS
    ├── Transaction / Concurrency        (Milestone 3.3, DEFERRED)
    ├── Accounting Integrity             (Milestone 3.4, DEFERRED)
    ├── Cross-module Integrity           (part of 3.4/3.5, DEFERRED)
    ├── Audit Integrity                  (part of 3.4, DEFERRED)
    └── Production Readiness             (Milestone 3.5, DEFERRED)
```

**Note on Expense Management:** previously listed as its own separate,
unscoped Phase 1 line item alongside Finance. Per this re-baseline it is
now explicitly locked as a Sphere Finance capability area (expense
claims, approvals, reimbursements, expense accounting, policy/limit
controls) — not removed, re-categorized, so it doesn't silently drop out
of the roadmap's history while also not double-counting it as a separate
product.

### Status legend (do not conflate these)

- **COMPLETE** — implemented and verified (real code, real e2e tests, confirmed against the actual repository).
- **IN PROGRESS** — currently being implemented.
- **PLANNED** — approved product scope, not yet implemented. Approved scope, per this locked re-baseline — not to be removed from the roadmap merely because it doesn't exist in code yet.
- **DEFERRED** — explicitly postponed, with a stated reason and re-entry condition.

### SPHERE FINANCE — Accounting Core — **COMPLETE** (the foundation, not the finished product)

- [x] 1b — Chart of Accounts service (`09dc04d`)
- [x] 2a — Chart of Accounts legal-entity retrofit (`bcf5b03`)
- [x] 2b — Journal Engine schema + DB layer: `journal_entries`/`journal_lines`, the deferred double-entry balance-invariant trigger, tenant-scoped DB client (`c8e165e`, review fixes in `15f044b`)
- [x] 2c-1 — Accounting periods + journal entry draft CRUD (`383004d`, concurrency-safe period close fix in `db83d69`)
- [x] 2c-2 — Posting, numbering + reversal (`9f9fb05`)
- [x] 2d — General Ledger read layer: ledger, account balance, and trial balance reports (`89ab0b4` proposal, `7fe3d56` implementation)
- [x] 2d follow-up — Read-consistency hardening: fixed a read-consistency issue where GL reports could return a torn snapshot under concurrent posting; GL reports now run in a `REPEATABLE READ`/read-only transaction, with adversarial concurrency tests proving the fix (`8ad9ea0`)

Covers: Chart of Accounts, Legal Entities, Accounting Periods, Journal
Entries (draft/edit/delete lifecycle), double-entry validation, Posting,
Journal Numbering, Reversal, General Ledger, Account Balances, Trial
Balance. All covered by unit and e2e tests. **This is functional
completeness for the Accounting Core only** — it is the foundation the
rest of the Finance suite builds on, not a completeness statement for
Sphere Finance as a product.

### SPHERE FINANCE — current functional status

**Accounts Payable — COMPLETE for the current approved AP surface.** Supplier master, supplier bills, supplier debit notes, AP settings, supplier payments, AP reports, posting, tax capture/posting foundation, immutability and regression coverage are implemented in `services/sphere-finance`.

**Accounts Receivable — COMPLETE for the current approved AR surface.** Customer master, customer invoices, customer credit notes, AR settings, receipts, AR reports, posting, tax capture/posting foundation, immutability and regression coverage are implemented in `services/sphere-finance`.

**Banking & Reconciliation — COMPLETE.** Bank accounts, transactions, reconciliation, payment-provider settlement/reconciliation surfaces, cash management, transfers and current cash-position reporting are implemented and verified. Banking 1A–1E and reconciliation are closed work items.

**Tax / VAT — COMPLETE for the current MVP scope (Phases 1-6); statutory/jurisdiction expansion deferred, see "Later" below.**

- [x] Phase 1 — Tax Configuration Foundation (`dd6d135`, pushed to `main`): Tax Code master, effective-dated Tax Rates, RLS, RBAC, audit, migration/constraint pipeline, configuration APIs and DB-level overlap protection.
- [x] Phase 2 — AP Tax Calculation (pushed to `main` — see `docs/work-items/tax-vat-phase-2-ap-tax-calculation/COMPLETION_REPORT.md`): wired `taxCodeId` and resolved/snapshotted rates into Supplier Bills and Supplier Debit Notes, preserving legacy manual-tax behavior when `taxCodeId` is omitted. Debit notes resolve tax independently per line by `debitNoteDate` (no inheritance from allocated bills — corrected from the originally-proposed Decision 1). Also fixed a pre-existing Phase 1 overlap pre-check bug (inclusive comparisons stricter than the real EXCLUDE constraint) discovered while verifying the half-open effective-date boundary.
- [x] Phase 3 — AR Tax Calculation (pushed to `main` — see `docs/work-items/tax-vat-phase-3-ar-tax-calculation/COMPLETION_REPORT.md`): wired `taxCodeId` and resolved/snapshotted rates into Customer Invoices and Customer Credit Notes, preserving legacy manual-tax behavior when `taxCodeId` is omitted. Credit notes resolve tax independently per line by `creditNoteDate` (no inheritance from allocated invoices — carrying forward Phase 2's confirmed no-inheritance correction). Reused Phase 1/Phase 2's tax-configuration infrastructure unmodified; no new tax-calculation logic.
- [x] Phase 4 — VAT Position Report (pushed to `main` — see `docs/work-items/tax-vat-phase-4-vat-position/COMPLETION_REPORT.md`): a new read-only `GET /tax-reports/vat-position` reports net output tax (Invoices net of Credit Notes), net input tax (Bills net of Debit Notes), and net VAT position, broken down by tax code/treatment with supply-value and calculated-vs-overridden visibility, plus an optional GL movement cross-check. Built on the four AP/AR tax line tables Phases 2/3 already wrote — not on `journal_lines`, which posts one aggregate tax line per document and cannot support a per-tax-code breakdown (confirmed by direct inspection of the posting code, `docs/work-items/tax-vat-phase-4-vat-position/DISCOVERY.md` §3.2). No schema change, no migration.
- [x] Phase 5 — Per-Tax-Code GL Account Mapping (committed to local `main` — see `docs/work-items/tax-vat-phase-5-gl-account-mapping/COMPLETION_REPORT.md` for exact SHA(s)/push status): optional nullable `tax_codes.ap_tax_account_id`/`ar_tax_account_id` overrides, resolved and snapshotted onto each tax-bearing line (`resolvedTaxAccountId`) at the existing `resolveLineTax()` DRAFT-time stage — never at `post()`, which remains read-only w.r.t. tax lines and relies on the pre-existing per-table immutability triggers (directly verified at the DB level) to protect the new column for free. Falls back to the existing AP/AR-settings singleton when no override is configured — 100% backward compatible (full pre-existing e2e suite passes unmodified). `post()` aggregates tax journal lines by distinct resolved account, preserving each document type's existing polarity, and enforces "every posted tax line has a deterministic accounting destination." VAT Position Report's GL cross-check gained an additive-only multi-account breakdown; the pre-existing 8 singleton fields are unchanged. New `PATCH /tax-codes/:id/gl-accounts` route (`finance.admin`).
- [x] Phase 6 — Manual Journal Tax Coverage (see `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/COMPLETION_REPORT.md`): optional nullable `journal_lines.tax_code_id`/`tax_direction`, for explicitly classifying a manually-posted (non-AP/AR) journal line's own debit/credit amount as tax — no calculation, direction never inferred. Validated at draft and independently re-validated at post time; reversal preserves classification. VAT Position Report headline (`outputTaxMinor`/`inputTaxMinor`) now includes classified manual tax, unified rather than a separate headline, with additive source-attribution fields.
- [ ] Later — statutory VAT filing formats, reverse charge, multi-jurisdiction expansion, and tax-inclusive pricing — deferred items from the approved architecture, restated in the Phase 4 discovery's own risk section (§10). Manually-posted tax journal entry coverage (formerly listed here) is now Phase 6, COMPLETE, above.

**Multi-Currency — PLANNED.** Currency master, exchange rates, conversion, foreign-currency transactions, realised FX, unrealised FX and revaluation remain deferred until a concrete multi-currency requirement is approved. The existing fixed `currencyCode` fields are not functional FX.

**Financial Reporting — Trial Balance, General Ledger, Profit & Loss, Balance Sheet, AP/AR ageing, AP/AR-to-GL reconciliation, supplier/customer statements and balances, and the VAT Position Report are all COMPLETE.** (Corrected 2026-09-11, Tax/VAT Phase 4 discovery §1: this paragraph previously read "Trial Balance and General Ledger reports are complete; broader P&L, Balance Sheet, ... remain planned" — that had gone stale relative to the actual repository, which already had `financial-statements`, `ap-reports`, and `ar-reports` fully implemented and e2e-verified before this phase began; corrected here rather than left to mislead the next reader.) Cash Flow and broader management reporting remain planned.

**WIP / Accruals — PLANNED.** WIP, accruals, deferrals, recognition, reversal and period-end processing remain future Finance capabilities.

**Audit & Compliance — PARTIAL.** Financial audit trail, immutable posted history and period controls exist; broader approval history, accounting integrity, compliance reporting and full source-to-GL traceability across all future sub-ledgers remain future work.

**Advanced Finance & AI — PLANNED.** None of the reserved AI capabilities are implemented yet.

### FINANCE-DEPENDENT OPERATIONS — PLANNED, sequenced after the Finance suite

Sphere Finance is intended to become the financial backbone for:
Procurement, Inventory, CRM, HRMS/Payroll, Projects, Expense workflows,
Contracts/DOA where applicable, and other approved Noryx products.

### CROSS-MODULE INTEGRATION — PLANNED, sequenced after both the Finance suite and its dependent operations exist

Procurement → AP, Sales/CRM → AR, Inventory → COGS/GL, HRMS → Payroll/GL,
Projects → WIP/Accruals, Banking → Cash/GL. Each integration depends on
both sides of the arrow existing first.

### SPHERE FINANCE — HARDENING & SECURITY AUDIT (Milestone 3)

Milestone 3.1 and 3.2 are completed, historical facts — not reopened or
rewritten by this re-baseline:

- [x] 3.1 — Tenant/RLS Hardening — completed (`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md`).
- [x] 3.2 — RBAC & Authorization Hardening — Work Items 1–8 and 10 implemented, verified, and pushed (latest: `d5d0bc5`); Work Item 9 (`TENANT_EXTERNAL` enforcement) and Work Item 11 (role-grant auditing) remain formally deferred pending the required future personas/user-management capability.
- [ ] 3.3 — Transaction & Concurrency Hardening — **DEFERRED until the complete Finance functional surface exists.**
- [ ] 3.4 — Accounting & Audit Integrity — **DEFERRED until the complete Finance functional surface exists.**
- [ ] 3.5 — Production-Readiness Audit — **DEFERRED until Finance and its dependent operational modules are sufficiently implemented.**

**Why 3.3–3.5 are deferred:** hardening transaction, accounting, audit,
and cross-module behavior against functionality that does not yet exist
would require repeating the same work as new posting patterns and audit
surfaces land. The correct strategy remains:

**BUILD → INTEGRATE → VERIFY FUNCTIONALLY → HARDEN → PRODUCTION READY**

### Sphere Finance Functionally Complete — the completion gate

Sphere Finance is **functionally complete** once all capability areas
locked in this Finance-First Product Build Strategy have, each:

- implemented backend/domain logic,
- required database structures,
- API coverage,
- accounting integration through the existing Journal Engine where applicable,
- appropriate e2e/functional tests,
- cross-module integration where applicable,
- required reporting,
- required auditability.

**This is functional completeness — explicitly distinct from security /
production hardening (Milestone 3.3–3.5, deferred above).**

## Not started (remaining Phase 1 scope, outside Sphere Finance)

- [ ] Procurement & Inventory
- [ ] Core CRM
- [ ] HRMS + Payroll + WPS
- [ ] Contract Management
- [ ] Rules/DOA Engine
- [ ] Orbis Helpdesk/WO
- [ ] Asset & Location
- [ ] PPM
- [ ] Field technician mobile app
