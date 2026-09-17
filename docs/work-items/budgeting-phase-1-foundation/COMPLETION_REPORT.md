# Implementation Completion Report: BUDGETING-PHASE-1-FOUNDATION

**Status:** IMPLEMENTED → VERIFIED → COMMITTED → REPORT_GENERATED → BUNDLE_GENERATED → BUNDLE_VERIFIED → **CTO_REVIEW**

## 1. Authorization and Baseline

- Authorized by: "NORYX CTO IMPLEMENTATION AUTHORIZATION" (this session).
- Approved specification: `docs/work-items/budgeting-phase-1-foundation/CONTRACT.md` (v6) and `ACCEPTANCE.md`, both CTO-approved as the implementation contract.
- **Approved baseline SHA:** `71964dc2863000741cae1a7278e0d824160c3105`
- **Implementation commit SHA:** `0b76882c3c6c4e651b27bbaf5d44a58addad276a` (device repo, branch `main`, not pushed)
- Fixed Assets (`feat/fixed-assets-phase-1`) was **not** used, merged, cherry-picked, rebased, copied from, or depended upon at any point. Confirmed by: (a) the implementation environment was a fresh `git clone` of the baseline SHA verified against GitHub via `git ls-remote`, containing no Fixed Assets code; (b) a repo-wide `find . -iname "*fixed-asset*"` and `ls services/sphere-finance/src/ | grep -i fixed` on the final implementation tree returned nothing; (c) `git branch -a | grep -i fixed` returned nothing in the implementation clone.

## 2. Files Changed (final commit `0b76882`)

19 files changed, 9589 insertions(+), 2 deletions(-):

**New:**

- `docs/work-items/budgeting-phase-1-foundation/ACCEPTANCE.md` (updated with actual execution results — see §8)
- `docs/work-items/budgeting-phase-1-foundation/CONTRACT.md` (the approved v6 specification, now committed alongside its implementation)
- `services/sphere-finance/drizzle/migrations/0023_budgeting_phase_1_foundation.sql`
- `services/sphere-finance/drizzle/migrations/meta/0023_snapshot.json`
- `services/sphere-finance/drizzle/rls/017_budgeting_rls.sql`
- `services/sphere-finance/src/budgeting/budgets.controller.ts`
- `services/sphere-finance/src/budgeting/budgets.service.ts`
- `services/sphere-finance/src/budgeting/budget-lines.controller.ts`
- `services/sphere-finance/src/budgeting/budget-lines.service.ts`
- `services/sphere-finance/src/budgeting/budgeting.module.ts`
- `services/sphere-finance/src/budgeting/dto/create-budget.dto.ts`
- `services/sphere-finance/src/budgeting/dto/update-budget.dto.ts`
- `services/sphere-finance/src/budgeting/dto/create-budget-line.dto.ts`
- `services/sphere-finance/src/budgeting/dto/update-budget-line.dto.ts`
- `services/sphere-finance/test/budgeting.e2e-spec.ts` (44 tests)

**Modified (all additive):**

- `services/sphere-finance/drizzle/migrations/meta/_journal.json` — one new entry for migration `0023`.
- `services/sphere-finance/src/app.module.ts` — `BudgetingModule` registered as a top-level sibling import.
- `services/sphere-finance/src/db/schema.ts` — `budgetStatusEnum`, `budgets`, `budgetLines` tables + types appended.
- `services/sphere-finance/src/route-role-matrix.spec.ts` — 10 new `EXPECTED` entries + the two new controllers added to `discoverRoutes(...)`.

No file outside this list was touched. No Fixed Assets, unrelated Finance module, unrelated controller, `apps/web`, or unrelated architecture/refactoring was modified.

## 3. Schema / Migration Summary

- New enum `budget_status` (`DRAFT`, `APPROVED`).
- New table `budgets`: `id, tenant_id, legal_entity_id, code varchar(32), name varchar(255), start_date, end_date, currency_code varchar(3), status, approved_at, approved_by, created_by, created_at, updated_at`. Unique `(tenant_id, legal_entity_id, code)`, index `(tenant_id, legal_entity_id)`, CHECK `end_date > start_date`.
- New table `budget_lines`: `id, tenant_id, legal_entity_id, budget_id FK→budgets, account_id FK→chart_of_accounts, period_id FK→accounting_periods, amount_minor bigint, created_at, updated_at`. Unique `(budget_id, account_id, period_id)`, indexes on `(tenant_id, legal_entity_id)` and `(budget_id)`, CHECK `amount_minor >= 0`.
- Migration `0023_budgeting_phase_1_foundation.sql` — confirmed as the correct next available number on the clean baseline (highest pre-existing was `0022`); no renumbering needed (the CONTRACT.md's flagged Fixed-Assets-`0023`-collision risk is moot — that branch is never touched).
- RLS `017_budgeting_rls.sql` — the correct next number (highest pre-existing was `016`); `ENABLE`+`FORCE ROW LEVEL SECURITY` and a tenant-scoped policy on both new tables, structurally identical to `016_tax_configuration_rls.sql`.
- **MIG-001** (fresh database): applied cleanly to a genuinely empty `noryx_migtest_fresh` (verified empty via `\dt` beforehand). Post-migration, both tables, all constraints/FKs, and `FORCE ROW LEVEL SECURITY` were confirmed present via `\d budgets`/`\d budget_lines` and a direct `pg_class.relforcerowsecurity` query. **PASS.**
- **MIG-002** (seeded database): applied cleanly to `noryx_migtest_seeded`, pre-populated with 1 real tenant/legal-entity/chart-of-accounts/accounting-period row (confirmed present before migration). Post-migration: the same 4 pre-existing rows were confirmed unchanged (no data loss), the `budgets` table did not previously exist, and a real `INSERT` into `budgets`/`budget_lines` referencing the pre-existing seed rows (real FK targets) succeeded. **PASS.**

## 4. API Summary (10 routes)

| Method | Route                                     | Roles                                               |
| ------ | ----------------------------------------- | --------------------------------------------------- |
| POST   | `/v1/finance/budgets`                     | `finance.admin`                                     |
| GET    | `/v1/finance/budgets`                     | `finance.viewer`, `finance.poster`, `finance.admin` |
| GET    | `/v1/finance/budgets/:id`                 | `finance.viewer`, `finance.poster`, `finance.admin` |
| PATCH  | `/v1/finance/budgets/:id`                 | `finance.admin`                                     |
| POST   | `/v1/finance/budgets/:id/approve`         | `finance.admin`                                     |
| POST   | `/v1/finance/budgets/:budgetId/lines`     | `finance.poster`, `finance.admin`                   |
| GET    | `/v1/finance/budgets/:budgetId/lines`     | `finance.viewer`, `finance.poster`, `finance.admin` |
| GET    | `/v1/finance/budgets/:budgetId/lines/:id` | `finance.viewer`, `finance.poster`, `finance.admin` |
| PATCH  | `/v1/finance/budgets/:budgetId/lines/:id` | `finance.poster`, `finance.admin`                   |
| DELETE | `/v1/finance/budgets/:budgetId/lines/:id` | `finance.poster`, `finance.admin`                   |

`currencyCode` is never a client-writable field (server-resolved from the legal entity, enforced by `whitelist:true`/`forbidNonWhitelisted:true`). `tenantId`/`legalEntityId` always come from the verified JWT.

## 5. Security / RLS / RBAC Summary

- Tenant isolation: RLS tenant-scoped policy (`FORCE ROW LEVEL SECURITY`) on both tables, proven with a raw-SQL query against the **non-superuser `noryx_app`** role (RLS-003) — zero of tenant A's rows returned when `app.current_tenant_id` is set to tenant B, and a positive control confirmed the same role _does_ see the rows under tenant A's own context (proving the zero-result is RLS filtering, not an empty table).
- Legal-entity isolation: enforced explicitly in every service-layer `WHERE` predicate (never delegated to RLS, per repo convention) — proven via RLS-001 (a second legal entity in the same tenant gets 404 on direct GET, absent from list).
- RBAC: `route-role-matrix.spec.ts` extended with the 10 routes above; **157/157** tests pass, including the exhaustive "never classifies a route as unrecognized" check (RBAC-005). RBAC-001..004 (viewer/poster/admin/no-token) proven end-to-end via the e2e suite.

## 6. Concurrency Implementation Summary

All five state-changing operations (`BudgetsService.approve()`, `BudgetsService.update()`, `BudgetLinesService.create()`/`update()`/`delete()`) open a transaction whose **first** statement is `SELECT ... FOR UPDATE` on the target `budgets.id` row (line mutations lock the **parent** budget row via `BudgetsService.findByIdInTx(tx, ..., { forUpdate: true })`, never the child row). All business validation happens after the lock is acquired; the mutation happens while the lock is held; commit/rollback is atomic (`withTenant`, no `txConfig` override — default `READ COMMITTED`, matching the codebase-wide convention). No database triggers were introduced.

Verified genuinely, not by inspection, via real concurrent PostgreSQL 16 transactions:

- **BUD-051** (approve vs. final-line delete): 20 real `Promise.all` trials. Both Case A (approve wins the lock: 10/20) and Case B (delete wins: 10/20) were actually observed. The forbidden state (`APPROVED` + zero lines) never occurred on any iteration.
- **BUD-052** (header date-narrowing PATCH vs. a concurrent line create only valid under the old dates): 15 trials, both orderings observed (PATCH won 5/15, line create won 10/15), the aggregate was consistent on every iteration.
- **BUD-052b** (header PATCH vs. approve()): 15 trials, both orderings observed; the loser always correctly re-reads the winner's committed state (never a stale read).
- **BUD-053** (sequential): an invalidating date-change PATCH is rejected 422 with zero mutation (including the unrelated `name` field in the same payload), and the inverse valid-boundary PATCH succeeds normally.
- **CONC-001/CONC-002**: duplicate-code and duplicate-line-key races each produce exactly one 201 and one 409, never two persisted rows.

## 7. Tests Executed

| Suite                                                                                    | Result                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `test/budgeting.e2e-spec.ts` (new)                                                       | **44/44 PASS**                                                                           |
| `src/route-role-matrix.spec.ts` (RBAC-005)                                               | **157/157 PASS**                                                                         |
| Full pre-existing unit suite (`npx jest`)                                                | **630/630 PASS**                                                                         |
| Full e2e suite (`npx jest --config jest-e2e.config.js`, includes the new Budgeting spec) | **1131/1131 PASS** (1087 pre-existing + 44 new)                                          |
| `tsc --noEmit`                                                                           | Clean, 0 errors                                                                          |
| `eslint src --ext .ts` (repo's actual lint script scope)                                 | Clean, 0 errors (10 pre-existing warnings, all in files never touched by this work item) |
| `nest build`                                                                             | Clean                                                                                    |
| MIG-001 (fresh)                                                                          | PASS (see §3)                                                                            |
| MIG-002 (seeded)                                                                         | PASS (see §3)                                                                            |

All of the above were re-run a second time against the **exact bytes of the final committed commit** `0b76882` (after the device repo's pre-commit hook ran `prettier --write`/`eslint --fix`, which reformatted whitespace only — confirmed by diffing every touched file and finding zero semantic changes) to ensure the verified state and the committed state are identical, not merely similar.

## 8. Acceptance Matrix Results

**All 50 scenarios executed and PASS.** `docs/work-items/budgeting-phase-1-foundation/ACCEPTANCE.md` has been updated in place with real per-scenario `PASS` statuses (never inferred from code inspection) and is included in the commit. Total: **PASS 50 / FAIL 0 / NOT EXECUTED 0 / BLOCKED 0.**

Breakdown: Header CRUD (BUD-001..009) 9/9, Line CRUD (BUD-020..029) 10/10, RLS (RLS-001..003) 3/3, RBAC (RBAC-001..005) 5/5, DB Invariants (DB-001..005) 5/5, Concurrency (CONC-001/002) 2/2, Migration (MIG-001/002) 2/2, Regression (REG-001..005) 5/5, Accounting Invariant (BUD-045) 1/1, CTO Amendment B/C/D (BUD-046..050) 5/5, CTO Concurrency v3 (BUD-051) 1/1, CTO Concurrency v4 (BUD-052/053) 2/2.

## 9. Regression Results

Zero regressions. Full pre-existing unit suite: 630/630. Full pre-existing e2e suite: 1087/1087 (verified as part of the combined 1131/1131 full-suite run, i.e. 1131 − 44 new Budgeting tests = 1087, matching the pre-Budgeting baseline exactly). Typecheck, lint, and build all clean.

## 10. Blocked Scenarios

**None.** All 50 acceptance scenarios were executed and passed; nothing is BLOCKED.

## 11. Self-Review Performed

A full audit was performed across all 30 dimensions listed in the implementation authorization (schema correctness, migration correctness/ordering, RLS correctness, tenant isolation, legal-entity isolation, RBAC/route coverage, DTO/input validation, service-layer business invariants, all five parent-row locking paths, transaction boundaries, READ COMMITTED assumptions, the approve-vs-final-line-delete race, the header-PATCH-vs-line-mutation race, the date-range-mutation-vs-existing-line-containment race, approved-budget immutability, concurrent uniqueness behavior, FK behavior, DB CHECK constraints, absence of GL/journal writes, regression impact, type correctness, lint correctness, build correctness, E2E correctness, migration fresh-database behavior, migration seeded-database behavior, acceptance-matrix coverage, scope compliance, governance compliance, and git cleanliness/final diff), performed both by direct source-code re-reading against the contract's pseudocode/interleaving proofs and by actually executing the corresponding tests against real PostgreSQL — never by inspection alone.

### Defects found and fixed during self-review

1. **Missing `@HttpCode(200)` on `BudgetsController.approve()`.** NestJS defaults a bare `@Post()` route to `201 Created`; every other action-style POST route in this codebase that mutates an existing resource (journal-entries post/reverse, supplier-bills/supplier-payments approve/post, bank-reconciliation match routes, scheduled-reversals, etc.) explicitly overrides this with `@HttpCode(200)`. `approve()` was missing this decorator — a genuine implementation defect, not a test artifact, confirmed by grepping the established repo-wide convention across every other controller. **Fixed** by adding `@HttpCode(200)` with an explanatory comment.
2. **`BUD-052b`'s original premise was incorrect.** The first draft asserted a name-only header PATCH never conflicts with `approve()` and both always succeed regardless of lock order. This directly contradicts `BUD-006`'s own established invariant (the entire header, not just `start_date`/`end_date`/`code`, becomes immutable once `APPROVED` — confirmed by re-reading the contract's §9/§10 language and cross-checking against the already-passing `BUD-006` test). **Fixed** by rewriting the scenario to assert the actually-correct Case C/D serialization behavior: whichever operation locks first commits normally; a PATCH that loses the race correctly observes `APPROVED` and is rejected 409 (never a stale read); `approve()` always succeeds regardless of order (the PATCH never removes the required line). Both defects were caught by running the tests, not by inspection.
3. **`createBudget`/`createLine` e2e test helpers were declared `async`**, which unwraps supertest's chainable `Test` object (which extends `Promise<Response>` but also carries `.expect()`) down to a plain `Promise<Response>`, silently breaking `.expect()` at every call site. **Fixed** by removing the unnecessary `async` (the function bodies had no `await`), restoring chainability.
4. **`CONC-002`'s test budget used the wrong date range** for the period it referenced (`periodA1_2023Id`, 2023, against a default 2021 budget), causing a spurious `400` (Decision C violation) at both concurrent requests instead of exercising the intended `409`-duplicate race. **Fixed** by creating the test's budget with matching 2023 dates.
5. **A leftover placeholder/dead-code block** in the `BUD-045` test (`financeDb.execute(undefined as any)`) would have thrown at runtime. **Fixed** by removing it — the real `before`/`after` row-count comparison immediately following it was unaffected.
6. Two bugs were self-caught and fixed during the initial implementation pass, before any test was run: a dead/no-op filter block in `BudgetsService.update()`'s date-revalidation logic, and a misleadingly-named row-existence check in `BudgetsService.approve()` (labeled as a "count" but not actually one) — both were rewritten for clarity and correctness before typecheck/build were first run.
7. A nonexistent `.toBadRequest()` chained method call (invented in error, never a real NestJS API) was used for the Decision C rejection in `BudgetLinesService`'s `create()`/`update()` — caught while re-reading the just-written file, fixed by importing and throwing a plain `BadRequestException`.

No defect found required a new product decision, a change to CTO Decision A/B/C/D, a material architecture change, a scope expansion, a new external dependency, or a change to an approved invariant — every fix was an ordinary implementation correction within the approved scope, per the self-correction authorization.

## 12. Final Git Status

Device repo (`main`, authoritative): clean at commit `0b76882c3c6c4e651b27bbaf5d44a58addad276a`, one commit ahead of the approved baseline `71964dc`. `git status --short` shows nothing outstanding for this work item (the only untracked entry, `services/sphere-finance/_to_delete/`, is pre-existing, unrelated cleanup debris from a prior session, untouched by and out of scope for this work item).

## 13. Confirmations

- **Fixed Assets was not touched.** No file under any Fixed-Assets path exists anywhere in the implementation tree or the final commit; the isolated `feat/fixed-assets-phase-1` branch was never fetched, merged, cherry-picked, rebased from, or read.
- **No unrelated scope was implemented.** The final commit touches exactly the 19 files listed in §2, all within `services/sphere-finance` and this work item's own `docs/work-items/budgeting-phase-1-foundation/` folder. No change to `apps/web`, no unrelated controller, no unrelated refactor.
- The implementation matches the approved v6 contract exactly: CTO Decisions A/B/C/D as specified, the parent-budget-row `SELECT ... FOR UPDATE` locking model exactly as specified (no weaker SELECT-then-write pattern, no database triggers), `READ COMMITTED` preserved, zero GL/journal writes (BUD-045), RBAC per the §7 route table, tenant/legal-entity isolation per §9/§10.
- Acceptance statuses in `ACCEPTANCE.md` accurately reflect actual execution (all 50 scenarios genuinely run against real PostgreSQL 16, never inferred).

## 14. Artifacts

- **Completion report:** `docs/work-items/budgeting-phase-1-foundation/COMPLETION_REPORT.md` (this file, committed on the device repo).
- **Verified Git bundle:** `~/Downloads/noryx-platform_budgeting-phase-1-foundation_20260917_0b76882.bundle` — `git bundle verify` OK, `git bundle list-heads` confirms `0b76882c3c6c4e651b27bbaf5d44a58addad276a HEAD`, and an independent fetch into a fresh repository (after fetching the baseline commit from GitHub) successfully retrieved the commit with the full, correct 19-file diff and content spot-checks.
- **Not pushed to any remote**, per instruction.

---

## Governance State

```
IMPLEMENTED → VERIFIED → COMMITTED → REPORT_GENERATED → BUNDLE_GENERATED → BUNDLE_VERIFIED → CTO_REVIEW
```

STOP at CTO REVIEW. No push performed. Antigravity not authorized. No new work item started. No further authorization inferred.
