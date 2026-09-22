# Finance Core — Journal Engine + General Ledger (Revision 2)

**Milestone 2 technical proposal — for review, not yet approved for implementation.**

Status: DRAFT. No code has been written against this proposal. Scope: `services/sphere-finance` only.

## Revision note

This revises the version you reviewed. Every decision you made is incorporated as a hard requirement below, not a suggestion:

1. **Chart of Accounts is retrofitted to `tenant_id + legal_entity_id` scope before the Journal Engine is built on top of it.** This is now its own increment (§1, §12) — not deferred.
2. **RBAC is `finance.viewer` / `finance.poster` / `finance.admin`**, with `finance.admin` carrying no implicit posting authority (§7).
3. **Periods are one-directional `OPEN → CLOSED`, no reopen**, and reversal is explicitly designed to never require reopening a closed period — a reversal is a new journal with its own date and its own (open) period (§2, §5).
4. Five tightening items you asked for are incorporated as formal rules, not prose: period-overlap prevention (§5), concurrency-safe journal numbering (§1, §3), explicit reversal business rules (§2), a currency extension point (§1), and a narrowly-validated (not merely present) immutability trigger (§3, §9).
5. The four-competing-sources-of-truth anti-pattern is explicitly rejected; §4 is unchanged in principle from v1.

Everything not called out as changed is materially the same as the version you approved in direction: reused tenant-isolation infrastructure, computed GL with no balance-storage table, the same explicit non-scope list, the same test-strategy shape (raw-SQL adversarial tests proving DB-level enforcement, not just API-level).

---

## 0. Why the CoA retrofit comes first

You're right that building the Journal Engine on top of a known structural exception — CoA lacking `legal_entity_id` when every other core entity is supposed to carry it from its first migration — would be building debt into the foundation on day one. Journal lines reference `chart_of_accounts.account_id`; if CoA isn't legal-entity-scoped, the journal engine inherits that ambiguity permanently (which legal entity does a posted line's account "belong to"?). Fixing CoA first means Journal Entries can validate `(tenant_id, legal_entity_id, account_id)` as one coherent unit from day one, matching your diagram exactly:

```
Tenant
 ├── Legal Entity A
 │     └── Chart of Accounts (A's own accounts)
 │            └── Journals (post only against A's accounts)
 └── Legal Entity B
       └── Chart of Accounts (B's own accounts)
              └── Journals (post only against B's accounts)
```

---

## 1. Proposed data model

### 1.1 `chart_of_accounts` — retrofit (increment 2a)

Additive schema change plus a data migration, not a rewrite:

| column                                 | change                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legal_entity_id`                      | **new**, uuid, not null after backfill — resolved from the JWT (`AuthenticatedRequestUser.legalEntityId`), never client-supplied, same trust model as `tenantId` today |
| `chart_of_accounts_tenant_code_unique` | **replaced** — was `(tenant_id, code)`, becomes `(tenant_id, legal_entity_id, code)`: two legal entities under one tenant can both have account code `1000`            |
| `chart_of_accounts_tenant_id_idx`      | **replaced** with an index on `(tenant_id, legal_entity_id)`                                                                                                           |
| `parent_id` hierarchy validation       | **tightened** — a child account's parent lookup must now also match `legal_entity_id`, not just `tenant_id`; a hierarchy can't span legal entities                     |

**No FK to `legal_entities.id`.** Same reasoning already established for `tenant_id` in Milestone 1b: `legal_entities` is a `db-core`-owned table migrated independently; a hard FK across that service boundary would couple migration lifecycles. `legal_entity_id` is validated at the application layer, sourced only from a verified JWT claim.

**RLS stays tenant-scoped only — a deliberate, stated decision, not an oversight.** The existing `tenant_isolation` policy (keyed on `app.current_tenant_id`) is unchanged. I am _not_ proposing a second RLS session variable for legal entity. Reasoning: a legal entity is always a child of exactly one already-RLS-isolated tenant, so a bug that mixed two legal entities _within the same tenant_ would be a data-correctness defect, not a cross-customer security breach — a different severity class than what RLS exists to prevent (System Architecture v1 §3.3 is specifically about tenant isolation). Legal-entity scoping is enforced explicitly in every service-layer query (`WHERE tenant_id = ... AND legal_entity_id = ...`, never relying on RLS to imply the second dimension), and proven by tests (§10). If this project later needs legal-entity-level RLS as a compliance requirement (e.g. independently audited books per entity), that's a clean additive hardening step — but I want you to consciously accept or reject app-layer-only scoping now rather than have it happen by default. **Flagging for your confirmation, not blocking on it** — proceeding with app-layer scoping unless you tell me otherwise.

### 1.2 Data migration for existing rows (part of 2a)

1. Add `legal_entity_id` as **nullable** first (safe, no lock contention on existing rows).
2. Backfill: for each distinct `tenant_id` currently in `chart_of_accounts`, resolve that tenant's default legal entity (`legal_entities.is_default = true`) via a one-off script (same `getPlatformDb()` pattern the e2e test already uses to reach `db-core`'s tables) and set `legal_entity_id` accordingly. If any tenant has no default legal entity, the backfill fails loudly rather than silently leaving nulls — this should never happen per Phase 0's invariant that every tenant gets a default legal entity, and if it did, that's a Phase 0 data bug worth surfacing, not papering over.
3. Verify zero remaining nulls, then `ALTER COLUMN legal_entity_id SET NOT NULL`.
4. Drop and recreate the unique constraint and index as above.
5. Re-run the full Milestone 1b CoA e2e suite (all 13 tests) against the migrated schema — must stay green — plus one **new** test proving the actual point of this retrofit: two accounts with the same `code` under two different legal entities of the _same_ tenant both succeed, and each legal entity's CoA listing shows only its own accounts.

This is real production-shape migration discipline (additive column → backfill → tighten constraint), not a drop-and-recreate, even though the only data that exists today is test/dev data — because the pattern is the one that will actually matter once real tenant data exists.

### 1.3 `accounting_periods` (increment 2b)

| column                     | type                         | notes                                    |
| -------------------------- | ---------------------------- | ---------------------------------------- |
| `id`                       | uuid PK                      |                                          |
| `tenant_id`                | uuid, not null               | RLS-scoped                               |
| `legal_entity_id`          | uuid, not null               | app-layer scoped, same reasoning as §1.1 |
| `code`                     | varchar(50)                  | e.g. `"2026-08"`                         |
| `start_date`, `end_date`   | date, not null               | inclusive range                          |
| `status`                   | enum: `OPEN`, `CLOSED`       | default `OPEN`                           |
| `closed_at`, `closed_by`   | timestamptz / uuid, nullable |                                          |
| `created_at`, `updated_at` | timestamptz                  |                                          |

Unique on `(tenant_id, legal_entity_id, code)`, `CHECK (end_date > start_date)`, **plus overlap prevention (§5)**.

### 1.4 `journal_number_counters` (increment 2b — new since v1, addresses your numbering concern)

A dedicated counter table rather than `MAX(journal_number) + 1`:

| column                 | type                         | notes |
| ---------------------- | ---------------------------- | ----- |
| `tenant_id`            | uuid                         |       |
| `legal_entity_id`      | uuid                         |       |
| `last_assigned_number` | integer, not null, default 0 |       |

PK on `(tenant_id, legal_entity_id)`. Detailed allocation mechanics in §3.

### 1.5 `journal_entries` (header, increment 2b)

| column                         | type                                                      | notes                                                                                                                      |
| ------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | uuid PK                                                   |                                                                                                                            |
| `tenant_id`                    | uuid, not null                                            | RLS-scoped                                                                                                                 |
| `legal_entity_id`              | uuid, not null                                            |                                                                                                                            |
| `journal_number`               | varchar, **nullable**                                     | see §3 — assigned only at posting time, not at draft creation                                                              |
| `status`                       | enum: `DRAFT`, `POSTED`                                   | two states only                                                                                                            |
| `transaction_date`             | date, not null                                            |                                                                                                                            |
| `period_id`                    | uuid, FK → `accounting_periods.id`, nullable until posted | resolved at posting time from `transaction_date`; never client-supplied                                                    |
| `currency_code`                | char(3), not null                                         | **extension point, see §1.6**                                                                                              |
| `memo`                         | text, nullable                                            |                                                                                                                            |
| `reversal_of_journal_entry_id` | uuid, FK → self, nullable                                 | set when this entry _is_ a reversal                                                                                        |
| `reversed_by_journal_entry_id` | uuid, FK → self, nullable                                 | set on the original once reversed; **can only transition NULL → a value, never change again** (enforced by trigger, §3/§9) |
| `created_by`, `posted_by`      | uuid, nullable                                            |                                                                                                                            |
| `posted_at`                    | timestamptz, nullable                                     |                                                                                                                            |
| `created_at`, `updated_at`     | timestamptz                                               |                                                                                                                            |

### 1.6 Currency — the extension point you asked for

For this increment: `journal_entries.currency_code` is fixed to the owning legal entity's `currencyCode` at creation time (no FX, no conversion, no user override). The model is deliberately shaped so multi-currency is additive later, not a redesign:

```
legal entity functional currency  (legalEntities.currencyCode — already exists)
        ↓  (today: always equal, no conversion)
journal transaction currency      (journal_entries.currency_code — this increment)
        ↓
all lines denominated in that currency (journal_lines.debit_minor / credit_minor)
```

When FX lands later, the clean extension is additive columns only — `journal_entries.functional_currency_code`, `exchange_rate`, and optionally `functional_amount_minor` alongside each line's `debit_minor`/`credit_minor` — with existing rows implicitly meaning "exchange rate 1.0, transaction currency = functional currency," which is already true today. No existing column needs to be renamed or reinterpreted.

### 1.7 `journal_lines` (increment 2b)

Unchanged from v1 in shape:

| column                        | type                                      | notes                                                                                                                                                        |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                          | uuid PK                                   |                                                                                                                                                              |
| `tenant_id`                   | uuid, not null                            | denormalized from parent — required for its own RLS policy                                                                                                   |
| `journal_entry_id`            | uuid, FK → `journal_entries.id`, not null |                                                                                                                                                              |
| `line_number`                 | integer, not null                         |                                                                                                                                                              |
| `account_id`                  | uuid, not null                            | validated against `chart_of_accounts` in the **same** `(tenant_id, legal_entity_id)` as the journal entry — this is the concrete payoff of the §1.1 retrofit |
| `debit_minor`, `credit_minor` | bigint, not null, default 0               | minor units, matching the existing `contractValueMinor` convention                                                                                           |
| `description`                 | varchar(500), nullable                    |                                                                                                                                                              |
| `created_at`                  | timestamptz                               |                                                                                                                                                              |

`CHECK (debit_minor >= 0 AND credit_minor >= 0)`, `CHECK (NOT (debit_minor > 0 AND credit_minor > 0))` — unchanged from v1.

### 1.8 No separate balance/ledger storage table — unchanged principle

Reaffirming, not re-litigating: no `account_balances`, `general_ledger_entries`, or `trial_balance_entries` tables. Posted `journal_lines` remain the sole source of truth; everything in §4 is a query, not a stored duplicate.

```
Posted Journal Lines
        ↓
     Ledger
        ↓
 Account Balance
        ↓
  Trial Balance
```

---

## 2. Journal lifecycle / state machine — with your reversal rules made explicit

```
DRAFT ──(post)──▶ POSTED
```

**DRAFT**: freely editable (header + lines), hard-deletable, not required to balance mid-edit. `journal_number` is `NULL` for the entire time an entry is DRAFT.

**POSTED**: immutable at the database level, enforced by trigger (§3, §9), no exceptions except the one narrowly-validated reversal-linkage update.

### Reversal — formal business rules (your item C, made explicit)

`POST /journal-entries/:id/reverse`:

1. Target must be `status = POSTED`.
2. Target must not already be reversed: `reversed_by_journal_entry_id IS NULL`.
3. **Target must not itself be a reversal**: `reversal_of_journal_entry_id IS NULL` — reversing a reversal is rejected (422) in this increment. A dedicated correction workflow is the right place for that case later; silently allowing chained reversals here would blur the audit trail this whole engine exists to protect.
4. The new reversal entry gets:
   - its **own new `journal_number`**, allocated through the same counter mechanism as any other posted entry (§3) — never inherits or derives from the original's number;
   - its **own `transaction_date`** — defaults to "now" (the date the correction is actually being made), independent of the original entry's date; a caller may optionally supply a different date, but it is validated against open periods exactly like any other posting;
   - its `period_id` resolved from **its own** `transaction_date` against the **currently applicable open period** — this is the mechanism that guarantees a reversal of an August entry, posted in September, resolves against the September period and never touches the closed August period;
   - every line's debit and credit swapped, same accounts, same amounts;
   - `reversal_of_journal_entry_id` set to the original's id;
   - `memo` auto-populated (`"Reversal of JE-000123"`) unless the caller supplies their own.
5. Creating and posting the reversal, and setting `reversed_by_journal_entry_id` on the original, all happen **atomically in one transaction** — it is never observable that one succeeded without the other.
6. The original entry is not modified in any other way. Its `transaction_date`, `period_id`, lines, and all financial fields remain exactly as originally posted, regardless of whether its period has since closed.
7. Once posted, the reversal entry is itself just a `POSTED` journal entry — it is immutable under the same trigger as any other posted entry (no special-case needed; this falls out of the general rule, not an extra mechanism).

---

## 3. Posting rules and accounting invariants

`POST /journal-entries/:id/post` — one atomic `withTenant()` transaction. Validates, in order:

1. RBAC — caller has `finance.poster` (§7).
2. `status = DRAFT` (posting an already-posted entry is a no-op error, not idempotent silently).
3. ≥ 2 lines exist.
4. **`SUM(debit_minor) = SUM(credit_minor)`** across all lines — the fundamental invariant. 422 otherwise.
5. Every `account_id` resolves to an existing, **active** account in `(tenant_id, legal_entity_id)` — the retrofit from §1.1 is what makes this check meaningful rather than merely tenant-scoped.
6. `transaction_date` falls inside an `accounting_periods` row for this `(tenant_id, legal_entity_id)` with `status = OPEN`. No covering period at all, or a covering period that is `CLOSED` → rejected. Fail closed, no implicit "always open."
7. **Journal number allocation**, atomically within the same transaction, via the counter table (§1.4):
   ```sql
   INSERT INTO journal_number_counters (tenant_id, legal_entity_id, last_assigned_number)
   VALUES ($tenantId, $legalEntityId, 1)
   ON CONFLICT (tenant_id, legal_entity_id)
   DO UPDATE SET last_assigned_number = journal_number_counters.last_assigned_number + 1
   RETURNING last_assigned_number;
   ```
   This single statement is race-free under concurrent posting: Postgres takes a row lock on the counter row for the `ON CONFLICT DO UPDATE` path, so two concurrent postings for the same legal entity serialize on that row and receive distinct, gap-free (relative to posting order) numbers. Because it runs inside the same transaction as the rest of the posting logic, a later failure in that same transaction rolls the allocation back too — no permanently burned numbers from a failed post. `journal_number` is formatted as `JE-{last_assigned_number:06d}`, scoped per legal entity (two legal entities can each have their own `JE-000001`).
8. Set `status = POSTED`, `posted_at`, `posted_by`, `period_id`; write the paired `audit_logs` row — all in the same transaction.

### Database-level enforcement — narrowly validated, not merely present (your item E)

Three trigger-based protections, all following the existing `prevent_audit_log_mutation()` pattern:

**Balance-invariant backstop** — a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `journal_lines`, firing once at end-of-transaction: for any `journal_entries` row currently `POSTED`, assert `SUM(debit_minor) = SUM(credit_minor)` and `COUNT(*) >= 2` over its lines. This exists purely as a backstop proving the invariant even if application logic were ever bypassed — step 4 above is the real gate; this is the safety net.

**`journal_entries` immutability, exception precisely scoped** — a `BEFORE UPDATE OR DELETE` trigger that, for any row where `OLD.status = 'POSTED'`, rejects the operation _unless all_ of the following hold:

- it's an `UPDATE`, not a `DELETE`;
- `OLD.reversed_by_journal_entry_id IS NULL` (not already reversed — a second reversal-link attempt is rejected, not just a second business-logic call to `/reverse`);
- `NEW.reversed_by_journal_entry_id IS NOT NULL` (must be _setting_ the link, never clearing it back to null);
- every other column is unchanged between `OLD` and `NEW` (`status`, `journal_number`, `transaction_date`, `period_id`, `currency_code`, `memo`, `legal_entity_id`, `tenant_id`, `posted_at`, `posted_by`, all lines' foreign key) — checked column-by-column, not assumed.

This is the "validate the update is actually legitimate" behavior you asked for: the trigger doesn't just special-case the column name `reversed_by_journal_entry_id`, it checks the specific one-time `NULL → value` transition and that nothing else rode along with it.

**`journal_lines` immutability** — `BEFORE UPDATE OR DELETE`, unconditional rejection whenever the parent `journal_entries.status = 'POSTED'`. No exceptions at all — a reversal never touches an original entry's lines, it only creates new ones.

---

## 4. General Ledger approach — unchanged in principle from v1

Pure read layer over posted `journal_lines`, now correctly scoped through `(tenant_id, legal_entity_id)` end-to-end because of the §1.1 retrofit:

- **Account ledger** (`GET /accounts/:id/ledger`) — paginated posted lines, running balance via `SUM(...) OVER (ORDER BY transaction_date, journal_entry_id, line_number)`.
- **Account balance** (`GET /accounts/:id/balance?asOf=...`) — opening (all posted movement strictly before the range) + movement + closing, computed on the fly.
- **Trial balance** (`GET /trial-balance?asOf=...`) — every account with activity, debit/credit totals, and the platform-wide `Σdebits = Σcredits` assertion.

No caching/materialization in this increment — explicitly deferred, not forgotten, per §1.8.

---

## 5. Accounting-period model — with overlap prevention (your item A)

Structurally per §1.3. The uniqueness constraint on `code` alone doesn't stop two overlapping date ranges under different codes, so this needs a real range-exclusion constraint, not just app-level validation:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE accounting_periods
ADD CONSTRAINT accounting_periods_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  legal_entity_id WITH =,
  daterange(start_date, end_date, '[]') WITH &&
);
```

This is enforced by Postgres itself — two periods for the same `(tenant_id, legal_entity_id)` with any overlapping inclusive date range cannot both exist, regardless of `code`. The service layer still does a friendlier pre-check before insert (to return a clean 409 instead of a raw constraint-violation error), but the database is the real guarantee, matching the same "not merely frontend/application validation" bar you set for the debit/credit invariant.

Closing (`PATCH /accounting-periods/:id/close`) remains one-directional — `OPEN → CLOSED`, no reopen endpoint in this increment, per your decision. Closing never touches already-posted entries; it only blocks _new_ postings whose `transaction_date` falls inside it. Reversal is explicitly exempt from ever needing a reopen, per §2.

---

## 6. API surface — unchanged from v1, plus the CoA retrofit's effect

```
# Chart of Accounts (Milestone 1b routes — behavior updated, URLs unchanged)
POST   /accounts                         now requires legalEntityId from JWT; code unique per (tenant, legal entity)
GET    /accounts                         now implicitly scoped to caller's legal entity
GET    /accounts/:id
PATCH  /accounts/:id/archive

# Journal Engine (new)
POST   /journal-entries                  create DRAFT (header + lines)
GET    /journal-entries                  list (filter: status, date range, period)
GET    /journal-entries/:id              detail incl. lines
PATCH  /journal-entries/:id              edit — DRAFT only
DELETE /journal-entries/:id              delete — DRAFT only
POST   /journal-entries/:id/post         DRAFT → POSTED
POST   /journal-entries/:id/reverse      POSTED → new posted reversal (atomic; rejects reversal-of-reversal)

POST   /accounting-periods               create
GET    /accounting-periods               list
PATCH  /accounting-periods/:id/close     OPEN → CLOSED

# General Ledger (new, read-only)
GET    /accounts/:id/ledger
GET    /accounts/:id/balance
GET    /trial-balance
```

A question worth flagging: should `GET /accounts` gain a way for a caller to see _another_ legal entity's CoA within the same tenant (e.g. a controller who works across entities)? Nothing in your instructions asks for this, and I'm not proposing it — every route above is scoped strictly to the caller's own `legalEntityId` from their JWT, matching how `tenantId` already works. If a future need arises for a user to operate across legal entities, that's a token/claims design question (e.g. a "current legal entity" selector), not a Journal Engine concern — flagging so it's a conscious non-goal, not a silent gap like §0 was.

---

## 7. RBAC — your Option B, roles as you specified

```
finance.viewer   view accounts, journals, ledger, balances, trial balance, periods
finance.poster   create journals, edit drafts, post journals, reverse posted journals
finance.admin    manage chart of accounts, create/manage accounting periods, admin controls
```

`finance.admin` does **not** imply posting authority — enforced simply by never putting `finance.admin` in the `@Roles(...)` list on any journal-mutation route. Since `RolesGuard` uses OR-semantics (`requiredRoles.some(r => claims.roles.includes(r))`, unchanged from Milestone 1b), a user needing both capabilities is granted both role strings on their account — no new AND-logic needed in the guard itself.

Concrete route → role mapping:

| route                                                                                                                                                                   | roles                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /accounts`, `GET /accounts/:id`, `GET /journal-entries*`, `GET /accounting-periods`, `GET /accounts/:id/ledger`, `GET /accounts/:id/balance`, `GET /trial-balance` | `finance.viewer`, `finance.poster`, `finance.admin` (any of the three can read) |
| `POST /journal-entries`, `PATCH /journal-entries/:id`, `DELETE /journal-entries/:id`, `POST /journal-entries/:id/post`, `POST /journal-entries/:id/reverse`             | `finance.poster` only                                                           |
| `POST /accounts`, `PATCH /accounts/:id/archive`, `POST /accounting-periods`, `PATCH /accounting-periods/:id/close`                                                      | `finance.admin` only                                                            |

`noryx.module.json`'s `requiredRoles` (the Gateway's coarse pre-filter) grows to `["finance.viewer", "finance.poster", "finance.admin"]` — anyone with any Finance role can reach the module at all; the per-route `@Roles()` above is what actually gates each action, exactly as established in Milestone 1b.

---

## 8. RLS / tenant isolation — unchanged mechanism, wider coverage

No new mechanism, per your standing instruction. `accounting_periods`, `journal_number_counters`, `journal_entries`, and `journal_lines` each get `tenant_id`, `FORCE ROW LEVEL SECURITY`, and a `tenant_isolation` policy identical in shape to `chart_of_accounts`' — added as new numbered files in `drizzle/rls/`, picked up by the existing `apply-rls.ts` in filename order. All access continues through Finance's existing `withTenant()` → `db-core`'s `withTenantScoped()` — the one implementation, not a second one.

Legal-entity scoping (§1.1) is app-layer, consistently applied and tested — see §5's note and §10's new cross-legal-entity test.

---

## 9. Audit behavior

Same shared `db-core` `audit_logs` table, same-transaction writes as the domain change, same pattern as `AccountsService`:

- `CREATE` / `UPDATE` / `DELETE` on `entityType: "journal_entry"` — draft lifecycle, full line set embedded in `beforeState`/`afterState`.
- `POST` on `entityType: "journal_entry"` — the posting event, `afterState` capturing the now-immutable snapshot including the newly-assigned `journal_number`.
- `REVERSE` on `entityType: "journal_entry"` — one audit row against the original (the linkage update) and the reversal's own `CREATE`+`POST` audit rows.
- `CLOSE` on `entityType: "accounting_period"`.
- `CREATE`/`ARCHIVE` on `entityType: "chart_of_accounts"` — unchanged from 1b, now additionally scoped by `legal_entity_id` in the row's own data (no `audit_logs` schema change needed — `legal_entity_id` already exists on that table from Phase 0, just newly populated for Finance's writes).

---

## 10. Test strategy

Extends `test/accounts.e2e-spec.ts`'s pattern (real Postgres, synthetic JWTs, `supertest`, a real second raw connection for adversarial DB-level tests):

**2a (CoA retrofit) tests:**

- All 13 existing Milestone 1b tests re-run and green post-migration.
- **New**: two accounts with the same `code` under two different legal entities of the same tenant both succeed; each legal entity's `GET /accounts` shows only its own accounts (this is the actual proof the retrofit works, not just that migrations ran).
- Parent-account hierarchy rejects a `parentId` belonging to a different legal entity.

**2b (schema/DB layer) tests:**

- Balance invariant proven at two layers: API rejects an unbalanced post (422); a second raw connection attempting to leave a `POSTED` entry unbalanced is rejected by the constraint trigger (direct analogue of the audit-log raw-SQL immutability test).
- `journal_entries`/`journal_lines` raw `UPDATE`/`DELETE` against `POSTED` rows rejected by trigger.
- Reversal-linkage trigger: a raw attempt to set `reversed_by_journal_entry_id` alongside any other field change is rejected; a raw attempt to change it a second time (already non-null) is rejected.
- Concurrency: N simultaneous postings for the same legal entity all succeed with distinct, correctly-sequential `journal_number`s (a real concurrency test, not just code review of the SQL).
- Period overlap: creating a second period whose range overlaps an existing one for the same legal entity is rejected by the exclusion constraint.

**2c (journal CRUD/posting/reversal) tests:**

- RBAC matrix per §7's table (viewer/poster/admin × each route).
- Cross-tenant isolation: list/get/post/reverse/close all return 404 across tenants, with write-attempts verified to have had zero effect — same pattern as 1b's archive test.
- Period controls: no covering period → rejected; `CLOSED` covering period → rejected; `OPEN` covering period → accepted.
- Reversal correctness: new number, new date, resolves against currently-open period even when the original's period is `CLOSED`; original untouched except the linkage; reversing an already-reversed entry rejected; reversing a reversal rejected.

**2d (GL) tests:**

- Post a known set of entries, assert ledger running balances and trial balance match hand-computed values, assert `Σdebits = Σcredits` platform-wide.

**Unit tests:** DTO validation for journal entry creation (≥2 lines, no line with both debit and credit, no line with neither, non-negative amounts) — mirrors `create-account.dto.spec.ts`.

---

## 11. Explicitly out of scope

Unchanged from v1's list (AP, AR, invoicing, bank/UPI/card reconciliation, inventory accounting, WIP, cost accounting, profitability, financial statements, budgeting/forecasting, executive dashboards, POS integrations, AI accounting), plus, confirmed by this revision:

- Multi-currency conversion/revaluation (extension point only, §1.6).
- Approval workflows beyond `DRAFT → POSTED`.
- Period reopening (§5) — deferred, not designed away; reversal is explicitly independent of it (§2).
- Materialized/cached balance or ledger storage (§1.8, §4).
- Reversal-of-reversal / chained corrections — needs a dedicated correction workflow later (§2).
- Per-legal-entity RLS session-variable enforcement (§1.1) — app-layer only for now, flagged for your confirmation.
- Cross-legal-entity user access (§6) — not designed, not built.
- Recurring/templated journal entries, attachments/supporting documents, balance sheet/P&L formatting.

---

## 12. Implementation plan — increments

Per your instruction, the CoA retrofit is its own increment and comes first; everything else depends on it.

**2a — Chart of Accounts legal-entity retrofit.**
Schema migration (nullable column → backfill → NOT NULL → constraint/index swap), `AccountsService`/`AccountsController`/`CreateAccountDto` updated to resolve and enforce `legalEntityId`, full existing CoA e2e suite re-verified green, new cross-legal-entity test added and passing. Own commit. I'll stop and report before 2b, same rhythm as Milestone 1's 1a/1b checkpoint — this is the highest-risk step (a real data migration on an already-shipped table) and deserves its own review point even though you didn't explicitly ask for a pause here.

**2b — Journal Engine schema and database layer.**
`accounting_periods`, `journal_number_counters`, `journal_entries`, `journal_lines` tables; RLS policies; the three triggers (balance backstop, entry immutability, line immutability); the period-overlap exclusion constraint. No API surface yet. Verified via direct-SQL tests proving each DB-level guarantee independently of any application code. Own commit.

**2c — Journal entry service and API.**
Draft CRUD, posting (full validation chain + numbering), reversal (full business-rule set from §2), RBAC per §7, audit logging. Full e2e suite per §10. Own commit.

**2d — General Ledger read layer.**
Account ledger, account balance, trial balance endpoints and tests. Own commit.

Each increment gets `pnpm typecheck`/`lint`/`test`/`build` plus the live-Postgres round trip before moving to the next, same discipline as Milestone 1. I will not start 2b until 2a is reviewed, matching the rhythm you set for Milestone 1.

---

## Open items still needing your explicit confirmation

1. **§1.1** — app-layer-only legal-entity scoping (no second RLS session variable). I'm proceeding on this basis unless you object.
2. **§6** — cross-legal-entity user access is explicitly not being designed in this increment; confirming that's fine for now.

Everything else in this revision directly implements a decision you already made. Once you confirm (or override) those two remaining items, I'll treat this as approved and begin with 2a.
