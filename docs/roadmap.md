# Roadmap

Condensed from the _Pre-Development Readiness Review_ §6. Full scope,
exit criteria, and indicative durations live in that document — this is
just a status tracker for the repo.

| Phase                             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Phase 0 — Foundation**          | Monorepo, CI/CD security gates, tenant/legal-entity schema + RLS, Identity (auth, MFA, tenant-aware JWTs), API Gateway (module-manifest routing), design system + web shell, Subscription & Entitlement schema                                                                                                                                                                                                                                                                                                                              | **In progress** — see below |
| **Phase 1 — Sphere & Orbis Core** | **Sphere Finance — complete finance suite** (Accounting Core, AP, AR, Invoicing/Billing, Payments/Receipts, Banking & Reconciliation, Cash Management, Expense Management, Fixed Assets, Budgeting/Planning, Tax/VAT, Multi-Currency, Financial Reporting, WIP/Accruals, Audit & Compliance, Advanced Finance/AI — see "Finance-First Product Build Strategy" below), Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Contract Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, field technician mobile app | **In progress** — see below |
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
and the field technician mobile app. Of that scope, only a foundational
slice of **Sphere Finance** has been built so far, inside
`services/sphere-finance` — see "Finance-First Product Build Strategy"
immediately below for what that foundation is, and what the rest of the
locked Finance product scope is.

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
│   ├── Accounts Payable                (PLANNED)
│   ├── Accounts Receivable             (PLANNED)
│   ├── Invoicing / Billing             (PLANNED)
│   ├── Payments / Receipts             (PLANNED)
│   ├── Banking / Reconciliation        (PLANNED)
│   ├── Cash Management                 (PLANNED)
│   ├── Expense Management              (PLANNED)
│   ├── Fixed Assets                    (PLANNED)
│   ├── Budgeting / Planning            (PLANNED)
│   ├── Tax / VAT                       (PLANNED)
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
- [x] 2b — Journal Engine schema + DB layer: `journal_entries`/`journal_lines`,
      the deferred double-entry balance-invariant trigger, tenant-scoped DB
      client (`c8e165e`, review fixes in `15f044b`)
- [x] 2c-1 — Accounting periods + journal entry draft CRUD (`383004d`,
      concurrency-safe period close fix in `db83d69`)
- [x] 2c-2 — Posting, numbering + reversal (`9f9fb05`)
- [x] 2d — General Ledger read layer: ledger, account balance, and trial
      balance reports (`89ab0b4` proposal, `7fe3d56` implementation)
- [x] 2d follow-up — Read-consistency hardening: fixed a read-consistency
      issue where GL reports could return a torn snapshot under concurrent
      posting; GL reports now run in a `REPEATABLE READ`/read-only
      transaction, with adversarial concurrency tests proving the fix
      (`8ad9ea0`)

Covers: Chart of Accounts, Legal Entities, Accounting Periods, Journal
Entries (draft/edit/delete lifecycle), double-entry validation, Posting,
Journal Numbering, Reversal, General Ledger, Account Balances, Trial
Balance. All covered by unit and e2e tests (165 e2e cases across 8 spec
files as of `d0e04a5`), typecheck, lint, and build, verified against the
actual `main` branch on GitHub, not just local state. **This is
functional completeness for the Accounting Core only** — it is the
foundation the rest of the Finance suite below builds on, not a
completeness statement for Sphere Finance as a product.

### SPHERE FINANCE — remaining locked scope — **PLANNED** (not implemented; approved scope per this re-baseline)

**Accounts Payable** — [ ] Supplier master, [ ] Supplier bills, [ ] Purchase invoices, [ ] AP workflows, [ ] Payment processing, [ ] Payment allocation, [ ] AP ageing, [ ] AP reporting.

**Accounts Receivable** — [ ] Customer master, [ ] Customer invoices, [ ] AR workflows, [ ] Receipts, [ ] Receipt allocation, [ ] AR ageing, [ ] AR reporting.

**Invoicing / Billing** — [ ] Customer invoicing, [ ] Supplier billing, [ ] Credit/debit notes, [ ] Invoice lifecycle, [ ] Invoice-to-accounting integration.

**Banking & Cash** — [ ] Bank accounts, [ ] Bank transactions, [ ] Bank reconciliation, [ ] UPI/card/bank payment reconciliation where applicable, [ ] Cash management, [ ] Cash receipts, [ ] Cash payments, [ ] Bank transfers, [ ] Cash position.

**Expense Management** — [ ] Expense claims, [ ] Expense approvals, [ ] Reimbursements, [ ] Expense accounting, [ ] Policy/limit controls where appropriate.

**Fixed Assets** — [ ] Asset register, [ ] Acquisition, [ ] Capitalisation, [ ] Depreciation, [ ] Disposal, [ ] Transfer, [ ] Asset accounting.

**Budgeting & Planning** — [ ] Budgets, [ ] Forecasts, [ ] Budget controls, [ ] Budget vs actual, [ ] Variance analysis.

**Tax** — [ ] Tax configuration, [ ] VAT, [ ] Tax calculation, [ ] Tax posting, [ ] Tax reporting, [ ] Tax compliance support, [ ] India/GCC-relevant tax architecture where applicable.

**Multi-Currency** — [ ] Currency master, [ ] Exchange rates, [ ] Currency conversion, [ ] Foreign-currency transactions, [ ] Realised FX, [ ] Unrealised FX, [ ] FX revaluation. (A single fixed, non-convertible `currencyCode` column exists on `journal_entries` today as a documented future extension point — not functional multi-currency.)

**Financial Reporting** — [ ] Profit & Loss, [ ] Balance Sheet, [ ] Cash Flow, [x] Trial Balance, [x] General Ledger reports, [ ] Account statements, [ ] AP/AR ageing reports, [ ] Management reporting, [ ] Consolidated reporting where applicable. (Trial Balance and General Ledger reports are already COMPLETE, part of the Accounting Core above — listed here too so the full Financial Reporting capability area isn't read as entirely unbuilt.)

**WIP / Accruals** — [ ] WIP, [ ] Accruals, [ ] Deferrals, [ ] Recognition, [ ] Reversal, [ ] Period-end processing. (This is the one item in this list that was already named in the roadmap's prior version, repeatedly, as remaining Phase 1 scope — see `docs/hardening/finance-functional-rebaseline-proposal.md` §4 for the discovery record.)

**Audit & Compliance** — [x] Financial audit trail (journal/period/CoA mutations — same `audit_logs` table and pattern used across sphere-finance today), [x] Immutable posted financial history (DB-trigger-enforced on `journal_entries`/`journal_lines`), [ ] Approval history (beyond DRAFT→POSTED), [x] Period controls (open/close, overlap prevention), [ ] Accounting integrity (broader than what Milestone 3.4 will harden), [ ] Compliance reporting, [ ] Traceability from source transaction → accounting entry → GL/report (partially true today for journal entries themselves; not yet true once AP/AR/Invoicing exist as separate source transactions).

**Advanced Finance & AI** — [ ] AI transaction classification, [ ] AI-assisted reconciliation, [ ] AI anomaly/fraud detection, [ ] AI cash-flow forecasting, [ ] AI financial insights, [ ] AI variance explanations, [ ] AI invoice/bill/document extraction, [ ] AI-assisted accounting suggestions, [ ] Finance Copilot / natural-language finance analysis, [ ] intelligent forecasting and decision support. **None of this is implemented — reserved scope only**, so NoryX Finance is explicitly understood to be more than a basic bookkeeping system as the rest of the suite lands.

### FINANCE-DEPENDENT OPERATIONS — PLANNED, sequenced after the Finance suite

Sphere Finance is intended to become the financial backbone for:
Procurement, Inventory, CRM, HRMS/Payroll, Projects, Expense workflows,
Contracts/DOA where applicable, and other approved NoryX products —
these remain listed in the "Not started (remaining Phase 1 scope)"
section below, unchanged, since none of these product families are
being removed or re-scoped by this re-baseline.

### CROSS-MODULE INTEGRATION — PLANNED, sequenced after both the Finance suite and its dependent operations exist

Procurement → AP, Sales/CRM → AR, Inventory → COGS/GL, HRMS →
Payroll/GL, Projects → WIP/Accruals, Banking → Cash/GL. Not yet
designed — each of these integration points depends on both sides of
the arrow existing first.

### SPHERE FINANCE — HARDENING & SECURITY AUDIT (Milestone 3)

Milestone 3.1 and 3.2 are completed, historical facts — not reopened or
rewritten by this re-baseline:

- [x] 3.1 — Tenant/RLS Hardening — completed (`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md`).
- [x] 3.2 — RBAC & Authorization Hardening — Work Items 1–8 and 10
      implemented, verified, and pushed (latest: `d5d0bc5`); Work Item 9
      (`TENANT_EXTERNAL` enforcement) and Work Item 11 (role-grant
      auditing) **remain formally deferred** — historical facts, not
      active next tasks — pending, respectively, a defined
      `TENANT_EXTERNAL` persona/policy and a future user-management/
      role-assignment capability that does not yet exist. See
      `docs/hardening/milestone-3.2-closure-report.md`.
- [ ] 3.3 — Transaction & Concurrency Hardening — **DEFERRED until the complete Finance functional surface exists.**
- [ ] 3.4 — Accounting & Audit Integrity — **DEFERRED until the complete Finance functional surface exists.**
- [ ] 3.5 — Production-Readiness Audit — **DEFERRED until Finance and its dependent operational modules are sufficiently implemented.**

**Why 3.3–3.5 are deferred, not merely postponed without reason:** we
cannot meaningfully harden transaction, accounting, audit, and
cross-module behavior across functionality that does not yet exist. AP,
AR, Invoicing, Payments, Banking, WIP/Accruals, and the rest of the
locked Finance scope above will very likely introduce new posting
patterns, new concurrency interactions, and new audit event types on top
of the Accounting Core's existing surface — hardening now, then again
after each of those lands, means doing the same work twice against a
moving target. The correct strategy is:

**BUILD → INTEGRATE → VERIFY FUNCTIONALLY → HARDEN → PRODUCTION READY**

not:

**BUILD SMALL FOUNDATION → HARDEN → BUILD MORE → HARDEN AGAIN.**

This reverses this document's own prior statement — "Additional Finance
capabilities (e.g. WIP Accrual Engine) are not to begin until Milestone
3 passes its review gates" — which is recorded here for the historical
record, not silently deleted. That statement reflected the
Journal-Engine-scoped view of Finance; it does not hold once Sphere
Finance is understood as the complete suite this re-baseline locks in.

### Sphere Finance Functionally Complete — the completion gate

Sphere Finance is **functionally complete** once all capability areas
locked in this Finance-First Product Build Strategy have, each:

- implemented backend/domain logic,
- required database structures,
- API coverage,
- accounting integration (posts through the existing Journal Engine
  where applicable, not a parallel posting mechanism),
- appropriate e2e/functional tests (matching the rigor already
  established by the Accounting Core's 165-case suite),
- cross-module integration where applicable,
- required reporting,
- required auditability.

**This is functional completeness — explicitly distinct from
security/production hardening (Milestone 3.3–3.5, deferred above).** A
capability area can be functionally complete and still be
production-hardened later; the two are not conflated anywhere in this
document.

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
