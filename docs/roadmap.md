# Roadmap

Condensed from the _Pre-Development Readiness Review_ §6. Full scope,
exit criteria, and indicative durations live in that document — this is
just a status tracker for the repo.

| Phase                             | Scope                                                                                                                                                                                                                   | Status                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Phase 0 — Foundation**          | Monorepo, CI/CD security gates, tenant/legal-entity schema + RLS, Identity (auth, MFA, tenant-aware JWTs), API Gateway (module-manifest routing), design system + web shell, Subscription & Entitlement schema          | **In progress** — see below |
| **Phase 1 — Sphere & Orbis Core** | Finance + WIP Accrual Engine, Procurement & Inventory, core CRM, HRMS + Payroll + WPS, Expense Management, Contract Management, Rules/DOA Engine, Orbis Helpdesk/WO, Asset & Location, PPM, field technician mobile app | Not started                 |
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
