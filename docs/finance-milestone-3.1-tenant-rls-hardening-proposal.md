# Finance Core Hardening — Milestone 3.1: Tenant/RLS Hardening

Status: **implemented and closed.** This document originated as the
proposal for 3.1 (Tenant/RLS Hardening); §0–§3 below are preserved
unchanged as the historical record of that proposal's findings and locked
scope. This header and §4 onward have been updated to record what was
actually implemented, verified, and shipped — no technical decision or
scope item described anywhere in this document was changed during
implementation. Per the roadmap (`docs/roadmap.md`), Finance Core's
functional build (Milestone 1b, 2a–2d, plus the 2d read-consistency
follow-up) remains complete and untouched by this work. 3.2–3.5 remain not
started and are out of scope here; each will get its own proposal when its
turn comes.

## Implementation record

3.1 was approved for implementation as proposed, with the open questions
in §4 resolved as decisions (see §4). It shipped as five atomic commits,
in the sequence proposed in §6:

| Commit    | Scope                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2a9be9c` | CI infrastructure repair (pnpm/action-setup version conflict, invalid OSV scanner action reference, Node 20 Actions-runtime deprecation) — a prerequisite fix to CI itself, not part of 3.1's proposed scope, landed first so 3.1's own CI changes (below) built on a working pipeline. |
| `3f94508` | §2.1–2.3 — dedicated non-superuser application role (`noryx_app`), `docker-compose.yml` wiring, and the role-privilege assertion.                                                                                                                                                       |
| `bc6678c` | §2.4 — the null-tenant RLS bypass fix (`''` treated as equivalent to `NULL`) across all 10 `tenant_isolation` policies.                                                                                                                                                                 |
| `4bfb9dd` | §2.6–2.7 — the direct, application-code-independent RLS proof tests and the drift guard.                                                                                                                                                                                                |
| `770b9f6` | §2.5 — CI wiring: a Postgres 16 service container and the full `test:e2e` suite as a required job ahead of `build`.                                                                                                                                                                     |

No code, schema, or scope outside what §2 proposed was introduced at any
stage. Application service logic (Identity, API Gateway, Finance's own
`src/`) was not touched by any of the five commits — confirmed by diff
inspection at closeout, alongside a full re-run of the pre-existing
Finance and Identity suites showing zero regression.

## 0. What was inspected before writing this

- Every RLS policy file in the repo:
  `packages/db-core/drizzle/rls/001_enable_rls.sql` (tenants,
  legal_entities, users, subscriptions, audit_logs) and
  `services/sphere-finance/drizzle/rls/001_enable_rls.sql` +
  `002_journal_engine_rls.sql` (chart_of_accounts, accounting_periods,
  journal_number_counters, journal_entries, journal_lines) — 10 policies
  total, all following the identical `tenant_isolation` pattern.
- Both `schema.ts` files, to cross-check every `tenant_id` column against
  the policy list above (checking for drift).
- The single implementation of the tenant-scoping mechanism:
  `packages/db-core/src/generic-client.ts`'s `withTenantScoped()`, and
  Finance's thin wrapper `services/sphere-finance/src/db/db.ts`'s
  `withTenant()`. Confirmed by grep that `set_config('app.current_tenant_id', ...)`
  has exactly one call site in the entire codebase.
- Every call site of `withTenant(...)` across Identity, Finance, and
  db-core (24 call sites), specifically the ones passing `null` —
  `services/identity/src/auth/auth.service.ts` `login()` (platform
  operators / `dto.tenantId ?? null`), `refresh()`, and `logout()`.
- `docker-compose.yml` and the official Postgres Docker image's
  `docker-entrypoint.sh` (fetched from
  `github.com/docker-library/postgres`), to determine what DB role the
  containerized services actually run as.
- `.github/workflows/ci.yml` in full, and `package.json`/`turbo.json`'s
  `test` vs `test:e2e` scripts, to determine what CI actually runs.
- The existing RLS-relevant e2e tests
  (`services/sphere-finance/test/accounts.e2e-spec.ts`,
  `general-ledger.e2e-spec.ts`, `general-ledger-concurrency.e2e-spec.ts`,
  `journal-engine-db-constraints.e2e-spec.ts`) to see what they actually
  prove versus what their names claim.
- Live, empirical verification against the real local Postgres 16
  instance (not assumed from memory) of: the current `noryx` role's
  `rolsuper`/`rolbypassrls` attributes; whether `set_config(name, NULL, true)`
  or `RESET <guc>` restores a genuinely-NULL `current_setting()` for a
  custom placeholder GUC that was previously `SET LOCAL`'d and committed;
  and that `''::uuid` is invalid input (so an empty string can never
  collide with a real tenant id).

## 1. Findings

### 1.1 🔴 The docker-compose (and, by inheritance, any future deployment

that follows the same pattern) DB role is a Postgres **superuser** —
RLS provides no actual protection there today

`docker-compose.yml` sets `POSTGRES_USER: noryx` on the stock
`postgres:16-alpine` image with no further role configuration. The
official image's entrypoint runs
`initdb --username="$POSTGRES_USER" ...`, and per `initdb`'s own
documented behavior, the `-U`/`--username` role becomes the cluster's
bootstrap **superuser**. There is no step anywhere in this repo (no
`CREATE ROLE`, no `/docker-entrypoint-initdb.d` script) that then demotes
or replaces that role. `identity`, `sphere-finance`, and `api-gateway` all
connect using `DATABASE_URL=postgresql://noryx:noryx@postgres:5432/noryx`
— the same superuser role.

This matters because **Postgres superusers unconditionally bypass RLS**,
including `FORCE ROW LEVEL SECURITY` — `FORCE` only changes behavior for
the table owner when that owner is _not_ a superuser. Every
`tenant_isolation` policy in the repo, no matter how it's written, has no
effect at all against a superuser connection. As shipped in
`docker-compose.yml`, RLS is currently decorative, not enforced.

This sandbox's own local Postgres cluster happens to _not_ exhibit this
problem — I checked live: `noryx` here has `rolsuper=f`,
`rolbypassrls=f`. But that role was set up by hand outside of any
checked-in script; nothing in the repo reproduces that non-superuser
setup anywhere else (docker-compose, CI, or a real deployment). This is
why every RLS-dependent e2e test in this engagement has passed — they've
only ever run against this one hand-configured, non-representative role.

### 1.2 🔴 No dedicated, least-privilege application DB role exists anywhere in the repo

Independent of 1.1's superuser issue: the same `noryx` role is used for
both schema ownership/migrations _and_ runtime application traffic. There
is no `CREATE ROLE` for a scoped-down runtime identity anywhere in the
codebase. Even once 1.1 is fixed, best practice is that the role the
running services authenticate as should not be the table-owning/migration
role — it should hold only the DML privileges (`SELECT`/`INSERT`/`UPDATE`/`DELETE`
on application tables, `USAGE` on sequences) it actually needs.

### 1.3 🔴 CI never runs the e2e suite — every RLS/tenant-isolation/concurrency proof in this engagement has only ever run manually

`.github/workflows/ci.yml`'s `test` job runs `pnpm run test -- --coverage`
(`turbo run test`, i.e. unit tests / `*.spec.ts` only). There is a
separate `pnpm run test:e2e` script (`turbo run test:e2e`) and it is
**never invoked anywhere in CI**. No job provisions a Postgres service
container at all. This means:

- The entire `general-ledger-concurrency.e2e-spec.ts` suite (the
  adversarial concurrency tests that back the 2d read-consistency fix)
  has never once run in CI.
- `accounts.e2e-spec.ts`'s tenant/legal-entity isolation tests, and every
  other RLS-touching e2e test, are in the same position.
- A future change that silently breaks RLS enforcement (e.g. a migration
  that forgets `FORCE ROW LEVEL SECURITY`, or a regression to the
  superuser issue in 1.1) would not be caught by the CI gate that
  branch protection actually requires — only by someone remembering to
  run e2e locally.

This is the same gap the external review previously flagged as an
"unconfirmable CI status" note; this document is the first place it's
been root-caused.

### 1.4 🟡 `withTenant(null, ...)` is unreliable on a pooled connection that has ever served a real tenant — confirmed, not hypothetical

This is the concern flagged (and deliberately deferred) during the 2d
follow-up work, now root-caused precisely. `withTenantScoped()` only
issues `SELECT set_config('app.current_tenant_id', tenantId, true)`
`if (tenantId)` — a `null` tenantId call does _not_ reset the GUC, it
just leaves whatever the pooled physical connection's last value was.

Verified live, again, in this session: once a GUC like
`app.current_tenant_id` has been `SET LOCAL`'d and that transaction
commits, `current_setting('app.current_tenant_id', true)` returns `''`
(empty string) — not `NULL` — for the remaining life of that physical
connection. I additionally tested, empirically, whether either of the two
obvious-looking "reset it properly" fixes actually work once a GUC is in
this state:

- `SELECT set_config('app.current_tenant_id', NULL, true)` — does not
  raise an error, but `current_setting(...)` still returns `''`/`IS NULL`
  is still `false`. Does not fix it.
- `RESET app.current_tenant_id` — same result. Does not fix it either,
  because this is a custom placeholder GUC with no compiled-in default to
  reset to.

So there is no way, from the _setter_ side, to get back to a genuine
`NULL` once a connection has served one real tenant. Any code path that
calls `withTenant(null, ...)` — currently `AuthService.login()` for
platform-operator/ambiguous-tenant logins, `refresh()`, and `logout()` in
`services/identity/src/auth/auth.service.ts` — is one unlucky
connection-pool assignment away from silently seeing **zero rows**
(since `''` satisfies neither the `IS NULL` bypass nor any real
`tenant_id` match), because the RLS policy's bypass condition is written
as `current_setting(...) IS NULL`. With a pool of 5 connections
(`createTenantScopedDbClient`'s non-production `max: 5`), this isn't a
rare edge case — it converges to "any `withTenant(null, ...)` call, once
the pool has warmed up," i.e. most refreshes and logouts in a running
system. Concretely: a user's session refresh, or their logout, can
non-deterministically fail with "Invalid refresh token" or silently not
invalidate their refresh token hash, depending purely on which pooled
connection they land on.

**The fix is a single, narrow, mechanism-level correction, not new
application logic** — mirroring the shape of the 2d transaction-config
fix already approved and shipped. The RLS bypass predicate itself needs
to treat the post-commit-reverted empty string the same as a genuine
`NULL`:

```sql
-- current, in all 10 policies:
current_setting('app.current_tenant_id', true) IS NULL
  OR tenant_id::text = current_setting('app.current_tenant_id', true)

-- proposed:
current_setting('app.current_tenant_id', true) IS NULL
  OR current_setting('app.current_tenant_id', true) = ''
  OR tenant_id::text = current_setting('app.current_tenant_id', true)
```

This is safe: `tenant_id` is a `uuid` column, and `''::uuid` is invalid
input (verified live) — an empty string can never be a real tenant id, so
treating it as "unscoped" cannot ever accidentally match or hide a real
tenant's rows. The change applies uniformly to all 10 existing policies
(same one-line pattern each), not just Finance's. It requires no
application-code change in `auth.service.ts` — the existing
`withTenant(null, ...)` calls become correct as soon as the policies
recognize `''` as the bypass state. `withTenantScoped()`/`withTenant()`
themselves also do not need to change.

Because the only writer of this GUC anywhere in the codebase is the one
`set_config` call inside `withTenantScoped()` (confirmed by grep — no
other writer exists), this argument is airtight against the _current_
codebase. It is worth a one-line code comment at that call site noting
this invariant, so a future second writer of the GUC doesn't quietly
invalidate the safety argument.

### 1.5 🟡 No test proves RLS itself is what blocks cross-tenant access, independent of application-layer predicates

Tests like `accounts.e2e-spec.ts`'s _"tenant A cannot write (archive)
tenant B's account — RLS blocks it at the data layer, not just RBAC"_ go
through the full HTTP → NestJS service → Drizzle query stack. Service
methods also include their own explicit `eq(tenantId, ...)` predicates
(the documented "`withTenant()`/explicit predicate" pattern). That's
good layered defense, but it means these tests cannot actually
distinguish "Postgres's RLS policy filtered this" from "the service's own
`WHERE tenant_id = ...` filtered this" — if the application-layer
predicate were ever accidentally dropped in a refactor, these tests would
not necessarily catch it, because RLS alone has never been isolated and
proven. The `tenant_isolation` policy SQL files' own comments claim "a
bug in application code cannot leak another tenant's rows" — that
specific claim has never actually been tested.

### 1.6 What's already solid (not being reopened by 3.1)

- Every `tenant_id`-bearing table in both `db-core` and `sphere-finance`
  schemas currently has a matching `tenant_isolation` policy with
  `FORCE ROW LEVEL SECURITY` — checked 1:1, no drift today (5 db-core
  tables, 5 Finance tables, 10/10 covered).
- The GUC-set mechanism is centralized in exactly one function
  (`withTenantScoped`), always using transaction-local
  `set_config(..., true)` (`SET LOCAL` semantics) — there's no scattered
  or inconsistent implementation across call sites to audit.
- `journal_lines` denormalizes `tenant_id` directly onto every row rather
  than relying on a join back to `journal_entries` for isolation — good
  defense-in-depth, worth preserving as the pattern for any future table.

## 2. Proposed 3.1 scope

1. **Provision a dedicated, least-privilege, non-superuser application DB
   role** (working name `noryx_app`): `LOGIN`, `NOSUPERUSER`,
   `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, granted `SELECT`,
   `INSERT`, `UPDATE`, `DELETE` on application tables and `USAGE`/`SELECT`
   on sequences — not ownership. Schema/RLS-policy/constraint migrations
   continue to run as the existing owner role; only runtime traffic moves
   to `noryx_app`. Idempotent provisioning (`DO $$ ... IF NOT EXISTS ...`)
   alongside the existing `apply-rls.ts`/migration scripts, re-run
   whenever a new tenant-scoped table is added.

2. **Point `docker-compose.yml`'s `identity` and `sphere-finance`
   `DATABASE_URL` at `noryx_app`**, not the `POSTGRES_USER` superuser.
   `postgres`'s own `POSTGRES_USER` stays as-is for migrations/bootstrap.

3. **Add a continuously-checked invariant**, not just a one-time fix: a
   small startup/CI assertion that connects using the application's own
   `DATABASE_URL` and fails loudly if `current_user`'s `rolsuper` or
   `rolbypassrls` is ever true again. Turns "RLS actually applies" from
   an assumption back into something CI enforces every time.

4. **Fix the null-tenant RLS bypass gap (§1.4)**: a new RLS migration
   file in each of `packages/db-core/drizzle/rls/` and
   `services/sphere-finance/drizzle/rls/` that re-issues all 10
   `tenant_isolation` policies with the corrected
   `IS NULL OR ... = '' OR tenant_id = ...` predicate, applied the same
   idempotent `DROP POLICY IF EXISTS` / `CREATE POLICY` way `apply-rls.ts`
   already does. No application-code change required.

5. **Wire the e2e suite into CI (§1.3)**: add a Postgres 16 service
   container to a CI job, run migrations + `apply-rls.ts` +
   `apply-db-constraints.ts` against it, then run `pnpm run test:e2e`
   (or, if the full e2e runtime cost in CI is a concern, at minimum the
   RLS/tenant-isolation-relevant suites) as a required merge gate. This
   item has a real pipeline-cost/complexity tradeoff — flagged in §4 as
   something to explicitly confirm before implementation, not assumed.

6. **Add a direct, application-code-independent RLS proof test (§1.5)**:
   connect directly (bypassing NestJS services) as the new non-superuser
   `noryx_app` role, `SET LOCAL app.current_tenant_id` to tenant A, run a
   raw predicate-free `SELECT *` against a representative table per
   schema (e.g. `users`, `chart_of_accounts`, `journal_entries`), and
   assert only tenant A's rows return — plus the mirror case with the GUC
   unset/empty, confirming the platform-operator bypass behaves exactly
   as intended post-§1.4's fix.

7. **Add a drift guard (§1.6 is clean today, keep it that way)**: a
   script/test that introspects `information_schema.columns` for any
   `tenant_id` column and cross-checks `pg_policies` for a matching,
   forced `tenant_isolation` policy — fails if a future table ships
   without one. Low cost, prevents exactly the kind of gap that review
   alone won't reliably catch as Phase 2+ tables get added.

## 3. Explicitly out of scope for 3.1

- RBAC/authorization logic (roles guard, tier checks) — that's 3.2.
- Any change to the accounting model, journal engine, or GL reporting
  behavior — 2a–2d stay as shipped.
- Any change to `AuthService`'s business logic beyond what §2.4 requires
  (none — the fix is entirely in the RLS policy SQL).
- Broader transaction/concurrency work beyond the RLS-GUC mechanism
  itself — that's 3.3.
- Kubernetes/Terraform-based production deployment — those manifests are
  still empty scaffolding (per `docs/roadmap.md`'s Phase 0 checklist);
  §2.2's `docker-compose.yml` change is the only deployment-config touch,
  and only to fix the demonstrated superuser issue.
- Row-level locking, `FOR UPDATE`, or any change to the isolation-level
  work already shipped in the 2d follow-up.

## 4. Decisions (resolved — originally posed as open questions)

These three questions were resolved by explicit approval before
implementation began; each is recorded here as shipped.

1. **CI e2e scope (§2.5)**: resolved as _full_ `test:e2e` suite, run in
   CI against a real PostgreSQL 16 service — not the narrower
   RLS-specs-only alternative. Shipped in `770b9f6`.
2. **Role naming/provisioning mechanism (§2.1)**: resolved as
   `noryx_app`, provisioned via its own `apply-app-role.ts` (mirroring
   `apply-rls.ts`'s pattern rather than folding into it). Shipped in
   `3f94508`.
3. **The `''`-as-equivalent-to-`NULL` RLS bypass correction (§1.4)**:
   approved as proposed, based on the documented live verification in
   §1.4 (`''::uuid` is invalid input, so the widened bypass condition can
   never collide with a real tenant id). Shipped in `bc6678c`.

## 5. Verification plan and results

Each planned item below is followed by what was actually run and found.
All results are from live execution in this engagement's sandbox, not
assumed.

- **Finance + Identity unit and e2e suites, including the new §2.6
  RLS-direct-proof tests and the new §2.7 drift-guard test.**
  Result: after every stage, and again at closeout against a completely
  fresh database migrated from a blank schema, the full suite passed —
  12/12 turbo tasks: db-core 4/4 (including the new RLS-hardening e2e
  suite), api-gateway 3/3, identity 2/2, sphere-finance 161/161 across 7
  suites (154 pre-existing + 7 new: 4 in db-core's suite, 3 in
  sphere-finance's). The drift-guard test was additionally adversarially
  verified by temporarily running `ALTER TABLE chart_of_accounts NO FORCE
ROW LEVEL SECURITY` and confirming the test failed and named that exact
  table, then restoring the setting and confirming green again — proving
  the guard actually discriminates rather than trivially passing.

- **The new §2.3 role-privilege assertion, run against both the local dev
  role and the `noryx_app` role.**
  Result: `assert-role-privileges.ts` passes against `noryx_app`
  (`rolsuper=false, rolbypassrls=false`) and correctly fails loudly
  against a superuser connection, both in local dev and in the from-blank
  closeout run.

- **Monorepo typecheck, lint, build.**
  Result: all green at every stage and at closeout — typecheck 11/11,
  lint 11/11 (0 errors; only pre-existing warnings unrelated to this
  work), build 8/8.

- **CI actually green on the new e2e job (§2.5), not just locally.**
  Result: validated locally to the fullest extent this sandbox allows —
  `actionlint` reports 0 issues against the edited workflow, the YAML
  parses, and a full simulation of the exact job sequence (fresh database,
  migrate → RLS → constraints → app-role → privilege guard → full
  `test:e2e`) was run end-to-end and passed. The actual GitHub Actions run
  has **not** been observed, because `git push` to this repository remains
  blocked in this sandbox by the git-proxy restriction that has applied
  throughout this engagement. This is carried forward as an open item —
  see §8.

- **Re-verify against the real GitHub `main` state via a fresh clone,
  same as every prior Finance Core increment in this engagement.**
  Result: not performed, for the same push-restriction reason above — this
  sandbox has no way to fetch a `main` that includes these commits, since
  they have not been pushed. Local-equivalent verification (fresh-database
  simulation, above) is the closest available substitute and was
  performed in full.

- **Confirm no unintended behavior change to any of the 24 existing
  `withTenant`/`withTenantScoped` call sites outside the 10 policy files
  touched.**
  Result: confirmed. A diff across all five commits shows zero files under
  any service's `src/` (identity, api-gateway, sphere-finance) touched —
  only db-core's RLS/role SQL and helper scripts, `docker-compose.yml`,
  `.github/workflows/ci.yml`, `package.json`, and test files changed. The
  full pre-existing Finance and Identity suites, which exercise every one
  of those 24 call sites, passed unchanged after each stage.

## 6. Sequencing (as proposed, and as shipped)

1. §2.1–2.3: dedicated role + docker-compose wiring + privilege
   assertion (self-contained, no dependency on the others). Shipped as
   `3f94508`.
2. §2.4: the RLS policy fix (self-contained; can land independently of
   §1). Shipped as `bc6678c`.
3. §2.6–2.7: new tests (depend on §2.1's role existing so they can
   connect as `noryx_app` directly, and on §2.4 for the bypass-case
   assertion to be meaningful). Shipped as `4bfb9dd`.
4. §2.5: CI wiring (last, so the new tests it's gating already exist and
   pass locally first). Shipped as `770b9f6`.

Each of the four groups shipped as its own atomic commit, in this order,
consistent with how every prior increment in this engagement has shipped.
Verification was performed after each stage before proceeding to the
next, per §5.

## 7. Acceptance criteria for closing 3.1

- [x] `noryx_app` exists, is non-superuser, does not bypass RLS, and is
      what `docker-compose.yml` actually connects as. Evidence: created in
      `001_create_app_role.sql` (`3f94508`); `docker-compose.yml`'s
      `identity` and `sphere-finance` `DATABASE_URL` point at it; live
      `pg_roles` query at closeout confirmed `rolsuper=false,
    rolbypassrls=false`.
- [x] The role-privilege assertion exists and fails loudly on regression.
      Evidence: `assert-role-privileges.ts` — passes against `noryx_app`,
      fails with an explicit error against a superuser connection; wired
      as a hard CI gate in `770b9f6`, re-confirmed at closeout.
- [x] All 10 `tenant_isolation` policies recognize `''` as equivalent to
      `NULL` for the bypass condition; the §1.4 scenario (repeated
      `withTenant(null, ...)` calls across a warmed-up connection pool)
      is covered by a passing adversarial test that would have failed
      before the fix. Evidence: `003_null_tenant_bypass_fix.sql` in both
      db-core and sphere-finance (`bc6678c`); the poisoned-connection
      bypass scenario is proven live pre/post-fix and covered by a
      dedicated e2e test in each package's `rls-hardening.e2e-spec.ts`
      (`4bfb9dd`).
- [x] A direct, application-code-independent RLS proof test exists and
      passes for at least one table per schema. Evidence:
      `packages/db-core/test/rls-hardening.e2e-spec.ts` (`legal_entities`)
      and `services/sphere-finance/test/rls-hardening.e2e-spec.ts`
      (`chart_of_accounts`), both connecting raw as `noryx_app` with no
      NestJS or Drizzle query-builder layer involved — 7/7 passing.
- [x] The drift-guard test exists and passes against current schema.
      Evidence: the introspection test in db-core's suite; adversarially
      verified by disabling `FORCE ROW LEVEL SECURITY` on a live table and
      confirming the test fails and names the offender, then confirming
      green again once restored.
- [x] CI is configured to run the agreed e2e scope (full `test:e2e`, per
      §4.1) against a real Postgres service. Evidence: `test-e2e` job in
      `770b9f6`, validated via `actionlint` (0 issues) and a full local
      simulation of the identical sequence against a from-blank database.
      **Not yet confirmed green on an actual GitHub Actions run** — see
      §8; this is the one acceptance-criteria item resting on local
      verification rather than the real CI environment, because push
      remains blocked in this sandbox.
- [x] Full verification plan (§5) executed and reported, not assumed. See
      §5 above for the complete results, including the two items (real CI
      run, fresh-clone re-verification) that could not be performed for
      the push-restriction reason and are carried forward as open items.

## 8. Remaining open items (not part of 3.1's scope; carried forward)

Two items surfaced during this milestone remain open. Neither blocks
closing 3.1 — both are pre-existing or environment-level, not defects in
this milestone's work — but both need your attention before Finance work
resumes at full confidence.

1. **Pre-existing dependency vulnerabilities.** `pnpm audit
--audit-level=high` fails with 10 pre-existing high-severity findings
   (in `multer`, `vite`, and others), discovered during the CI
   infrastructure repair that preceded 3.1's first commit. These predate
   3.1, are unrelated to tenant/RLS hardening, and were explicitly left
   unmodified per that task's "do not modify dependencies" instruction.
   Still unresolved. Worth a deliberate decision on remediation timeline
   (the Pre-Development Readiness Review's own SLA calls for High findings
   to be patched within 7 days) rather than remaining an incidental
   finding.

2. **CI results not yet confirmed against the actual GitHub Actions run.**
   Every result in §5 and §7 above that says "CI" was produced by local
   simulation — a real Postgres 16 service was never actually exercised
   through GitHub's own runners, because `git push` to this repository is
   blocked in this sandbox by a git-proxy restriction that has applied
   throughout this engagement (a known, unresolved limitation of this
   environment, not something fixable from within it). Once you push the
   delivered bundle, the `test-e2e` job (and the rest of the pipeline)
   should be watched on its first real run and any environment-specific
   difference from local simulation — runner-specific timing, service
   container startup behavior, etc. — reported back. Local simulation is
   the strongest proxy available here, but it is not a substitute for
   seeing the real workflow go green.
