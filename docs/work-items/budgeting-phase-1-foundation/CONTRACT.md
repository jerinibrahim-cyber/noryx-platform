# Contract: BUDGETING-PHASE-1-FOUNDATION

**Status:** PROPOSED — AMENDED (discovery-stage — not yet CTO-approved for implementation)
Per `docs/engineering/CLAUDE_ENGINEERING_PROTOCOL.md` §4/§6, `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md`, `docs/engineering/NORYX_CTO_COPILOT_PROTOCOL.md`.

**Amendment history:**

- v1 (initial discovery): proposed §17 decisions A/B/C as open questions requiring CTO confirmation.
- v2 ("NORYX CTO PROPOSAL AMENDMENT AUTHORIZATION"): CTO resolved Decisions A, B, C, and D explicitly. See §0 below.
- v3 ("NORYX CTO PROPOSAL CORRECTION AUTHORIZATION"): CTO review found v2's proposed mechanism for enforcing Decision B — a single `UPDATE ... WHERE status='DRAFT' AND EXISTS(...)` statement — insufficient under PostgreSQL MVCC to close the approval-vs-last-line-delete race (a plain `EXISTS` subquery takes no lock on `budget_lines`, so it does not serialize against a concurrent `DELETE` on that table). **Decision B itself is unchanged** ("an APPROVED budget must never have zero lines") — only the concurrency _mechanism_ that enforces it is corrected, from a single-statement approach to explicit parent-row transaction locking (`SELECT ... FOR UPDATE` on the `budgets` row), which both `approve()` and every `budget_lines` mutation now acquire as their first transactional step. See §0a, §5, §11.
- v4 (second "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION"): CTO review found two remaining gaps in v3's serialization model: (1) `BudgetsService.update()` (header PATCH) did not participate in the §0a parent-row lock, even though it mutates the same aggregate root; (2) a header date-range PATCH had no mechanism re-validating already-existing budget lines against the proposed new dates, so it could silently violate Decision C (period containment) for lines that were valid when created. Both are corrected: the parent `budgets` row is now explicitly the serialization point for the _complete_ budget aggregate (header + lines), and a date-changing PATCH re-validates every existing line under the same lock before committing, rejecting the whole PATCH (no partial mutation) if any line would fall outside the new range. Decisions A/B/C/D remain unchanged. See §0b, §5, §10, §11, §12. This remains a discovery-stage artifact — no implementation has occurred, and this correction remains `PROPOSED` pending a separate future CTO_APPROVED/implementation-authorization gate.
- v5 ("NORYX CTO PROPOSAL CORRECTION AUTHORIZATION — v5 DOCUMENTATION CLEANUP"): CTO review found three terminology defects introduced in v4, none architectural: (1) the serialization surface was miscounted as "six operations" in several places — it is actually **five** (`approve()`, `update()`, line `create()`, line `update()`, line `delete()`); (2) a stray reference to "Decisions A/B/C/D/E" implied a nonexistent Decision E — there are only four (A/B/C/D); (3) the Gap 2 rejection status code (422 Unprocessable Entity for a date-change PATCH that would invalidate an existing line) is now confirmed by the CTO as a **CTO DECISION**, not a Claude-proposed convention pending confirmation. No architecture, decision, lock model, or acceptance scenario changed — this is a documentation-accuracy correction only. See §0b.
- v6 (this version, "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION — v6"): CTO review identified one remaining technical precision gap in the concurrency proofs: they rely on a competing transaction's post-lock re-check statement observing the other transaction's just-committed state, which is specifically a `READ COMMITTED`-isolation-level behavior (a fresh per-statement MVCC snapshot on lock release), not something `SELECT ... FOR UPDATE` guarantees under an arbitrary isolation level. This is now made explicit in §11: Budgeting's five state-changing operations run under `READ COMMITTED`, the codebase's own documented default (confirmed by direct inspection of `src/db/db.ts` and the one existing, narrow, read-only exception in `GeneralLedgerService`), and the Case A–D proofs are correct specifically because of that isolation level. No locking mechanism, architecture, decision, or acceptance scenario changed — this is a precision/documentation correction only. See §5, §11.

## 0. CTO Decisions Incorporated (v2 amendment)

| Decision                             | CTO ruling                                                                                                                                                                                                                                                                           | Where reflected   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **A — Budget amount representation** | Non-negative magnitude. `amount_minor >= 0` retained. No signed debit/credit polarity. Future budget-vs-actual reporting defines its own interpretation separately.                                                                                                                  | §5, §10, §12      |
| **B — Empty budget approval**        | An APPROVED budget MUST contain ≥1 line. `approve()` rejects a DRAFT budget with zero lines. (Concurrency mechanism corrected in v3 — see §0a.)                                                                                                                                      | §5, §10, §11, §12 |
| **C — Budget/period alignment**      | A budget line's accounting period must fall completely within the parent budget's date range: `period.start_date >= budget.start_date AND period.end_date <= budget.end_date`. Enforced at the application layer. No separate fiscal-year/calendar model.                            | §5, §6, §10, §12  |
| **D — Multiple approved budgets**    | Retained as originally proposed: multiple APPROVED budgets may coexist, including overlapping periods/accounts. Phase 1 designates no single authoritative approved budget. Authoritative-budget selection/reporting semantics are deferred to a later, separately-authorized phase. | §10, §13          |

None of these four decisions remain open architecture questions. §17 (Risks/Blockers) reflects this — decisions A/B/C/D are removed from the open-question list and recorded here as CTO-resolved instead.

## 0a. CTO Concurrency Correction (v3)

**Problem identified by CTO review:** v2's claim that `UPDATE budgets SET status='APPROVED' WHERE status='DRAFT' AND EXISTS(SELECT 1 FROM budget_lines WHERE budget_id=budgets.id)` "closes the race" against a concurrent deletion of the last budget line is **incorrect**. The `UPDATE` takes a row lock only on the `budgets` row it writes; the `EXISTS` subquery is an unlocked read against a _different_ table (`budget_lines`). A concurrent `DELETE` on `budget_lines` is not blocked by that lock and does not serialize against it — so a `DELETE` and an `approve()` can interleave such that `approve()`'s `EXISTS` check observes a since-deleted line, producing the forbidden state: an `APPROVED` budget with zero lines.

**Correction:** the parent `budgets` row is now the explicit serialization point for the whole budget-lifecycle/child-mutation surface. `approve()` and every `budget_lines` create/update/delete operation each open a transaction and, as their first action, take `SELECT ... FOR UPDATE` on the same `budgets.id` row before performing any check or mutation. This forces PostgreSQL's row-lock queue to serialize any two such operations on the same budget into a strict order — the actual mechanism that makes "AN APPROVED BUDGET MUST NEVER END UP WITH ZERO BUDGET LINES" hold under all interleavings. Full detail, both required interleaving proofs (Case A: `approve()` locks first; Case B: the last-line `DELETE` locks first), and the corrected pseudocode are in §5 and §11. No database trigger is introduced — this is an application-transaction-level locking discipline using standard PostgreSQL row locks, not new database logic, consistent with "do not introduce database triggers unless the contract independently requires them."

This correction distinguishes four separate categories of guarantee at work in this work item, none of which substitute for another:

1. **Database uniqueness constraints** — `budgets(tenant_id, legal_entity_id, code)`, `budget_lines(budget_id, account_id, period_id)`. Prevent duplicate keys unconditionally, independent of any transaction-locking discipline.
2. **Database CHECK/FK/RLS guarantees** — `end_date > start_date`, `amount_minor >= 0`, the three `budget_lines` FKs, tenant-scoped RLS. Structural row-level guarantees, enforced by Postgres regardless of application code.
3. **Parent-row transaction locking for lifecycle/child-mutation serialization** (this correction) — `SELECT ... FOR UPDATE` on `budgets.id`, held for the duration of `approve()` or any `budget_lines` mutation. The mechanism that makes the _cross-table_ business invariant (Decision B) hold under concurrency; nothing else in categories 1/2/4 provides this on its own.
4. **Application-level business validation** — status checks (DRAFT vs. APPROVED), tenant/legal-entity ownership checks, the period-alignment rule (Decision C). Performed inside the transaction, after the parent-row lock in category 3 is held, so these checks see a consistent, non-racing view of the budget's state.

## 0b. CTO Correction — Header PATCH Serialization and Date-Change Invariant (v4)

**CTO DECISION (this correction):** two gaps identified during CTO review of v3, both required to be closed:

**Gap 1 — `BudgetsService.update()` (header PATCH) was not part of the §0a serialization model.** v3 required the parent `budgets` row lock (`SELECT ... FOR UPDATE`) for `approve()` and every `budget_lines` create/update/delete, but not for the header `PATCH` itself. That is an omission, not a deliberate exclusion — a header `PATCH` mutates the same aggregate root and must serialize through the same lock for the same reason: **the parent `budgets` row is the serialization point for the complete budget aggregate** (header + lines), not only for a subset of the operations that touch it. **CORRECTION (CTO DECISION):** `BudgetsService.update()` now opens a transaction, takes `SELECT ... FOR UPDATE` on the target `budgets.id` row as its first action, and performs its existing checks and mutation while holding that lock — the identical pattern already specified for `approve()`/line mutations in §0a, extended to cover the one remaining state-changing operation on `budgets`. See §5/§11 for the full pseudocode and interleaving proof (BUD-052).

**Gap 2 — a header date-range `PATCH` could silently invalidate the Decision C period-containment invariant for already-existing lines.** Decision C (§0, §5) is enforced only at budget-line create/update time: a line is validated against its _parent's current_ `start_date`/`end_date` when the line itself is written. Nothing previously re-validated existing lines when the _parent's_ dates changed afterward — so a `PATCH` narrowing `start_date`/`end_date` could produce an aggregate where an already-existing, previously-valid line's period now falls outside the budget's date range, silently violating Decision C without either the line or the header ever being flagged. **CORRECTION (CTO DECISION):** `BudgetsService.update()` must, whenever `start_date` and/or `end_date` is changing, re-validate _every existing_ `budget_lines` row under that budget against the _proposed_ new date range — while holding the §0b Gap-1 parent-row lock, in the same transaction as the mutation — and reject the entire `PATCH` (no partial mutation; the budget's dates and every line are left exactly as they were) if any existing line's period would fall outside the proposed range. See §5/§10/§12 (BUD-053).

**CTO DECISION (confirmed, v5):** a budget date-changing `PATCH` that would cause any existing budget line's accounting period to fall outside the proposed budget date range is rejected with **HTTP 422 Unprocessable Entity** — consistent with BUD-046's existing 422 for "a currently-valid request cannot be honored because of the resource's existing related data," as distinct from a 400 (malformed/invalid input value) or a 409 (conflicting concurrent state transition, e.g. BUD-009/BUD-024). This status code is now resolved contract, not a proposal pending confirmation; every reference to it elsewhere in this document is treated as decided. BUD-046's existing 422 meaning (empty-budget approval rejection) is unchanged and distinct from this one.

Decisions A/B/C/D (§0) are unchanged by this correction — Gap 1 and Gap 2 are corrections to how Decision B and Decision C are _enforced_ under concurrency and under header mutation, not changes to the decisions themselves.

## 1. Work Item

**ID:** BUDGETING-PHASE-1-FOUNDATION
**Product area:** Sphere Finance → Budgeting / Planning (roadmap status: PLANNED, `docs/roadmap.md` "Finance-First Product Build Strategy").

## 2. Baseline SHA

`main` @ `71964dc2863000741cae1a7278e0d824160c3105` ("docs: add engineering governance protocols"), as instructed. Verified: this is the current local `HEAD`, and `main` does not contain `docs/work-items/`, `src/fixed-assets/`, or any Budgeting code — confirmed by direct inspection (`git status`, `git log`, `find`, `grep`) during this discovery session.

**Isolation confirmed:** `feat/fixed-assets-phase-1` @ `704b7aa0c34a6cb268fd4362c5739935735b87e6` contains an unauthorized, isolated Fixed Assets implementation. `git branch --contains 704b7aa...` returns only `feat/fixed-assets-phase-1`, never `main`. This work item does not read from, reuse, or depend on that branch or its architecture in any way — it is an independent discovery for a different capability area.

## 3. Current Architecture

Sphere Finance (`services/sphere-finance`) is a NestJS service on PostgreSQL 16, Drizzle ORM, with 15 registered top-level modules on `main` (`src/app.module.ts`): `AccountsModule`, `AccountingPeriodsModule`, `JournalEntriesModule`, `GeneralLedgerModule`, `FinancialStatementsModule`, `AccountsPayableModule`, `AccountsReceivableModule`, `BankCashAccountsModule`, `BankTransactionsModule`, `BankReconciliationModule`, `BankReportsModule`, `PaymentProviderSettlementsModule`, `ScheduledReversalsModule`, `TaxConfigurationModule`, `TaxReportsModule` — confirmed via `route-role-matrix.spec.ts`'s own count ("twenty-five controllers").

Standing repository conventions, confirmed by direct inspection of `src/db/schema.ts` and the modules above (not assumed):

- **Tenant/legal-entity scoping:** every Finance-owned table carries `tenant_id`/`legal_entity_id`. RLS is `tenant_id`-only (`FORCE ROW LEVEL SECURITY`, policy files under `drizzle/rls/NNN_*.sql`, applied by `src/db/apply-rls.ts` in filename order); `legal_entity_id` isolation is enforced explicitly in the service layer, never by RLS alone (documented rationale in `schema.ts`'s own header comment, re-confirmed this session).
- **No cross-service FKs:** `tenantId`/`legalEntityId` are plain `uuid` columns validated at the application layer from a verified JWT claim, never a Postgres FK to `db-core`'s tables. Within Finance's own schema (table-to-table), real Postgres FKs are used (e.g. `journal_entries.period_id → accounting_periods.id`).
- **Currency is server-resolved, never client input:** confirmed in both `journal_entries.currency_code` ("Fixed to the legal entity's functional currency at creation... no FX") and `SupplierBillsService.resolveCurrency()`. No multi-currency exists anywhere in the schema (`grep -i "exchangeRate\|currencyMaster"` against `schema.ts`: zero matches).
- **Concurrency-safe uniqueness:** a friendly pre-check `SELECT` for a clean error message, then the real `.insert()`/`.update()` wrapped in try/catch for `PostgresError` code `23505` → `ConflictException` — established in `AccountingPeriodsService.create()`, reused by every subsequent foundation-phase module.
- **Foundation-phase shape:** every "Phase 1" Finance work item to date (Tax/VAT Phase 1 — Tax Codes + Tax Rates; the isolated, unauthorized Fixed Assets Phase 1) is master-data/configuration only: CRUD + a single lock/activation lifecycle transition, zero GL posting. Reporting/variance/calculation layers are consistently deferred to a later, separately-authorized phase (e.g. Tax/VAT Phase 4's VAT Position Report came three phases after Tax/VAT Phase 1).
- **Accounting Periods** (`accounting_periods`: `id, tenant_id, legal_entity_id, code, start_date, end_date, status OPEN|CLOSED, closed_at, closed_by`) is the only period/calendar concept in the schema — there is no separate "fiscal year" table. Every date-bearing document resolves its own `period_id` from the transaction's own date; nothing else invents a parallel calendar.
- **RBAC:** three roles only — `finance.viewer` (read), `finance.poster` (read + transactional write), `finance.admin` (read + write + configuration/lock actions). `AccountingPeriodsController`: `POST` (create) and `PATCH :id/close` are both `finance.admin`-only; `GET` is all three roles. This exact split is the closest existing precedent for a lock/approval action.

## 4. Existing Files/Patterns Inspected

- `services/sphere-finance/src/app.module.ts` (module registration list, current baseline state)
- `services/sphere-finance/src/db/schema.ts` (full file — `chartOfAccounts`, `accountingPeriods`, `journalNumberCounters`, `journalEntries`, and a full-file grep for `employee`, `budget`, `exchangeRate`/`currencyMaster` — all zero matches except `accountingPeriods`/`chartOfAccounts` themselves)
- `services/sphere-finance/src/accounting-periods/accounting-periods.controller.ts` and (by extension) `accounting-periods.service.ts`'s established concurrency-safe create pattern
- `services/sphere-finance/src/tax-configuration/` (`tax-codes.service.ts`, `tax-rates.service.ts`, `tax-configuration.module.ts`) — closest existing "header + related child rows" foundation-phase shape
- `services/sphere-finance/src/route-role-matrix.spec.ts` (current baseline count: twenty-five controllers)
- `services/sphere-finance/drizzle/rls/` (highest file on `main`: `016_tax_configuration_rls.sql`) and `drizzle/migrations/` (highest on `main`: `0022_on_account_allocation_date.sql`)
- `docs/roadmap.md` (full file), `docs/project/PROJECT_STATE.md`, `docs/project/DECISIONS.md` (DEC-004), `docs/project/CURRENT_PHASE.md`, `docs/project/NEXT_TASK.md`
- `docs/engineering/CLAUDE_ENGINEERING_PROTOCOL.md` (full file), `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md`, `docs/engineering/NORYX_CTO_COPILOT_PROTOCOL.md`
- Monorepo service inventory: `services/{api-gateway,identity,sphere-finance}` only — no HRMS/employee service exists anywhere in the repository.

## 5. Proposed Architecture

Two new tables, mirroring the Tax Configuration Foundation's header/child shape and the Accounting-Period-close RBAC split:

**`budgets`** (header/master):
`id uuid PK, tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL, code varchar(32) NOT NULL, name varchar(255) NOT NULL, start_date date NOT NULL, end_date date NOT NULL, currency_code varchar(3) NOT NULL (server-resolved from the legal entity's functional currency, never client input — applying the repo-wide convention directly, not as a later-disclosed deviation this time), status budget_status_enum NOT NULL DEFAULT 'DRAFT' (DRAFT|APPROVED), approved_at timestamptz, approved_by uuid, created_by uuid, created_at/updated_at timestamptz`.
Unique: `(tenant_id, legal_entity_id, code)`. Check: `end_date > start_date` (mirrors `accounting_periods_end_after_start`).

**`budget_lines`** (detail):
`id uuid PK, tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL, budget_id uuid NOT NULL FK → budgets.id, account_id uuid NOT NULL FK → chart_of_accounts.id, period_id uuid NOT NULL FK → accounting_periods.id, amount_minor bigint NOT NULL, created_at/updated_at timestamptz`.
Unique: `(budget_id, account_id, period_id)` — one budgeted amount per account per period per budget. Check: `amount_minor >= 0` — **CTO Decision A**: this is a non-negative magnitude, not a signed debit/credit amount. No polarity column is introduced in this phase; a future budget-vs-actual reporting phase defines its own interpretation of how a magnitude compares against a signed actual balance.

Both FKs (`budget_lines.budget_id`, `.account_id`, `.period_id`) are real Postgres FKs — all three target tables share Finance's own migration lifecycle, per the established within-schema FK convention.

**CTO Decision C — budget/period alignment (application-layer rule, not a DB constraint):** on every `budget_lines` create/update, `BudgetLinesService` must resolve the referenced `period_id`'s `start_date`/`end_date` and the parent `budget_id`'s `start_date`/`end_date`, and reject (400) unless the period's complete date range is contained within the budget's:

```
period.start_date >= budget.start_date
AND
period.end_date   <= budget.end_date
```

This is enforced at the application layer only, not a DB CHECK/trigger — `budget_lines` does not itself store the period's dates (only `period_id`), so the rule requires a join against `accounting_periods` and `budgets` that a single-row CHECK constraint cannot express without duplicating data. This is the same class of disclosed application-layer-only limitation already established for post-APPROVED immutability (see §10). No separate fiscal-year/calendar model is introduced — this rule is expressed entirely in terms of the two date-bearing tables that already exist (`budgets.start_date`/`end_date`, `accounting_periods.start_date`/`end_date`).

Services: `BudgetsService` (header CRUD + `approve()`), `BudgetLinesService` (line CRUD, gated on parent budget status, plus the period-alignment check above). Controllers: `BudgetsController` (`/budgets`), `BudgetLinesController` (nested `/budgets/:budgetId/lines`, mirroring how e.g. `customer-receipts` nests under its parent where a child is meaningless without its parent). New top-level `BudgetingModule`, registered as an additive sibling in `app.module.ts` — not nested inside any existing module, since a budget is owned by a legal entity, not by AP/AR/Tax.

**CTO Decision B — `approve()` requires ≥1 line, verified via parent-row transaction locking (corrected by "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION" — see §0a).** The v2 amendment's design — a single `UPDATE budgets SET status='APPROVED' WHERE status='DRAFT' AND EXISTS(SELECT 1 FROM budget_lines WHERE budget_id=budgets.id)` — is **not sufficient** and is withdrawn. Under PostgreSQL MVCC, that `UPDATE` takes a row lock on the `budgets` row it is writing, but the `EXISTS` subquery is a plain, unlocked read against `budget_lines`. A concurrent `DELETE` of that budget's last line takes no lock the `UPDATE` waits on (different table, different rows), so the two transactions do not serialize against each other: it is possible for `approve()`'s `EXISTS` check to read "line present" from a snapshot that predates a concurrent `DELETE`'s commit, while `approve()`'s own commit lands after that `DELETE`'s commit — producing exactly the forbidden state, `APPROVED` + zero lines. A single atomic statement on the parent table does not by itself serialize against a write to a _different_ table's rows.

**Corrected design — the parent `budgets` row is the serialization point for every budget lifecycle/child-mutation operation, executed under the codebase's default `READ COMMITTED` isolation level (see §11 for why that specific isolation level is what makes the post-lock re-checks below correct, v6):**

`approve()`:

```sql
BEGIN;
SELECT id, tenant_id, legal_entity_id, status
  FROM budgets
 WHERE id = :id
   FOR UPDATE;                          -- (1) acquire the parent-row lock FIRST, before any other check
-- application layer, holding the lock:
--   (2) row not found / wrong tenant or legal entity -> 404
--   (3) status != 'DRAFT' -> 409 (already APPROVED)
SELECT EXISTS (SELECT 1 FROM budget_lines WHERE budget_id = :id);
--   (4) not exists -> 422 "cannot approve an empty budget" (ROLLBACK; no write occurs)
UPDATE budgets
   SET status = 'APPROVED', approved_at = now(), approved_by = :actorUserId
 WHERE id = :id;                        -- (5) only reached once (2)-(4) all pass, still holding the lock
COMMIT;                                 -- (6) releases the lock
```

`BudgetLinesService.create()` / `.update()` / `.delete()` (all three, identically):

```sql
BEGIN;
SELECT id, tenant_id, legal_entity_id, status
  FROM budgets
 WHERE id = :budgetId
   FOR UPDATE;                          -- (1) same lock, same row, same mechanism as approve()
-- application layer, holding the lock:
--   (2) row not found / wrong tenant or legal entity -> 404
--   (3) status != 'DRAFT' -> 409 (budget is no longer editable)
-- (4) perform the line mutation (INSERT / UPDATE / DELETE on budget_lines),
--     including the existing account/period validation, period-alignment
--     check (Decision C), and the pre-check + catch-23505 uniqueness
--     pattern for create() (§11) — all while still holding the lock
COMMIT;                                 -- (5) releases the lock
```

**`BudgetsService.update()` (header PATCH) — corrected to join the same serialization model (§0b Gap 1, CTO DECISION, v4):**

```sql
BEGIN;
SELECT id, tenant_id, legal_entity_id, status, start_date, end_date, code
  FROM budgets
 WHERE id = :id
   FOR UPDATE;                          -- (1) same lock, same row, same mechanism as approve()/line mutations
-- application layer, holding the lock:
--   (2) row not found / wrong tenant or legal entity -> 404
--   (3) status != 'DRAFT' -> 409 (immutable once APPROVED, per existing §5/§10 rule)
--   (4) IF the PATCH changes start_date and/or end_date:
--         SELECT bl.id FROM budget_lines bl JOIN accounting_periods p ON p.id = bl.period_id
--          WHERE bl.budget_id = :id
--            AND (p.start_date < :proposedStartDate OR p.end_date > :proposedEndDate)
--         -- (4a) any row returned -> 422 "date change would invalidate N existing line(s)"
--         --      ROLLBACK; no field is mutated, not even the fields the PATCH
--         --      did not touch (§0b Gap 2, CTO DECISION; status code 422 is also CTO DECISION, see §0b)
UPDATE budgets
   SET name = COALESCE(:name, name), start_date = COALESCE(:startDate, start_date),
       end_date = COALESCE(:endDate, end_date), updated_at = now()
 WHERE id = :id;                        -- (5) only reached once (2)-(4) all pass, still holding the lock
COMMIT;                                 -- (6) releases the lock
```

Step (4)'s re-validation query runs unconditionally whenever either date field is present in the PATCH payload — including when the proposed range is a _widening_ (strictly more permissive) change, which trivially returns zero rows and proceeds; the query does not need to special-case widening vs. narrowing, since both are covered by the same containment check as a natural consequence.

Because every one of these five operations (`approve`, line `create`, line `update`, line `delete`, and header `update`) takes the _same_ `SELECT ... FOR UPDATE` lock on the _same_ `budgets.id` row as its first transactional action, PostgreSQL's row-lock queue enforces a strict total order between any two of them on the same budget — this is what actually closes the race, not the `EXISTS` clause or any single-statement check by itself (see §11 for the full concurrency writeup, including the BUD-052 interleavings for header PATCH specifically):

- **Case A — `approve()` acquires the lock first.** The concurrent final-line `DELETE` blocks on the same row lock until `approve()` commits. Once `approve()` commits (having seen the line and transitioned to `APPROVED`), the blocked `DELETE` transaction proceeds, re-reads `status` under its own lock, finds `APPROVED`, and is rejected (409) at step (3) of the line-mutation sequence above — the line survives.
- **Case B — the final-line `DELETE` acquires the lock first.** `approve()` blocks until the `DELETE` commits. Once the `DELETE` commits (line gone), the blocked `approve()` transaction proceeds, re-reads under its own lock, and its own `EXISTS` check at step (4) now correctly sees zero lines — rejected (422). The budget remains `DRAFT`.
- **Case C — header `update()` (date-narrowing PATCH) acquires the lock first.** A concurrent line `create()` (for a line that would only be valid under the _old_, wider dates) blocks on the same row lock until the PATCH commits. Once the PATCH commits (dates narrowed), the blocked line `create()` proceeds, re-reads the _now-current_ (narrowed) `start_date`/`end_date` under its own lock, and its own Decision C period-alignment check correctly rejects (400) the now-out-of-range line — no stale-dates window exists in which the line could sneak in.
- **Case D — a line `create()`/`update()`/`delete()` acquires the lock first.** A concurrent header date-narrowing `update()` blocks on the same row lock. Once the line operation commits, the blocked header `update()` proceeds, re-reads the _now-current_ set of `budget_lines` under its own lock at step (4) above, and correctly includes the just-committed line in its containment re-validation — no stale-lines window exists in which the PATCH could evaluate against an outdated line set.

No valid interleaving of any two of these five operations can produce either forbidden state — `APPROVED` + zero lines (Decision B), or a committed budget where some line's period falls outside the budget's own dates (Decision C) — because the lock guarantees one of any two competing operations completes (commits or rolls back) entirely before the other's `SELECT ... FOR UPDATE` returns, and every operation re-reads the current aggregate state only _after_ acquiring that lock, never before.

Once `APPROVED`, the header (`start_date`/`end_date`/`code`) and every line under it become immutable at the application layer — no DB-level trigger in this phase (explicitly disclosed limitation, §9). No database trigger is introduced by this correction either — the parent-row lock is an application-transaction-level mechanism using standard PostgreSQL row locking, not new database logic.

## 6. Data Model / Schema Impact

New enum `budget_status` (`DRAFT`, `APPROVED`). Two new tables as above. No changes to any existing table. Next available migration number on the `main` baseline is `0023` (note: the isolated Fixed Assets branch independently used `0023` for its own, different migration — the two histories are unmerged and do not collide today, but this must be renumbered by whichever work item merges second if both are ever combined; flagged here so it is not a silent surprise later).

No schema change is required for CTO Decision C (period alignment) — it is a cross-row application-layer validation over columns that already exist on `budgets` and `accounting_periods` (§5), not a new column or table.

No schema change is required for the §0b v4 corrections either — the parent-row lock (`SELECT ... FOR UPDATE`) is a query-time locking clause, not a schema element, and the date-change existing-line re-validation reads only columns (`budgets.start_date`/`end_date`, `budget_lines.period_id`, `accounting_periods.start_date`/`end_date`) that already exist from the original v1 proposal.

## 7. API / Service Impact

New routes only, all under `/v1/finance` (existing gateway prefix convention):

```
POST   /budgets                        finance.admin
GET    /budgets                        finance.viewer, finance.poster, finance.admin
GET    /budgets/:id                    finance.viewer, finance.poster, finance.admin
PATCH  /budgets/:id                    finance.admin
POST   /budgets/:id/approve            finance.admin
POST   /budgets/:budgetId/lines        finance.poster, finance.admin
GET    /budgets/:budgetId/lines        finance.viewer, finance.poster, finance.admin
GET    /budgets/:budgetId/lines/:id    finance.viewer, finance.poster, finance.admin
PATCH  /budgets/:budgetId/lines/:id    finance.poster, finance.admin
DELETE /budgets/:budgetId/lines/:id    finance.poster, finance.admin
```

No changes to any existing controller/service/route. `route-role-matrix.spec.ts` gains 10 new route entries (twenty-five → twenty-seven controllers, matching the pattern already used when Fixed Assets added its 9 routes on its own isolated branch).

## 8. UI / Module Impact

None. No `apps/web` changes are in scope — this is a backend API foundation phase only, consistent with every other Finance foundation phase to date (Tax/VAT Phase 1, the isolated Fixed Assets Phase 1) having zero UI component in this repository.

## 9. RBAC / Tenant Isolation

- RLS: new `drizzle/rls/017_budgeting_rls.sql` (next available file number on `main`), tenant-id-only policy with `FORCE ROW LEVEL SECURITY` on both new tables, identical text shape to `016_tax_configuration_rls.sql`.
- `legal_entity_id` isolation enforced explicitly in `BudgetsService`/`BudgetLinesService` (every query predicated on it), per the repo-wide convention — not delegated to RLS.
- RBAC exactly as the route table in §7. Header create/update/approve are `finance.admin`-only (mirrors `AccountingPeriodsController`'s create/close split — a budget header lock is a governance action, same class as a period close). Line create/update/delete are `finance.poster` + `finance.admin` (mirrors every other transactional-write split in the repo, e.g. Fixed Assets' asset CRUD on its isolated branch, Supplier Bills, Customer Invoices). All reads are all three roles.
- `route-role-matrix.spec.ts` must account for all 10 new routes with zero unguarded routes (its own "never classifies a route as 'unrecognized'" invariant).

## 10. Accounting / Finance Invariants

- **Zero GL/journal-entry impact.** A budget is a planning artifact, never posted. No code path in this phase writes to `journal_entries`/`journal_lines`. This must be proven by an explicit negative-assertion test (mirrors the isolated Fixed Assets branch's FA-045 pattern, independently re-derived here as the correct proof shape for any Finance work item that claims "no posting").
- `end_date > start_date` on the header (DB CHECK).
- `amount_minor >= 0` on every line (DB CHECK) — **CTO Decision A, resolved:** a non-negative magnitude, not a signed amount. No longer an open question (see §0).
- **CTO Decision B, resolved:** an `APPROVED` budget must contain ≥1 line — **this is a cross-table business invariant, not a single-row constraint**, so it is enforced by parent-row transaction locking, not a DB CHECK. `approve()` rejects a DRAFT budget with zero lines (422). The concurrency mechanism was corrected per "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION" (§0a): `approve()` and every `budget_lines` mutation take `SELECT ... FOR UPDATE` on the parent `budgets` row before any check, closing the race a single `UPDATE ... EXISTS(...)` statement cannot close on its own (see §5, §11 for the full mechanism and both interleaving proofs).
- **CTO Decision C, resolved:** every `budget_lines` row's `period_id` must resolve to an `accounting_periods` row whose complete date range (`start_date`..`end_date`) falls within the parent budget's `start_date`..`end_date`. Enforced at the application layer on create and update (§5); rejected with 400 otherwise. **This invariant must also survive a header date-range PATCH (§0b Gap 2, CTO DECISION, v4):** `BudgetsService.update()` re-validates every existing line under the budget against the _proposed_ new dates, under the same parent-row lock, and rejects the whole PATCH (422 — CTO DECISION, §0b) if any line would fall outside — otherwise a date-narrowing PATCH could silently produce an aggregate that violates Decision C for lines that were valid when written. See §5/§12; acceptance BUD-053.
- Header/line immutability once `APPROVED`, enforced at the application layer (no DB trigger in this phase — same disclosed limitation shape as the isolated Fixed Assets branch's CONTRACT.md §9, independently justified here on the same grounds: nothing downstream reads or posts against this data yet, so a DB-level trigger has no immutable-and-consumed state to protect beyond what the app layer already gates).
- **The parent `budgets` row is the serialization point for the complete budget aggregate (§0b, CTO DECISION, v4)** — not only for `approve()`/line mutations (§0a) but also for `BudgetsService.update()`. Every state-changing operation on a budget or its lines takes the same `SELECT ... FOR UPDATE` lock on the same `budgets.id` row before any check or write, applied transactionally (BEGIN...COMMIT), so the aggregate as a whole — header plus every line — is never observed or committed in a self-contradictory state. See §5/§11; acceptance BUD-052.
- **CTO Decision D, resolved:** multiple `APPROVED` budgets may coexist, including budgets with overlapping date ranges and/or lines referencing the same accounts/periods. Phase 1 does not designate any single budget as "the" authoritative approved budget for a given period/account — there is no exclusivity constraint, application-layer or database-level. A later, separately-authorized phase defines authoritative-budget selection and variance/reporting semantics; this phase's data model and API make no attempt to anticipate that selection rule.
- No actual-vs-budget comparison, variance calculation, or read against `journal_lines`/GL balances anywhere in this phase (§13 Out of Scope).

## 11. Concurrency / Transaction Safety

**Corrected per "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION" (§0a, v3).** This section previously claimed that a single `UPDATE budgets ... WHERE status='DRAFT' AND EXISTS(SELECT 1 FROM budget_lines ...)` statement was sufficient to prevent an `APPROVED` budget from ending up with zero lines. CTO review determined this is false: that `UPDATE`'s row lock covers only the `budgets` row it writes, not the `budget_lines` rows the `EXISTS` subquery reads, so a concurrent `DELETE` on `budget_lines` is never blocked by it and the two transactions do not serialize. That claim is withdrawn and replaced below.

**Further corrected per the second "NORYX CTO PROPOSAL CORRECTION AUTHORIZATION" (§0b, v4).** The v3 model above covered `approve()` and `budget_lines` create/update/delete, but not `BudgetsService.update()` (header PATCH) — an omission, since a header PATCH mutates the same aggregate root. v4 extends the same lock to `update()`, and additionally requires a date-changing PATCH to re-validate every existing line against the proposed new dates under that lock (§0b Gap 2), closing a second gap: a header date PATCH could otherwise silently violate the Decision C period-containment invariant for already-existing lines with no mechanism ever re-checking them.

**Transaction isolation level, made explicit (v6 — precision correction, not a redesign).** [OBSERVED] Every one of the five state-changing operations in this section (`approve()`, `BudgetsService.update()`, and `BudgetLinesService.create()`/`update()`/`delete()`) runs under PostgreSQL's default `READ COMMITTED` isolation level — the same default already used by every other Finance write path in this codebase. `withTenant(tenantId, fn, db)` accepts an optional `PgTransactionConfig` passthrough (`src/db/db.ts`) that, when omitted, leaves Postgres at its session/database default, `READ COMMITTED`; this is exactly how Accounts, AccountingPeriods, and JournalEntries already call it, and Budgeting's five operations follow the identical, unmodified pattern — no `txConfig` override is introduced or required. The one documented exception in this codebase is narrow and does not apply here: `GeneralLedgerService`'s read-only, multi-statement _report_ methods (`getLedger`/`getBalance`/`getTrialBalance`) explicitly opt into `REPEATABLE READ` + `READ ONLY` (`REPORT_TX_CONFIG`, `src/general-ledger/general-ledger.service.ts`), for a wholly different reason — giving several sequential read statements in one report a single consistent point-in-time snapshot — not for row-lock serialization, and it is a read-only config that would be inapplicable to any of Budgeting's five write operations regardless.

Why `READ COMMITTED` specifically is what makes the Case A–D proofs below hold, and why `SELECT ... FOR UPDATE` alone is not sufficient under an arbitrary isolation level: under `READ COMMITTED`, each _statement_ inside a transaction takes its own fresh MVCC snapshot at the moment that statement starts, rather than the whole transaction sharing one snapshot fixed at its first statement (which is how `REPEATABLE READ`/`SERIALIZABLE` behave instead). The parent-row `SELECT ... FOR UPDATE` is what makes a second, competing transaction _wait_ — that part of the mechanism is isolation-level-independent, ordinary row-lock blocking. What `READ COMMITTED` additionally provides, and what the proofs below actually depend on, is what happens the moment that wait ends: once the first transaction commits (or rolls back) and releases the lock, the second transaction's _next_ statement — the `EXISTS` re-check in `approve()`, the `status`/date re-read in `update()`, the existing-line re-validation query — runs under `READ COMMITTED` and therefore takes a brand-new snapshot reflecting whatever the first transaction just committed, not a stale snapshot carried over from before the wait began. This is what lets Case A/B/C/D (below) conclude that the second transaction's business checks "correctly see" the first transaction's committed state — that conclusion is a `READ COMMITTED`-specific fact, not something `FOR UPDATE` guarantees on its own under every isolation level. Under `REPEATABLE READ` or `SERIALIZABLE`, a transaction's snapshot is fixed at its first statement; a post-lock re-check in that transaction would either still be evaluated against the pre-wait snapshot (for a plain read) or trigger a serialization-failure rollback (`40001`) on commit if the two transactions' write sets conflict — either way, not the "re-check sees current committed state" behavior these proofs rely on. This contract does not require `SERIALIZABLE`, and none of the five operations uses it; nothing about the parent-row-lock design in §0a/§0b/this section is redesigned by this clarification — it documents, rather than changes, the isolation level every one of those operations was already going to run under by following the codebase's existing `withTenant` default.

**Parent-budget-row locking — the required serialization mechanism, now covering the complete budget aggregate.** `BudgetsService.approve()`, `BudgetsService.update()`, and every `BudgetLinesService` mutation (`create`, `update`, `delete`) each run inside a transaction whose first statement is:

```sql
SELECT id, tenant_id, legal_entity_id, status FROM budgets WHERE id = :budgetId FOR UPDATE;
```

Every subsequent check (tenant/legal-entity ownership, `status = 'DRAFT'`, the line-existence check for `approve()`, the existing-line date-containment re-check for a date-changing `update()`) and the eventual write happen only after this lock is held, and the lock is released only at `COMMIT`/`ROLLBACK`. Because all five operations acquire the _same_ lock on the _same_ row, PostgreSQL's row-lock queue forces any two of them on the same budget into a strict serial order — this, not any single unlocked check, is what makes both "an APPROVED budget must never have zero lines" (Decision B) and "every line's period stays contained in the budget's dates, including after a header PATCH" (Decision C) hold under every interleaving:

- **Case A — `approve()` locks first.** A concurrent final-line `DELETE` blocks on the same row lock. `approve()` proceeds, sees the line, commits as `APPROVED`. The blocked `DELETE` then proceeds, re-reads `status` under its own lock, finds `APPROVED`, and is rejected (409) — the line is never deleted, the invariant holds.
- **Case B — the final-line `DELETE` locks first.** `approve()` blocks on the same row lock. The `DELETE` proceeds and commits, removing the line. `approve()` then proceeds, re-reads under its own lock, its `EXISTS` check now correctly sees zero lines, and is rejected (422). The budget remains `DRAFT`, the invariant holds.
- **Case C (v4, BUD-052-A) — a header date-narrowing `update()` locks first.** A concurrent line `create()`/`update()`/`delete()` blocks on the same row lock. The PATCH proceeds and commits (dates narrowed). The blocked line operation then proceeds, re-reads the _now-current_ (narrowed) budget dates under its own lock, and its Decision C check correctly evaluates against the new dates — no window in which a line could be written against stale, wider dates.
- **Case D (v4, BUD-052-B) — `approve()` or a line mutation locks first.** A concurrent header `update()` blocks on the same row lock. The approval/line operation proceeds and commits. The blocked header `update()` then proceeds, re-reads the _now-current_ status and line set under its own lock — if it is a date-changing PATCH, its Gap-2 re-validation (§0b, §5) runs against the line set as it now actually exists (including anything the just-committed operation added, changed, or removed), never a stale snapshot.

No valid transaction ordering across any two of these five operations can produce either forbidden state: `APPROVED` + zero lines (Decision B), or a committed aggregate where some line's period falls outside its budget's own dates (Decision C). Whichever transaction's `SELECT ... FOR UPDATE` returns first is guaranteed to fully commit or roll back before the other's `SELECT ... FOR UPDATE` can return, and every operation's business checks run only after that lock is held — never against a snapshot taken before it. The `EXISTS`/re-validation queries inside the locked transaction remain useful (they are how each operation actually determines the current state) — they are simply not, by themselves, the serialization mechanism; the lock is.

This same locking discipline also strengthens (not replaces) the existing per-operation guarantees below:

- Two simultaneous `POST /budgets` with the same `code` in the same `(tenant_id, legal_entity_id)`: exactly one `201`, the other a clean `409` via the `PostgresError` 23505 → `ConflictException` catch path (mirrors `AccountingPeriodsService.create()`). Unaffected by either correction — there is no parent `budgets` row to lock yet when the header itself is being created.
- Two simultaneous `POST /budgets/:budgetId/lines` with the same `(account_id, period_id)` under the same budget: exactly one `201`, the other a clean `409`. The parent-row lock now fully serializes the two `create()` calls (one completes entirely before the other's lock is granted), and the pre-existing `budget_lines(budget_id, account_id, period_id)` unique index plus the 23505-catch pattern remains the mechanism that turns the second, now-deterministically-later `INSERT` into a clean 409 — the lock and the unique constraint are complementary, not alternatives (category 3 and category 1 from §0a).
- `approve()` vs. a concurrent second `approve()` call on the same budget: fully serialized by the same parent-row lock; the second call re-reads `status` under its own lock, finds `APPROVED`, and is rejected 409 — no separate SELECT-then-UPDATE race.
- `approve()` vs. a concurrent final-line `DELETE`/`UPDATE` (CTO Decision B): see Cases A/B above — the race the v3 correction closed.
- Header `update()` vs. `approve()`/any line mutation (§0b Gap 1, CTO Decision B/C's aggregate-level enforcement): see Cases C/D above — the race this v4 correction closes; proven by acceptance BUD-052.
- A date-changing header `update()` vs. the invariant that every existing line stays contained in the budget's dates (§0b Gap 2, Decision C): the same-transaction re-validation query in §5, run under the Case C/D lock ordering, rejects (422 — CTO DECISION) any PATCH that would leave an existing line out of range, with no partial mutation; proven by acceptance BUD-053.

## 12. Scope

- `budgets` and `budget_lines` tables, migration, RLS.
- `BudgetsService`/`BudgetsController`: create, list, get, update (DRAFT only), approve.
- `BudgetLinesService`/`BudgetLinesController`: create, list, get, update, delete — all gated on parent budget status = DRAFT.
- `currencyCode` server-resolved from the legal entity's functional currency (no client input) — applied correctly from the start, not as a later fix.
- Tenant RLS, RBAC, DB-level uniqueness with concurrency-safe conflict handling, DB CHECK constraints.
- `budget_lines.amount_minor` as a non-negative magnitude (CTO Decision A).
- `approve()` requires ≥1 line, enforced via parent-row transaction locking (CTO Decision B, mechanism corrected — §0a/§11).
- Application-layer accounting-period-alignment validation on every budget line create/update (CTO Decision C).
- No exclusivity constraint across multiple `APPROVED` budgets (CTO Decision D).
- Parent-budget-row `SELECT ... FOR UPDATE` locking for `approve()`, `BudgetsService.update()` (header PATCH), and every `budget_lines` create/update/delete (§0a/§0b/§5/§11) — the transaction-serialization mechanism the aggregate-level business invariants (Decisions B and C) require across the complete budget aggregate, not only across line mutations.
- Re-validation of every existing `budget_lines` row against a proposed header date-range change, under the same lock, rejecting the whole PATCH (no partial mutation) if any line would fall outside the new range (§0b Gap 2, CTO Decision C's aggregate-level enforcement).
- Required migration/concurrency/regression verification per §14 below.

## 13. Out of Scope

- Actual-vs-budget variance reporting or any read against `journal_lines`/GL balances (a later, separately-authorized phase — mirrors how the VAT Position Report was deferred three phases after Tax/VAT Phase 1).
- Any journal-entry/GL posting for budgets (budgets never post — see §10).
- A separate "fiscal year"/calendar master table — Phase 1 anchors directly to existing `accounting_periods` rows only (confirmed correct by CTO Decision C, §0/§5).
- Any exclusivity/authoritative-budget-selection logic across multiple `APPROVED` budgets, and any variance/reporting semantics built on top of it (CTO Decision D, §0/§10) — deferred to a later, separately-authorized phase.
- Budget revision history/versioning (e.g. "Budget v2 supersedes v1").
- Multi-scenario budgeting (best-case/worst-case/what-if).
- A multi-step approval workflow beyond the single DRAFT→APPROVED lock (no maker-checker chain, no rejection/return-to-draft transition).
- Bulk import, copy-from-prior-year, or templated budget-line generation tooling.
- Currency conversion / multi-currency budgeting (single functional currency only, matching `journal_entries`).
- Any change to Fixed Assets. The isolated `feat/fixed-assets-phase-1` branch is not read, merged, cherry-picked, rebased, or otherwise touched by this work item.
- Any UI/`apps/web` change (§8).
- Unrelated refactoring or changes to any of the 25 existing controllers.

## 14. Acceptance Matrix

See `docs/work-items/budgeting-phase-1-foundation/ACCEPTANCE.md` (50 scenarios, all `NOT EXECUTED` at discovery stage): 42 from the original v1 discovery, unrenumbered; 5 more (BUD-046..BUD-050) appended by the v2 amendment covering CTO Decisions B/C/D per §0 (BUD-046's description corrected in place by the v3 correction to test the business invariant rather than a specific SQL statement — same ID, no renumbering); 1 more (BUD-051) appended by the v3 correction covering the parent-row-lock concurrency proof per §0a; and 2 more (BUD-052, BUD-053), appended by this v4 correction, covering header-PATCH serialization (§0b Gap 1) and the date-change/existing-line-invalidation invariant (§0b Gap 2) respectively. No ID anywhere in the document has ever been renumbered or removed.

## 15. Test Strategy

- e2e (Jest, real PostgreSQL 16, mirrors every existing `test/*.e2e-spec.ts`): full CRUD + lifecycle + RBAC + RLS-via-API for both resources.
- Raw-SQL proofs (DB-001..005): direct `psql`/raw `postgres` client inserts proving DB-level uniqueness, FK, and CHECK enforcement independent of application code.
- Application-layer period-alignment tests (BUD-047/048/049): e2e assertions that a line's period must be fully contained within its budget's date range, on both boundaries independently (period starts too early; period ends too late), plus the accepted case.
- Empty-budget-approval test (BUD-046, description corrected by this v3 amendment): a black-box business-invariant test — a DRAFT budget with zero lines cannot be approved, the response is 422, and the budget remains DRAFT afterward. It asserts the observable outcome only and does not assert or depend on which specific SQL statement produced it, so it remains valid regardless of the underlying concurrency mechanism.
- Multiple-approved-budgets test (BUD-050): asserts no exclusivity error/conflict when two budgets, both APPROVED, overlap in date range and/or referenced accounts/periods.
- **Concurrency proof test (BUD-051, new in the v3 correction; isolation-level language added v6):** a genuine concurrent-transaction test, not a static/unit-only assertion. It must actually run two overlapping transactions against real PostgreSQL 16 — one calling `approve()` on a budget with exactly one line, the other concurrently `DELETE`-ing that same (last) line — using `Promise.all` (or two separately-held raw connections/transactions, mirroring how `rls-hardening.e2e-spec.ts` and this work item's own CONC-001/002 already drive genuine concurrent Postgres transactions rather than sequential mocked calls), both running under the codebase's default `READ COMMITTED` isolation level (§11, v6) — no test-only isolation-level override is introduced. The test must not assume or force a particular lock-acquisition order — it asserts the invariant holds _regardless_ of which side wins the race: after both operations settle, exactly one of {`approve()` succeeded and the line still exists, `approve()` failed 422/409 and the budget is still DRAFT} is true, and it is never the case that the budget ends up `APPROVED` with zero lines. Because true non-deterministic interleaving is hard to force reliably from a test, the test should be run multiple times (or with both orderings deliberately induced via a controlled delay/advisory-lock-release point in a test-only hook) to gain confidence both Case A and Case B in §11 are actually exercised, not just whichever order happens to win by default.
- **Header-PATCH-serialization concurrency test (BUD-052, new in this v4 correction; isolation-level language added v6):** likewise a genuine concurrent-transaction test against real PostgreSQL 16, run under the same default `READ COMMITTED` isolation level as every operation under test (§11, v6), asserting observable business invariants, not source-code inspection for the presence of `FOR UPDATE`. Cover, at minimum: (A) a header date-narrowing `update()` running concurrently with a line `create()`/`update()`/`delete()` on the same budget, and (B) the reverse ordering (line mutation concurrent with header `update()`) — both directions from §11 Cases C/D. For each direction, run it with both possible lock-acquisition orderings (again via a controlled delay/advisory-lock-release test hook, as in BUD-051) and assert, after both operations settle: no line exists whose period falls outside the budget's _final, committed_ dates, and the operation that lost the race observed the _other_ operation's already-committed effect when it resumed — that is, its post-lock re-check statement took a fresh `READ COMMITTED` snapshot reflecting the winner's commit, never a stale pre-lock snapshot.
- **Date-change/existing-line invalidation test (BUD-053, new in this v4 correction):** create a valid DRAFT budget; add ≥1 valid line(s) whose period(s) are inside the budget's dates; attempt a `PATCH` narrowing `start_date`/`end_date` such that at least one existing line's period would fall outside the proposed range; assert the PATCH is rejected (422, per the §0b CTO DECISION), the budget's dates are unchanged, and every existing line is unchanged — including asserting no partial mutation occurred (e.g. `name` alone did not get updated if it was included in the same PATCH payload). Also cover the inverse boundary: a `PATCH` changing dates such that every existing line's period remains fully contained in the proposed range succeeds normally.
- RLS-003 raw-SQL proof: via the non-superuser `noryx_app` role (`APP_ROLE_DATABASE_URL`), not the pooled `DATABASE_URL` superuser role — the pooled role bypasses `FORCE ROW LEVEL SECURITY` and would produce a meaningless proof (established this session's own prior lesson, re-applied here directly rather than rediscovered).
- Concurrency (CONC-001/002): two simultaneous requests via `Promise.all`, asserting exactly one `201`/one `409` and never two persisted rows.
- `route-role-matrix.spec.ts`: extended with the 10 new routes (RBAC-005).
- Migration safety (MIG-001/002): apply against a fresh database and a seeded database with pre-existing data, confirming zero errors and unchanged pre-existing row counts.
- Full regression: complete pre-existing unit + e2e suites re-run unmodified, typecheck, lint, build.

## 16. Runtime Readiness

Checked this discovery session, cloud implementation environment (`/root/noryx-platform`, non-git working copy used for fast implementation/testing per this work item's established two-environment workflow):

- PostgreSQL 16: was stopped at the start of this session (`pg_isready` → no response); started successfully (`service postgresql start`) and confirmed accepting connections. **Must be (re-)started at the beginning of any implementation session** — not persisted across cloud-container restarts.
- Node v22.22.2, npx 10.9.7 — present.
- `noryx`/`noryx_test` databases and the pre-existing `noryx_migtest_fresh`/`noryx_migtest_seeded` migration-safety test databases were confirmed to exist in an earlier work item's session; not re-verified in this discovery pass (no schema-affecting action was taken).
- **Blocker for implementation (not discovery) — must be resolved before implementing this work item:** the cloud container's `/root/noryx-platform/services/sphere-finance/src/fixed-assets/` directory and related schema/route-matrix edits from the isolated, unauthorized Fixed Assets work are still present in that working copy (confirmed via direct `ls`). Since that implementation is explicitly unauthorized and this work item must not reuse or continue it, the cloud implementation environment must be reset/re-synced to the `main` baseline (`71964dc...`) — not merely have Budgeting code added on top of the current, Fixed-Assets-containing state — before any Budgeting implementation begins. This is a preflight action for the (not-yet-authorized) implementation session, per protocol §8, not something this discovery session performs.
- The pre-existing `drizzle.config.ts` migration-tracking-table collision (documented in the isolated Fixed Assets branch's own completion report as pre-existing repo infrastructure debt, unrelated to any one work item) still applies here too: any implementation session must use the pre-existing local `drizzle.config.testrun.ts` workaround, exactly as before.

## 17. Risks / Blockers

**Resolved by this amendment (no longer open questions):** the v1 discovery proposal carried three open architecture decisions — budget line amount sign convention, budget/period granularity relative to a possible fiscal-year model, and whether multiple concurrently APPROVED budgets may coexist. The CTO has explicitly resolved all three (plus a fourth, budget/period alignment, that v1 had not separately flagged) via "NORYX CTO PROPOSAL AMENDMENT AUTHORIZATION" — see §0 (Decisions A/B/C/D). They are recorded there, not here, and are not restated as risks.

Remaining risks/blockers, carried forward unchanged from v1:

1. **Migration-number reuse across unmerged branches.** `0023` is independently used both by this proposal (once approved) and by the isolated Fixed Assets branch. No collision exists today (unmerged, separate histories), but whichever is merged to `main` second must renumber. Documented so it is not rediscovered as a surprise.
2. **Governance layering.** Three engineering-governance documents now coexist (`CLAUDE_ENGINEERING_PROTOCOL.md`, `NORYX_ENGINEERING_GOVERNANCE.md`, `NORYX_CTO_COPILOT_PROTOCOL.md`, all dated 2026-09-17) alongside the older NOAH-orchestrator layer (`docs/project/*`, DEC-004). No direct conflict was found for this specific action: DEC-004 requires the next Finance item to come from fresh discovery + explicit CTO authorization rather than stale docs, and this very discovery session was explicitly authorized by the original discovery-authorization message, satisfying that rule directly rather than conflicting with it. This amendment is likewise an explicit CTO instruction, so no fresh conflict arises from it either. Surfaced per the Non-Inference Rule/Source-of-Truth hierarchy in `NORYX_ENGINEERING_GOVERNANCE.md`, not silently resolved.
3. **No blocker analogous to Expense Management's.** Confirmed by direct repository inspection: no employee/HR identity concept exists anywhere in the monorepo (`services/{api-gateway,identity,sphere-finance}` only), which is why Expense Management remains unselectable as a foundation-phase candidate and was not proposed here.

## 18. Dependencies

- `chart_of_accounts` (existing, Finance-owned) — `budget_lines.account_id` FK.
- `accounting_periods` (existing, Finance-owned) — `budget_lines.period_id` FK.
- `legalEntities.currencyCode` (db-core, read via the existing cross-service read pattern already used by `SupplierBillsService.resolveCurrency`) — for server-side `currencyCode` resolution.
- No dependency on Fixed Assets, Multi-Currency, or any not-yet-implemented capability.

## 19. Implementation Sequence (proposed, for the not-yet-authorized implementation session)

1. Preflight: reset the cloud implementation environment to the approved baseline (§16 blocker), start PostgreSQL, confirm migration/test tooling.
2. Schema: `budget_status` enum, `budgets`, `budget_lines` tables in `src/db/schema.ts`; generate migration `0023_budgeting_phase_1_foundation.sql`.
3. RLS: `drizzle/rls/017_budgeting_rls.sql`.
4. **Transaction/locking foundation, before any lifecycle, header-update, or line-mutation logic is written:** implement the shared `SELECT ... FOR UPDATE` parent-budget-row-lock helper (§0a/§0b/§5/§11) that `approve()`, `BudgetsService.update()`, and every `budget_lines` create/update/delete will call as their first transactional step. This is a prerequisite for step 5, not an afterthought bolted onto already-written service methods — in particular, `BudgetsService.update()` must not be written first as an unlocked operation and have locking retrofitted afterward.
5. `BudgetsService`/`BudgetsController`, `BudgetLinesService`/`BudgetLinesController`, `BudgetingModule`; register in `app.module.ts`. Implement `approve()`, `update()`, and every `budget_lines` mutation using the step-4 lock helper, exactly per the pseudocode and Case A/B/C/D interleaving requirements in §5/§11 (CTO Decisions B and C), the application-layer period-alignment check on line create/update (§5/§10, CTO Decision C), and the existing-line re-validation on a date-changing header PATCH (§0b Gap 2, §5/§10/§12).
6. Extend `route-role-matrix.spec.ts` with the 10 new routes.
7. e2e suite covering the full acceptance matrix (§14), including BUD-051's and BUD-052's genuine concurrent-transaction proofs and BUD-053's date-change/existing-line test (§15).
8. Raw-SQL DB/RLS proofs, concurrency tests, migration safety (fresh + seeded DB).
9. Full regression (unit, e2e, typecheck, lint, build).
10. Final commit, completion report, verified Git bundle — per protocol §15/§16, stopping at CTO REVIEW, no push.
