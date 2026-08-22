# Finance Core — Milestone 3: Hardening & Security Audit Proposal

**Status: PROPOSAL FOR REVIEW — NO IMPLEMENTATION AUTHORIZED YET.**

Finance Core is now implemented through 2d and the 2d read-consistency follow-up:

- 2a — Chart of Accounts tenant + legal-entity retrofit — closed (`bcf5b03`).
- 2b — Journal Engine schema/database layer — closed (`c8e165e`, `15f044b`).
- 2c-1 — Accounting periods + journal draft CRUD — closed (`383004d`, `db83d69`).
- 2c-2 — Posting, numbering, reversal — closed (`9f9fb05`).
- 2d — General Ledger read layer — closed (`89ab0b4`, `7fe3d56`).
- 2d follow-up — repeatable-read report consistency + shared `LedgerMeta` correction — closed (`8ad9ea0`).

This milestone is intentionally **not a new Finance capability milestone**. Its purpose is to try to break the completed Finance Core before additional accounting functionality is added.

The first implementation slice, if this proposal is approved, is **3.1 — Tenant/RLS Hardening**. No code, schema, policy, migration, or behavior change is authorized by this document itself.

---

## 0. Review findings and decision boundaries

### 0.1 Existing finding requiring investigation

During the independent review of 2d, a real PostgreSQL connection-pooling behavior was reproduced against `noryx_test`:

- `withTenantScoped()` uses `db.transaction()` with `SET LOCAL`/`set_config(..., true)` for `app.current_tenant_id`.
- A transaction using the default `READ COMMITTED` isolation was independently shown to obtain a new snapshot per statement; this was fixed for General Ledger reports in `8ad9ea0` by opting those three reports into `REPEATABLE READ` + `READ ONLY`.
- The same investigation observed that after a pooled connection has served a transaction using the custom GUC, `app.current_tenant_id` can be represented as an empty string (`''`) rather than `NULL` after the transaction ends.
- The current RLS reference policies test `current_setting('app.current_tenant_id', true) IS NULL` as the platform-operator/unset condition.
- The current `withTenantScoped()` implementation only calls `set_config(..., true)` when `tenantId` is truthy; the `tenantId: null` path therefore does not explicitly reset the GUC before executing the callback.

**Important boundary:** this is an **existing finding to reproduce, characterize, and assess**, not a declared vulnerability or an approved fix. The audit must first establish whether a real reachable `PLATFORM_OPERATOR` path can invoke `withTenant(null, ...)` on a reused connection and whether the observed `''` state changes the intended RLS semantics. If it is exploitable or causes incorrect authorization/data visibility, 3.1 will define the smallest safe correction and regression coverage. If it is not reachable or the effective policy semantics differ from the initial hypothesis, the evidence and disposition must be recorded instead of changing infrastructure speculatively.

### 0.2 Hardening principle

Milestone 3 follows the same proposal-first discipline used for Finance Core:

1. reproduce the finding or attack path;
2. establish the root cause and security/business impact;
3. define the smallest correction, if one is required;
4. add an adversarial regression test that would fail without the correction;
5. re-run the complete affected and regression suites;
6. review the exact diff scope before committing;
7. stop at the next review gate.

No broad refactor, framework migration, ORM replacement, schema redesign, or "cleanup while here" work is authorized by this milestone.

### 0.3 Review gates

The milestone is deliberately split into reviewable increments:

- **3.0 — Audit proposal** — this document only. Approval gate before implementation.
- **3.1 — Tenant/RLS hardening** — tenant context, pooled connections, RLS semantics, cross-tenant isolation. Review gate.
- **3.2 — RBAC and authorization hardening** — role/endpoint/entity matrix and negative tests. Review gate.
- **3.3 — Transaction and concurrency hardening** — Finance Core write/read race matrix and stress tests. Review gate.
- **3.4 — Accounting and audit integrity** — accounting invariants, posting/reversal, audit atomicity and failure behavior. Review gate.
- **3.5 — Production-readiness audit** — migrations, query plans, API error leakage, documentation, operational safety. Review gate.

A later increment must not begin merely because an earlier increment is technically complete; the established explicit-approval rhythm remains in force.

---

## 1. Milestone objective

The objective is:

> **Attempt to violate Finance Core's security, isolation, accounting, transaction, and audit guarantees using adversarial tests against the actual implementation and live Postgres, then fix only evidence-backed defects.**

This is a hardening milestone, not feature expansion.

The audit treats the current Finance Core as the system under test:

- `AccountsModule`
- `AccountingPeriodsModule`
- `JournalEntriesModule`
- `GeneralLedgerModule`
- shared `db-core` tenant/RLS transaction infrastructure
- Finance RBAC guards and module-level role filtering
- shared `audit_logs`
- Finance schema constraints, triggers, indexes, and migrations

The review must use the landed `main` implementation as the source of truth, not older proposal text where behavior has since changed.

---

## 2. Explicit scope

### 2.1 In scope

1. Tenant isolation and RLS correctness.
2. Legal-entity isolation within a tenant.
3. Authentication/RBAC enforcement for every Finance endpoint.
4. Cross-tenant and cross-entity negative authorization tests.
5. Transaction boundaries and concurrency behavior across Finance Core.
6. Accounting invariants already implemented by 2b/2c-2.
7. Audit-log integrity and transaction atomicity.
8. API error handling and information leakage.
9. Database/RLS/migration correctness as deployed, not only as represented in TypeScript.
10. Shared `db-core` behavior where Finance depends on it for tenant isolation.
11. Production-readiness evidence for the existing Finance Core implementation.

### 2.2 Explicitly out of scope

- AP/AR.
- Bank reconciliation.
- FX/multi-currency conversion.
- Period reopening.
- Reversal-of-reversal.
- Cross-legal-entity user switching/access.
- Materialized balances or a new reporting architecture.
- New Finance business capabilities.
- New database tables unless a demonstrated security defect cannot be safely corrected without one and a separate review explicitly authorizes it.
- Broad refactoring of `db-core` unrelated to an evidenced Finance security/correctness defect.
- Rewriting the authentication system, JWT strategy, Passport integration, or API gateway architecture.
- Performance optimization without evidence from an actual failing query plan or measurable hardening requirement.

---

## 3. 3.1 — Tenant/RLS Hardening

This is the first implementation slice and the highest-priority audit area because a tenant-isolation defect has materially greater impact than an ordinary application bug.

### 3.1.1 Tenant context lifecycle

Audit the complete lifecycle of `app.current_tenant_id` across pooled connections:

- tenant A request followed by tenant B request;
- tenant A followed by a platform-operator request;
- platform-operator followed by tenant A;
- successful transaction followed by another request;
- rolled-back transaction followed by another request;
- transaction throwing an exception followed by another request;
- concurrent requests using the same pool;
- multiple pool connections, not only one reused connection;
- explicit tenant ID versus `null` tenant context;
- behavior after `SET LOCAL`/`set_config(..., true)` has been used;
- behavior after the transaction commits and after it rolls back.

The audit must inspect both the session value and the actual rows visible under the relevant RLS policy. A GUC observation alone is not enough to declare a security defect.

### 3.1.2 Platform-operator path

Determine whether any currently reachable service path legitimately calls `withTenant(null, ...)` / `withTenantScoped(null, ...)` and depends on null/unset context meaning "cross-tenant visibility".

If no reachable path exists in the landed architecture, document that result and do not introduce speculative behavior solely to support a hypothetical caller.

If a reachable path exists, test connection reuse before and after tenant-scoped transactions and prove whether the intended platform-operator visibility is preserved.

### 3.1.3 RLS policy audit

For every tenant-scoped Finance table, verify live Postgres state:

- RLS enabled;
- RLS forced;
- expected policy exists;
- policy expression matches the intended tenant semantics;
- ordinary `noryx` role remains non-superuser;
- no accidental owner/superuser bypass exists in the application connection path;
- cross-tenant rows are invisible even when application predicates are deliberately weakened.

Current Finance tables to verify include at least:

- `chart_of_accounts`
- `accounting_periods`
- `journal_number_counters`
- `journal_entries`
- `journal_lines`
- shared `audit_logs`

The exact live table list should be derived from the landed schema/migrations during implementation rather than hard-coded beyond this starting set.

### 3.1.4 Cross-tenant attack matrix

Attempt, using a valid tenant A identity:

- read tenant B account;
- read tenant B period;
- read tenant B journal entry;
- read tenant B journal lines through any reachable endpoint;
- read tenant B ledger;
- read tenant B balance;
- read tenant B trial balance;
- mutate tenant B draft journal;
- delete tenant B draft journal;
- post tenant B journal;
- reverse tenant B journal;
- close tenant B period;
- create a tenant B account/period/journal through any Finance route;
- infer tenant B existence through different status codes or error bodies where the established API convention intends a scoped 404.

Every negative test must assert both the HTTP/API result and zero unintended database mutation where mutation was attempted.

### 3.1.5 Cross-legal-entity attack matrix

Within one tenant, repeat the isolation tests between legal entity A and legal entity B:

- account lookup/list;
- period lookup/list/close;
- journal draft access/mutation;
- posting/reversal target selection;
- ledger;
- account balance;
- trial balance;
- parent-account validation;
- audit-log visibility.

The test must prove that tenant-level RLS is not being mistaken for legal-entity isolation. Finance's existing convention requires explicit `(tenantId, legalEntityId)` predicates in service queries.

### 3.1.6 3.1 acceptance criteria

3.1 is complete only when:

1. The `app.current_tenant_id` finding is reproduced or conclusively dispositioned with live evidence.
2. A real connection-reuse test proves tenant A context cannot affect tenant B visibility and vice versa.
3. The reachable platform-operator/null-tenant behavior is explicitly tested or conclusively shown to be unreachable.
4. Every Finance table has live RLS enabled + forced and the expected policy.
5. Cross-tenant and cross-entity negative tests cover every Finance read/write capability currently exposed.
6. Any defect discovered has the smallest evidence-backed correction and an adversarial regression test.
7. Existing Finance and Identity tests remain green.
8. No unrelated service behavior is changed.

---

## 4. 3.2 — RBAC & authorization hardening

### 4.1 Roles under test

The current Finance module declares:

- `finance.viewer`
- `finance.poster`
- `finance.admin`

The module manifest already lists all three as required roles. The audit must verify that the manifest-level filter and route-level `@Roles()` checks agree.

### 4.2 Endpoint matrix

Build the definitive matrix from the landed controllers rather than copying an old proposal. At minimum it must cover:

- account list/get/create/archive;
- accounting-period list/create/close;
- journal draft list/get/create/edit/delete;
- journal post;
- journal reverse;
- account ledger;
- account balance;
- trial balance.

For every endpoint test:

- each allowed Finance role;
- each disallowed Finance role;
- unauthenticated request;
- authenticated user with an unrelated role;
- correct role but wrong tenant;
- correct role but wrong legal entity.

### 4.3 Acceptance criteria

- No endpoint is accessible to a role not explicitly authorized by the current design.
- No role with legitimate access can cross tenant or legal-entity boundaries.
- Error codes and response bodies do not leak internal authorization details.
- Existing Identity/RBAC behavior remains unchanged outside Finance.

---

## 5. 3.3 — Transaction & concurrency hardening

The implementation already contains several deliberate concurrency controls:

- atomic accounting-period creation through database constraints plus API mapping;
- atomic period close;
- journal-entry row locks for posting/reversal and draft mutation;
- period row locking during posting/reversal;
- atomic journal-number counter allocation;
- `REPEATABLE READ` + `READ ONLY` for the three General Ledger reports.

Milestone 3 must attempt to break these guarantees under real concurrency rather than assuming the individual tests are sufficient.

### 5.1 Race matrix

At minimum:

- period create vs period create;
- period close vs period close;
- period close vs journal post;
- journal PATCH vs post;
- journal DELETE vs post;
- post vs post on the same draft;
- reverse vs reverse on the same posted journal;
- post vs reverse on related entries where applicable;
- concurrent journal-number allocations at higher concurrency than the original 10-request test;
- concurrent General Ledger reads while postings commit;
- concurrent ledger page reads across page boundaries;
- concurrent balance reads across opening/movement boundaries;
- concurrent trial-balance reads while multiple journals post.

### 5.2 Required properties

Verify:

- no duplicate journal numbers;
- no double-posting;
- no double-reversal;
- no partially posted entry;
- no raw database trigger error escaping where a domain error is expected;
- no impossible intermediate financial response;
- no report whose totals combine different committed snapshots;
- no audit event that claims an action occurred when the corresponding business transaction rolled back.

---

## 6. 3.4 — Accounting & audit integrity

### 6.1 Journal invariants

Attempt to violate the existing database/application guarantees:

- unbalanced posted journal;
- fewer than two lines;
- zero/zero line;
- negative amounts;
- both debit and credit positive;
- duplicate line number;
- duplicate journal number;
- mutation of a posted journal field;
- mutation of posted journal lines;
- illegal status transition;
- illegal reversal-link transition.

Every test must establish whether the database, application, or both provide the final protection.

### 6.2 Posting and reversal invariants

Attempt:

- post an already-posted journal;
- post a deleted/nonexistent journal;
- post using an inactive account;
- post using an account from another tenant/entity;
- post into a closed period;
- post outside any accounting period;
- reverse a draft;
- reverse an already-reversed journal;
- reverse a reversal;
- reverse across tenant/entity boundaries;
- self-reversal;
- two concurrent reversals;
- reversal with an invalid or closed target period.

### 6.3 Audit integrity

For every sensitive Finance mutation, establish:

- actor identity is correct;
- tenant/legal-entity context is correct;
- action/entity/entityId are correct;
- before/after state is accurate;
- audit insertion occurs in the same transaction as the business mutation where that is the established contract;
- rollback of the business transaction does not leave a misleading audit record;
- the append-only audit trigger still rejects UPDATE/DELETE.

### 6.4 Acceptance criteria

No tested accounting invariant may be bypassed through the HTTP API or ordinary Finance service path. Any newly discovered invariant gap must be fixed at the narrowest appropriate layer and accompanied by a regression test.

---

## 7. 3.5 — Production-readiness audit

### 7.1 Database and migration review

Review the landed Finance migrations and live database for:

- migration ordering;
- duplicate/obsolete constraints;
- RLS deployment order;
- constraint/trigger deployment order;
- accidental destructive operations;
- indexes actually used by the current Finance workload;
- indexes that exist but are dead/unnecessary;
- query plans for the major Finance read/write paths;
- connection-pool configuration;
- transaction isolation where explicitly overridden.

No index or schema change is approved merely because it "looks useful"; it requires query-plan or correctness evidence.

### 7.2 API error leakage

Deliberately produce:

- validation errors;
- authorization errors;
- scoped-not-found errors;
- conflicts;
- database constraint failures;
- transaction failures;
- malformed IDs and query parameters.

Responses must not leak:

- stack traces;
- SQL statements;
- raw database constraint names;
- connection details;
- internal filesystem paths;
- unrelated tenant/entity identifiers.

### 7.3 Documentation consistency

After hardening, verify that:

- implementation comments match behavior;
- proposal acceptance criteria match landed behavior;
- no document says an implemented feature is still pending;
- known findings have explicit dispositions;
- out-of-scope items remain out of scope.

---

## 8. Testing strategy

The audit must use several layers rather than relying on one test category.

### Layer 1 — Live database probes

Use direct Postgres connections for:

- GUC lifecycle;
- RLS visibility;
- role privileges;
- constraints/triggers;
- transaction isolation;
- connection reuse.

### Layer 2 — Service-level adversarial tests

Where a race or invariant cannot be reliably induced through HTTP alone, exercise the actual service transaction seam using the production query logic rather than duplicating SQL in the test.

### Layer 3 — HTTP e2e

Prove that the public API enforces the same guarantees, including authentication, RBAC, tenant/entity scope, status codes, and response shape.

### Layer 4 — Regression suite

Every 3.x increment must rerun:

- Finance unit tests;
- full Finance e2e;
- monorepo typecheck;
- monorepo lint;
- monorepo build;
- Identity e2e;
- live RLS/non-superuser verification.

Concurrency-sensitive tests should be isolated and repeated where flakiness would materially weaken the evidence.

---

## 9. Evidence and reporting standard

Every discovered issue must be recorded using this structure:

| field | required content |
|---|---|
| Finding | concise statement of the defect/uncertainty |
| Reproduction | exact setup and steps |
| Observed result | what actually happened |
| Expected result | what the architecture requires |
| Impact | security, accounting, availability, or correctness impact |
| Root cause | exact code/database mechanism |
| Disposition | fix / false positive / unreachable / accepted limitation |
| Correction | smallest approved change, if any |
| Regression test | test that fails before and passes after the correction |
| Verification | complete post-change evidence |
| Scope | exact files/modules/tables touched |

No finding is considered closed merely because a test passes once. Security-sensitive findings require a deterministic reproduction or a clearly documented reason why deterministic reproduction is impossible.

---

## 10. Explicit no-scope-creep rules

The following rules apply throughout Milestone 3:

1. **No feature expansion.** If an audit uncovers a missing product feature, record it separately; do not implement it as a hardening fix.
2. **No speculative fixes.** Do not modify code solely because a pattern looks unusual. Reproduce and establish impact first.
3. **No shared-infrastructure refactor without proof.** `db-core` is security-sensitive and shared. Any change must identify the exact Finance failure it fixes and prove that existing consumers retain their behavior.
4. **No weakening of RLS for convenience.** Application predicates are not a substitute for database isolation.
5. **No new privileged database role as a shortcut.** Existing non-superuser assumptions remain part of the security boundary.
6. **No silent behavior changes.** If a correction changes an established API or RBAC behavior, stop for explicit review rather than folding it into a hardening commit.

---

## 11. Proposed sequencing

### 3.0 — Proposal

This document. No implementation.

### 3.1 — Tenant/RLS Hardening

Priority finding: `app.current_tenant_id` pooled-connection lifecycle and the actual reachability/semantics of `withTenant(null, ...)`.

Deliverables:

- live reproduction/disposition;
- tenant-context correction if required;
- cross-tenant/entity adversarial e2e;
- RLS live verification;
- regression suite.

**Review gate.**

### 3.2 — RBAC Hardening

Deliverables:

- definitive endpoint × role matrix;
- negative authorization tests;
- tenant/entity authorization tests;
- regression suite.

**Review gate.**

### 3.3 — Concurrency Hardening

Deliverables:

- complete Finance race matrix;
- higher-concurrency numbering tests;
- posting/reversal/period/report consistency tests;
- regression suite.

**Review gate.**

### 3.4 — Accounting & Audit Integrity

Deliverables:

- invariant attack suite;
- posting/reversal adversarial suite;
- audit atomicity tests;
- live trigger/constraint verification.

**Review gate.**

### 3.5 — Production Readiness

Deliverables:

- migration/schema audit;
- query-plan review;
- API error leakage audit;
- documentation reconciliation;
- final hardening report.

**Milestone close gate.**

---

## 12. Acceptance criteria for Milestone 3 as a whole

Milestone 3 is closed only when all of the following are true:

1. The known tenant-GUC finding has a documented, evidence-backed disposition.
2. No reproducible cross-tenant data read/write path exists through Finance Core.
3. No reproducible cross-legal-entity data read/write path exists through Finance Core where the current architecture requires entity isolation.
4. Every Finance endpoint has a tested RBAC outcome for every Finance role.
5. Finance write operations remain safe under the defined concurrency matrix.
6. General Ledger reports remain snapshot-consistent during concurrent posting.
7. Database accounting invariants remain enforced and adversarially tested.
8. Audit records remain transactionally correct and append-only.
9. API failures do not expose database/internal implementation details.
10. Live RLS, FORCE RLS, and non-superuser assumptions are re-confirmed.
11. Monorepo typecheck, lint, build, Finance unit/e2e, and Identity e2e are green after the final hardening changes.
12. Every finding has a recorded disposition, regression coverage where applicable, and exact scope evidence.
13. No feature work outside this milestone has been introduced.

---

## 13. Deliverables

At milestone close, the repository should contain:

- this approved hardening proposal;
- the implementation commits for each approved 3.x correction;
- adversarial regression tests;
- any narrowly required migration/policy changes;
- a final hardening verification record documenting findings, fixes, accepted limitations, and live database evidence.

No single large "hardening refactor" commit is required or preferred. The existing review-gate rhythm is the governing sequencing rule.

---

## 14. Authorization boundary

**Current status: AWAITING REVIEW.**

This proposal authorizes no code changes merely by existing in the repository.

The first requested authorization is:

> **Approve 3.1 — Tenant/RLS Hardening, including investigation of the existing `app.current_tenant_id` pooled-connection finding, using the evidence-first mechanism and acceptance criteria in §3.**

Until that approval is explicit, no 3.1 code, migration, RLS policy, or test implementation should be started.
