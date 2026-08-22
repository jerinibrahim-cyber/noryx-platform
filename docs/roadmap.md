# Roadmap

Condensed from the _Pre-Development Readiness Review_ §6. Full scope,
exit criteria, and indicative durations live in that document — this is
just a status tracker for the repo.

| Phase                             | Scope                                                                                                                                                                                                                   | Status                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Phase 0 — Foundation**          | Monorepo, CI/CD security gates, tenant/legal-entity schema + RLS, Identity (auth, MFA, tenant-aware JWTs), API Gateway (module-manifest routing), design system + web shell, Subscription & Entitlement schema          | **In progress** — see below |
| **Phase 1 — Sphere & Orbis Core** | Finance + WIP Accrual Engine, Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Expense Management, Contract Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, field technician mobile app | **In progress** — see below |
| **Phase 2 — Core hardening**      | SLA & Command Centre, Master Data Hub governance UI, Reporting & BI foundation, Notifications, Document/e-Sign registry                                                                                                 | Not started                 |
| **Phase 3 — Service Business**    | Service Project/job-costing, Customer Portal v1 (read-only)                                                                                                                                                             | Not started                 |
| **Phase 4 — Intelligence**        | Persona dashboards, Orbis Command Centre recommendations, financial intelligence aggregations                                                                                                                           | Not started                 |
| **Phase 5 — Ecosystem**           | Public API productization, Supplier Portal, document OCR/AI extraction, remaining persona mobile apps                                                                                                                   | Not started                 |
| **Future**                        | Embedded AI, ESG contribution, full multi-company activation, Workflow & Automation Studio, on-prem/dedicated deployment tier                                                                                           | Named, not scheduled        |

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

Phase 1 covers Finance + WIP Accrual Engine, Procurement & Inventory, core
CRM, HRMS + Payroll + WPS, Expense Management, Contract Management,
Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, and the field
technician mobile app. Of that scope, only **Finance Core** has been
built so far, inside `services/sphere-finance`.

**FINANCE CORE — FUNCTIONAL BUILD COMPLETE (Milestone 1b, 2a–2d)**

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

All of the above is covered by unit and e2e tests (including the
concurrency regression suite), typecheck, lint, and build, and has been
verified against the actual `main` branch on GitHub, not just local state.
This is a functional-completeness statement, not a production-readiness
one — see the hardening milestone below.

**FINANCE CORE — HARDENING & SECURITY AUDIT — PLANNED (Milestone 3)**

Before any further Finance capability is built on top of it, Finance Core
goes through a dedicated hardening and security audit milestone. This is
scoped and tracked separately from the functional build above:

- [ ] 3.1 — Tenant/RLS Hardening
- [ ] 3.2 — RBAC & Authorization Hardening
- [ ] 3.3 — Transaction & Concurrency Hardening
- [ ] 3.4 — Accounting & Audit Integrity
- [ ] 3.5 — Production-Readiness Audit

**Additional Finance capabilities (e.g. WIP Accrual Engine) are not to
begin until Milestone 3 passes its review gates.** The intended lifecycle
for Finance Core is:

Functional build → Verification → Hardening/Security Audit →
Production-readiness gate → Future expansion

Finance Core is currently at the end of "Verification" and about to enter
"Hardening/Security Audit." It is functionally complete but not yet
production-hardened.

**Not started (remaining Phase 1 scope)**

- [ ] WIP Accrual Engine
- [ ] Procurement & Inventory
- [ ] Core CRM
- [ ] HRMS + Payroll + WPS
- [ ] Expense Management
- [ ] Contract Management
- [ ] Rules/DOA Engine
- [ ] Orbis Helpdesk/WO
- [ ] Asset & Location
- [ ] PPM
- [ ] Field technician mobile app
