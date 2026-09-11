# Roadmap

Condensed from the _Pre-Development Readiness Review_ §6. Full scope,
exit criteria, and indicative durations live in that document — this is
just a status tracker for the repo.

## Current execution status — 2026-09-11

**Current baseline:** `main` = `dd6d135` — Tax/VAT Phase 1 (Tax Configuration Foundation) is implemented, verified, and pushed to GitHub.

**Completed immediately before Tax/VAT:** Banking 1A–1E, Banking Reconciliation, and Scheduled Reversal are treated as complete per the governing Finance baseline.

**Current work item:** Tax/VAT.

**Tax/VAT Phase 1 — COMPLETE:** Tax Code master, effective-dated Tax Rate master, tenant/RLS isolation, RBAC, audit logging, database-level rate-overlap protection, migration-pipeline wiring, and configuration APIs. Verified with the Phase 1 regression/e2e suite and pushed as `dd6d135`.

**Next approved work item:** **Tax/VAT Phase 2 — AP Tax Calculation.** This phase wires the approved Tax Code/Rate model into Supplier Bills and Supplier Debit Notes. It must preserve legacy `taxAmountMinor` behavior when `taxCodeId` is omitted and implement the approved rate-resolution, line-level rounding, snapshot, and override semantics. It does not authorize AR wiring or the VAT report; those remain later phases.

**Execution gate:** Phase 2 implementation starts only after a separate CTO authorization/implementation prompt. FX remains deferred and is not the next item.

| Phase                             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Phase 0 — Foundation**          | Monorepo, CI/CD security gates, tenant/legal-entity schema + RLS, Identity (auth, MFA, tenant-aware JWTs), API Gateway (module-manifest routing), design system + web shell, Subscription & Entitlement schema                                                                                                                                                                                                                                                                                                                              | **In progress** — see below |
| **Phase 1 — Sphere & Orbis Core** | **Sphere Finance — complete finance suite** (Accounting Core, AP, AR, Invoicing/Billing, Payments/Receipts, Banking & Reconciliation, Cash Management, Expense Management, Fixed Assets, Budgeting/Planning, Tax/VAT, Multi-Currency, Financial Reporting, WIP/Accruals, Audit & Compliance, Advanced Finance/AI — see "Finance-First Product Build Strategy" below), Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Contract Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, field technician mobile app | **In progress** — Finance functional build is active |
| **Phase 2 — Core hardening**      | SLA & Command Centre, Master Data Hub governance UI, Reporting & BI foundation, Notifications, Document/e-Sign registry                                                                                                                                                                                                                                                                                                                                                                                                                     | Not started                 |
| **Phase 3 — Service Business**    | Service Project/job-costing, Customer Portal v1 (read-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not started                 |
| **Phase 4 — Intelligence**        | Persona dashboards, Orbis Command Centre recommendations, financial intelligence aggregations                                                                                                                                                                                                                                                                                                                                                                                                                                               | Not started                 |
| **Phase 5 — Ecosystem**           | Public API productization, Supplier Portal, document OCR/AI extraction, remaining persona mobile apps                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not started                 |
| **Future**                        | Embedded AI, ESG contribution, full multi-company activation, Workflow & Automation Studio, on-prem/dedicated deployment tier                                                                                                                                                                                                                                                                                                                                                                                                               | Named, not scheduled        |

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
│   ├── Tax / VAT                       (IN PROGRESS — Phase 1 COMPLETE; Phase 2 AP Tax Calculation NEXT)
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

**Tax / VAT — IN PROGRESS.**

- [x] Phase 1 — Tax Configuration Foundation (`dd6d135`, pushed to `main`): Tax Code master, effective-dated Tax Rates, RLS, RBAC, audit, migration/constraint pipeline, configuration APIs and DB-level overlap protection.
- [ ] Phase 2 — AP Tax Calculation: wire `taxCodeId` and resolved/snapshotted rates into Supplier Bills and Supplier Debit Notes, preserving legacy manual-tax behavior when `taxCodeId` is omitted.
- [ ] Phase 3 — AR Tax Calculation: wire the approved tax model into Customer Invoices and Customer Credit Notes.
- [ ] Phase 4 — VAT Position Report: internal VAT reconciliation/reporting built on the existing GL read layer.
- [ ] Later — statutory VAT filing formats, reverse charge, per-tax-code GL account mapping, multi-jurisdiction expansion, tax-inclusive pricing and other deferred items from the approved architecture.

**Multi-Currency — PLANNED.** Currency master, exchange rates, conversion, foreign-currency transactions, realised FX, unrealised FX and revaluation remain deferred until a concrete multi-currency requirement is approved. The existing fixed `currencyCode` fields are not functional FX.

**Financial Reporting — PARTIAL.** Trial Balance and General Ledger reports are complete; broader P&L, Balance Sheet, Cash Flow, account statements, AP/AR ageing and management reporting remain planned.

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
