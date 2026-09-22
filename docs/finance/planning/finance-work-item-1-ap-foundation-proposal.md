# Finance Implementation Work Item 1 — AP Foundation

**Status: DISCOVERY / IMPLEMENTATION-READINESS PROPOSAL — not implemented.** No production code, tests, dependencies, CI, migrations, or database state were modified to produce this document. Stops here for CTO/Product Owner review per the standing delivery process.

Baseline verified: local `HEAD` = `origin/main` = `a930878` ("docs: rebaseline finance-first product roadmap"), working tree clean except the two pre-existing, out-of-scope items (`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md` modification, `docs/hardening/` untracked directory).

This is the first document in a new numbering track: **Finance Work Item** (not the closed Milestone 2 `2a`–`2d` lettering, and not a Milestone 3.x hardening Work Item). Per the locked Finance-First Product Build Strategy in `docs/roadmap.md`, Milestones 3.3–3.5 remain deferred and are not touched by this proposal or its eventual implementation.

---

## 0. What was read before writing this

Full reads: `docs/roadmap.md`, `docs/architecture.md`, `docs/security.md`, `docs/plug-and-play-modules.md`, `docs/finance-journal-engine-proposal.md` (408 lines), `docs/finance-2c-journal-entry-service-proposal.md` (873 lines), `docs/finance-2d-general-ledger-read-layer-proposal.md` (1445 lines). Full code inspection: `services/sphere-finance/src/**` (every module: accounts, accounting-periods, journal-entries, general-ledger, tenant, common, db, health), `packages/db-core/src/**`, `packages/db-core/drizzle/rls/*.sql`, `services/sphere-finance/drizzle/rls/*.sql`, `services/sphere-finance/drizzle/constraints/*.sql`, `packages/shared-types/src/**`, `packages/event-bus-client/src/**`, plus a repository-wide grep for `supplier|vendor|bill|invoice|payment|tax|VAT|AP|AR` across all non-generated files. All findings below are grounded in that reading, cited by file:line where the underlying discovery captured it.

---

## 1. Current implementation baseline

Sphere Finance's Accounting Core (`services/sphere-finance`) is functionally complete and verified at `a930878`: Chart of Accounts, Legal Entity retrofit, Journal Engine (schema, draft CRUD, posting, reversal), General Ledger read layer (ledger, balance, trial balance). 165 e2e test cases across 8 spec files, all real-Postgres, zero unit-mocked business logic. This is a single NestJS service (`services/sphere-finance`), not a set of separate microservices — Accounts, Accounting Periods, Journal Entries, and General Ledger are four modules inside one app (`app.module.ts`), sharing one Postgres connection pool, one Drizzle schema file (`src/db/schema.ts`), one RLS regime, and one `noryx.module.json` manifest (`basePath: "/v1/finance"`).

Zero AP-adjacent code exists anywhere in the repository. A repository-wide grep for `supplier`, `vendor`, `bill`, `invoice`, `payment`, `tax`, `VAT`, `accounts payable/receivable` returns no matches in any schema, migration, service, controller, or DTO file — every match is either documentation (roadmap/proposal files correctly describing AP as unbuilt scope) or two unrelated code comments about _subscription_ non-payment handling (`packages/db-core/src/schema.ts:42`, `services/identity/src/auth/auth.service.ts:68`), which are about Noryx's own SaaS billing, not Sphere Finance AP. This confirms AP Foundation is a clean, greenfield build with no naming collisions and nothing to reconcile against.

## 2. What already exists and can be reused

Everything AP needs to integrate with, without modification:

- **`chart_of_accounts`** (`services/sphere-finance/src/db/schema.ts:58-98`) — AP bill lines, the AP control account, and payment bank/cash accounts all reference existing `chartOfAccounts` rows. No new account-type or CoA change required.
- **`accounting_periods`** (`:126-165`) — AP bill/payment posting resolves and locks the covering `OPEN` period exactly as `JournalEntriesService` does, via the same table.
- **`journal_entries` / `journal_lines` / `journal_number_counters`** (`:191-339`, `:174-182`) — AP posts real rows into these tables directly (see §9). Same numbering sequence, same immutability triggers, same balance-invariant trigger — no schema change to any of them.
- **Tenant-scoped DB client** (`packages/db-core/src/generic-client.ts` `withTenantScoped`/`createTenantScopedDbClient`, wired locally in `services/sphere-finance/src/db/db.ts`) — AP's own `db.ts` will merge `apSchema` with `auditLogs`/`legalEntities`/`chartOfAccounts`/`accountingPeriods`/`journalEntries`/`journalLines`/`journalNumberCounters` from the existing schema objects, exactly as the current `db.ts:9-15` merges `auditLogs`/`legalEntities` into Finance's own schema.
- **RLS pattern** (`packages/db-core/drizzle/rls/001_enable_rls.sql`, `003_null_tenant_bypass_fix.sql`; `services/sphere-finance/drizzle/rls/001_enable_rls.sql`, `002_journal_engine_rls.sql`) — the exact 3-line `tenant_isolation` `USING` clause (`IS NULL` / `= ''` / tenant match) is reused verbatim for every new AP table.
- **Immutability trigger patterns** (`drizzle/constraints/003_journal_entries_immutability_trigger.sql` narrow-exception style; `004_journal_lines_immutability_trigger.sql` zero-exception style) — reused for AP header/line tables (§21).
- **`audit_logs`** (`packages/db-core/src/schema.ts:218-243`) — reused as-is for every AP mutation (`entityType: "supplier"|"supplier_bill"|"supplier_payment"`), no schema change.
- **Auth/RBAC** (`@noryx/auth-core`'s `JwtAuthGuard`, `RolesGuard`, `@Roles()`, `@CurrentUser()`, `requireTenantContext()`) — reused unmodified; AP reuses the existing `finance.viewer`/`finance.poster`/`finance.admin` roles (§16), no new role namespace.
- **Response envelope / error shape** (`packages/shared-types/src/api-envelope.ts`) — `ApiSuccess<T>`, `ApiError`, `PaginatedResponse<T>` reused unmodified; AP's own `*Meta` types extend `PaginatedMeta` the same way `LedgerMeta` does.
- **Validation pipe convention** (`main.ts`'s global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`) — reused unmodified; every AP DTO follows the same `class-validator` style.
- **Testing conventions** (real-Postgres e2e, `getPlatformDb()`+service's own `getDb()`, signed JWTs via a `tokenFor()` helper, cross-tenant/cross-legal-entity/concurrency describe blocks) — reused unmodified (§23).
- **API Gateway routing** (`plug-and-play-modules.md`'s manifest contract) — **zero gateway change needed.** AP routes live under the existing `sphere-finance` manifest's `basePath: "/v1/finance"`; the gateway's longest-prefix-match routing already sends everything under `/v1/finance/**` to this one service.

## 3. What is completely missing

No supplier/vendor entity, no bill/invoice entity, no payment entity, no allocation entity, no AP-specific settings, numbering, RLS, immutability, controllers, services, DTOs, or tests exist anywhere. Every artifact described in §5 onward is new.

## 4. Functional scope of AP Foundation

In scope: Supplier master (create/edit/list/detail/deactivate); AP setup (one configurable AP control GL account, and an optional tax-input GL account, per legal entity); Supplier Bills (draft creation with distributed lines, edit/delete while draft, posting into the Journal Engine, per-line tax amount as a flat entered value — **not** a tax engine); Payment recording against one or more bills (partial and full allocation, posting into the Journal Engine against a manually-selected GL cash/bank account); AP subledger balance per supplier; supplier statement (chronological bill/payment history with running balance); AP ageing report (bucketed by due date, across suppliers).

Terminology note: "Supplier Bills" and roadmap.md's "Purchase invoices" line item are treated as the same entity here — one bill/invoice concept, not two — consistent with standard ERP usage and with keeping this Work Item from splitting into speculative sub-entities the roadmap doesn't actually distinguish.

Out of scope: see §19.

## 5. Database entities/tables required

All new tables live in `services/sphere-finance/src/db/schema.ts` (the same file that owns `chart_of_accounts`/`journal_entries`), following the existing repo rule that Finance's schema file "intentionally does NOT include `@noryx/db-core`'s shared tables" and generates migrations only for tables Finance itself owns (`services/sphere-finance/src/db/schema.ts:20-27`). No table gets a Postgres FK to `tenants`/`legal_entities` (cross-service boundary rule, `:29-48`); tenant/legal-entity scoping is RLS (tenant) + explicit service-layer predicate (legal entity), exactly as `chart_of_accounts` does today.

```
suppliers
  id                    uuid PK, default random
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  code                  varchar(32), not null
  name                  varchar(255), not null
  is_active             boolean, not null, default true
  payment_terms_days    integer, nullable          -- e.g. 30 for "Net 30"; used for due-date default + ageing
  tax_registration_no   varchar(64), nullable       -- informational only (e.g. VAT number); not used by any tax logic
  default_expense_account_id  uuid, nullable, FK -> chart_of_accounts.id  -- pre-fills new bill lines; not enforced
  created_by            uuid, nullable
  created_at, updated_at  timestamptz
  UNIQUE (tenant_id, legal_entity_id, code)
  INDEX (tenant_id, legal_entity_id)

ap_settings
  tenant_id                  uuid, not null
  legal_entity_id            uuid, not null
  ap_control_account_id      uuid, not null, FK -> chart_of_accounts.id   -- the single AP liability account for this legal entity
  tax_input_account_id       uuid, nullable, FK -> chart_of_accounts.id   -- required only if any bill line ever carries tax_amount_minor > 0
  created_at, updated_at     timestamptz
  PRIMARY KEY (tenant_id, legal_entity_id)

ap_number_counters
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  counter_type          enum('BILL','PAYMENT'), not null
  last_assigned_number  integer, not null, default 0
  PRIMARY KEY (tenant_id, legal_entity_id, counter_type)

supplier_bills
  id                    uuid PK, default random
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  supplier_id           uuid, not null, FK -> suppliers.id
  supplier_bill_number  varchar(50), not null       -- the SUPPLIER's own invoice/bill number (external reference, not unique in our system)
  internal_reference    varchar(20), nullable        -- our own "AP-BILL-000123", assigned only at posting (mirrors journal_number)
  status                enum('DRAFT','POSTED','VOID'), not null, default 'DRAFT'
  payment_status         enum('UNPAID','PARTIALLY_PAID','PAID'), not null, default 'UNPAID'  -- only meaningful once status='POSTED'
  bill_date             date, not null
  due_date              date, nullable               -- defaults to bill_date + supplier.payment_terms_days at create time; independently editable
  currency_code         varchar(3), not null          -- resolved server-side from legal entity's functional currency, same as journal_entries
  subtotal_minor        bigint, not null              -- sum of line amount_minor
  tax_minor             bigint, not null, default 0   -- sum of line tax_amount_minor
  total_minor           bigint, not null              -- subtotal_minor + tax_minor
  paid_minor            bigint, not null, default 0   -- denormalized running total from posted allocations
  journal_entry_id      uuid, nullable, FK -> journal_entries.id   -- set at posting; the traceability link roadmap.md:183 flags as currently missing
  period_id             uuid, nullable, FK -> accounting_periods.id -- resolved at posting, same pattern as journal_entries.period_id
  memo                  text, nullable
  created_by, posted_by uuid, nullable
  posted_at             timestamptz, nullable
  created_at, updated_at  timestamptz
  UNIQUE (tenant_id, legal_entity_id, internal_reference)  -- NULL-distinct, unlimited DRAFT rows, same as journal_entries' number uniqueness
  INDEX (tenant_id, legal_entity_id)
  INDEX (supplier_id)
  INDEX (due_date) WHERE status = 'POSTED'
  CHECK (total_minor = subtotal_minor + tax_minor)
  CHECK (paid_minor >= 0 AND paid_minor <= total_minor)

supplier_bill_lines
  id                uuid PK, default random
  tenant_id         uuid, not null            -- denormalized from parent, required for this table's own RLS policy (same reason journal_lines.tenant_id is denormalized)
  bill_id           uuid, not null, FK -> supplier_bills.id, ON DELETE CASCADE
  line_number       integer, not null
  account_id        uuid, not null, FK -> chart_of_accounts.id   -- the expense/asset account this cost distributes to
  description       varchar(500), nullable
  amount_minor      bigint, not null           -- net line amount
  tax_amount_minor  bigint, not null, default 0
  created_at        timestamptz
  UNIQUE (bill_id, line_number)
  INDEX (account_id)
  CHECK (amount_minor > 0)
  CHECK (tax_amount_minor >= 0)

supplier_payments
  id                        uuid PK, default random
  tenant_id                 uuid, not null
  legal_entity_id           uuid, not null
  supplier_id               uuid, not null, FK -> suppliers.id
  internal_reference        varchar(20), nullable    -- "AP-PAY-000123", assigned at posting
  status                    enum('DRAFT','POSTED'), not null, default 'DRAFT'
  payment_date              date, not null
  amount_minor              bigint, not null          -- total payment amount; must equal sum(allocations) to post
  bank_account_gl_account_id uuid, not null, FK -> chart_of_accounts.id  -- manually selected GL cash/bank account (no real bank-account entity yet — see §19/§20)
  currency_code             varchar(3), not null
  journal_entry_id          uuid, nullable, FK -> journal_entries.id
  period_id                 uuid, nullable, FK -> accounting_periods.id
  memo                      text, nullable
  created_by, posted_by     uuid, nullable
  posted_at                 timestamptz, nullable
  created_at, updated_at    timestamptz
  UNIQUE (tenant_id, legal_entity_id, internal_reference)
  INDEX (tenant_id, legal_entity_id)
  INDEX (supplier_id)
  CHECK (amount_minor > 0)

supplier_payment_allocations
  id             uuid PK, default random
  tenant_id      uuid, not null          -- denormalized, same reasoning as supplier_bill_lines.tenant_id
  payment_id     uuid, not null, FK -> supplier_payments.id, ON DELETE CASCADE
  bill_id        uuid, not null, FK -> supplier_bills.id
  amount_minor   bigint, not null
  created_at     timestamptz
  UNIQUE (payment_id, bill_id)
  INDEX (bill_id)
  CHECK (amount_minor > 0)
```

One deliberate deviation from the existing `journal_number_counters` shape is called out explicitly: rather than two near-identical tables (`bill_number_counters`, `payment_number_counters`), `ap_number_counters` adds one `counter_type` discriminator column. This is a minor, contained deviation — not a "speculative abstraction" — kept because it avoids duplicating an otherwise-identical 3-column table definition twice for no behavioral difference.

## 6. Relationships between entities

```
legal_entities (existing)         chart_of_accounts (existing)          accounting_periods (existing)
        |                                 |    |    |                              |
        |                                 |    |    |                              |
   suppliers ─────────< supplier_bills ───┘    |    └───< supplier_bills (period_id)
        |                     |                |
        |                     ├──< supplier_bill_lines ──> chart_of_accounts (account_id)
        |                     |
        |                     └──> journal_entries (journal_entry_id, set at posting)
        |
        └──< supplier_payments ──> chart_of_accounts (bank_account_gl_account_id)
                     |         └──> journal_entries (journal_entry_id, set at posting)
                     |         └──> accounting_periods (period_id, set at posting)
                     |
                     └──< supplier_payment_allocations >── supplier_bills
                                  (many-to-many join: one payment can pay many bills,
                                   one bill can be paid by many payments — partial settlement)

ap_settings (1:1 per legal_entity) ──> chart_of_accounts (ap_control_account_id, tax_input_account_id)
ap_number_counters (1 row per legal_entity per counter_type)
```

`supplier_payment_allocations` is the many-to-many join enabling partial/full settlement in both directions: a single payment can be split across several bills, and a single bill can be paid off across several payments over time.

## 7. AP lifecycle / state machine

Two independent axes, deliberately not conflated into one status field — mirrors the existing codebase's own separation of concerns (journal entries only ever have one axis, DRAFT/POSTED, because they have no analogous "settlement" concept; AP bills need a second axis because they do).

**Bill posting-lifecycle (`status`):**

```
DRAFT ──(POST /bills/:id/post)──> POSTED
  │
  └──(DELETE /bills/:id, DRAFT only)──> [deleted]

POSTED is terminal for `status` in this Work Item. No VOID-of-posted, no edit-after-post,
no reopening to DRAFT — matching the existing journal_entries posted-immutability convention
exactly. Correcting a posted bill is an explicit non-goal (§19) requiring a future
credit-note/correction work item, the same posture the Journal Engine takes toward
reversal-of-reversal.
```

**Bill payment-lifecycle (`payment_status`, meaningful only once `status = POSTED`):**

```
UNPAID ──(allocation posted, 0 < paid_minor < total_minor)──> PARTIALLY_PAID ──(paid_minor = total_minor)──> PAID
UNPAID ──(allocation posted, paid_minor = total_minor in one step)───────────────────────────────────────> PAID
```

`payment_status` only ever moves forward (more paid, never less) in this Work Item — there is no "unapply a payment" action; that is an explicit non-goal (§19).

**Payment posting-lifecycle (`status`):**

```
DRAFT ──(POST /payments/:id/post)──> POSTED
  │
  └──(DELETE /payments/:id, DRAFT only)──> [deleted]

POSTED is terminal — no void/edit-after-post, same posture as bills.
```

## 8. Posting/accounting behavior

**Bill posting** produces exactly one balanced journal entry:

```
Dr  <line 1 account_id>          amount_minor
Dr  <line 2 account_id>          amount_minor
...
Dr  <ap_settings.tax_input_account_id>    SUM(tax_amount_minor)     -- only if tax_minor > 0
Cr  <ap_settings.ap_control_account_id>   total_minor
```

Balanced by construction: `total_minor = subtotal_minor + tax_minor = SUM(line.amount_minor) + SUM(line.tax_amount_minor)`, which is exactly the sum of the debit side. If any line has `tax_amount_minor > 0` and `ap_settings.tax_input_account_id` is not configured, posting fails `422` — the same "fail closed" posture the Journal Engine takes toward posting into a period with no covering open period.

**Payment posting** produces exactly one balanced journal entry:

```
Dr  <ap_settings.ap_control_account_id>       amount_minor
Cr  <bank_account_gl_account_id>              amount_minor
```

Two lines, trivially balanced. Posting requires `SUM(allocations.amount_minor) = amount_minor` (no partially-allocated "payment on account" in this Work Item — see §19) and, for each allocated bill: bill is `POSTED`, bill's `(supplier_id, legal_entity_id)` matches the payment's, and `allocation.amount_minor <= bill.total_minor - bill.paid_minor` at allocation time (re-checked under lock at posting — see §9's concurrency treatment).

## 9. Interaction with the existing Journal Engine

**Key architectural decision, stated explicitly because the discovery surfaced a real ambiguity:** `JournalEntriesService.create()` and `.post()` are each documented and implemented as owning their own `withTenant` transaction (`services/sphere-finance/src/journal-entries/journal-entries.service.ts:68-73`, `:292-297`). Calling them as two sequential service calls from AP's posting flow would mean "bill marked POSTED" and "journal entry created and posted" are two separate transactions — an AP bill could end up `POSTED` with no journal entry (or vice versa) if the process crashes between the two calls. That is not acceptable for a Finance capability, and the existing services offer no in-process, single-transaction "create-and-post-atomically-with-caller's-own-writes" method to call instead.

**Resolution: AP's posting services do not call `JournalEntriesService`.** They instead perform the equivalent inserts directly against the shared `journal_entries`/`journal_lines`/`journal_number_counters` tables (already importable from the same service's `src/db/schema.ts`), replicating the exact validation/locking/numbering/audit sequence `JournalEntriesService.post()` already establishes (`journal-entries.service.ts:292-398`, the "10-step transaction"): lock the AP document first via `SELECT ... FOR UPDATE`, validate status/lines/balance, re-validate every referenced account is still active and in-scope, resolve+lock the covering `OPEN` accounting period via the same helper pattern as `resolveAndLockOpenPeriod`, allocate a journal number from the _same_ `journal_number_counters` row (AP-generated journal entries share the ordinary `JE-NNNNNN` sequence — there is no separate AP-only number series, matching "posts through the existing Journal Engine" literally), insert the header+lines directly, then write the `audit_logs` row — all inside AP's _own_ single `withTenant` transaction that also updates the bill/payment's own status, `journal_entry_id`, `period_id`, and (for payments) each allocated bill's `paid_minor`/`payment_status`.

This satisfies "posts through the existing Journal Engine where applicable, not a parallel posting mechanism" (`docs/roadmap.md`'s completion-gate language) in the sense that matters: real `journal_entries`/`journal_lines` rows, same schema, same numbering, same immutability triggers, same balance-invariant trigger, indistinguishable in the General Ledger from a manually-posted entry. It does **not** call the existing `JournalEntriesController`/`JournalEntriesService` classes as a library, because those classes' transaction boundaries are the wrong shape for what AP needs — this is not a deficiency in the Journal Engine, just a mismatch between "an HTTP-oriented, self-transacted service" and "a sub-ledger that needs its own writes to be atomic with a journal posting." **No change to `JournalEntriesModule`, `JournalEntriesService`, `JournalEntriesController`, or their tests is required or proposed** — this is new AP code depending on existing shared tables, not a modification of working functionality, consistent with the standing instruction not to touch the Journal Engine unless a real dependency proves the existing interface insufficient (it does, for atomicity — but the fix lives entirely on the AP side).

## 10. Interaction with GL/account balances

No General Ledger code changes of any kind. Because AP posts real rows into `journal_entries`/`journal_lines` against real `chart_of_accounts` rows, the existing `GET /accounts/:id/ledger`, `GET /accounts/:id/balance`, and `GET /trial-balance` endpoints automatically reflect every posted bill and payment with zero AP-specific code in the GL read layer — exactly the "no parallel posting mechanism" property the roadmap's completion gate asks for.

One important distinction worth stating precisely: AP's own `GET /suppliers/:id/balance` (§17) is **not** a GL query. The GL only knows about accounts, not suppliers — there is no `supplier_id` anywhere in `journal_entries`/`journal_lines`. AP's supplier balance is computed independently from `supplier_bills`/`supplier_payment_allocations` (the sub-ledger). This means the sub-ledger total (sum of every supplier's open balance) and the GL's own balance of the AP control account are two independently-derived numbers that **must always agree** if AP's posting logic is correct — this is a natural, hard invariant, and §23 proposes a dedicated reconciliation test for exactly this property, the same spirit as the existing balance-invariant trigger's "prove the invariant even if application logic were ever bypassed" philosophy (applied here as a test, since a cross-table DB trigger spanning `journal_lines` and `supplier_bills` would be considerably more invasive than the value it adds at this stage).

## 11. Legal entity requirements

Every referenced id — `supplier_id`, every bill line's `account_id`, `ap_settings.ap_control_account_id`/`tax_input_account_id`, `bank_account_gl_account_id` — must belong to the same `(tenant_id, legal_entity_id)` as the bill/payment itself. Enforced twice, mirroring the Journal Engine's own two-time-validation discipline: a soft check at draft create/edit time, and an independent, authoritative re-validation at posting time (an account or supplier could be deactivated between draft creation and posting). RLS covers `tenant_id` only; `legal_entity_id` scoping is an explicit predicate in every query, exactly as `chart_of_accounts`/`accounting_periods`/`journal_entries` already do (`services/sphere-finance/src/db/schema.ts:38-48`'s documented rationale applies unchanged to every new AP table).

## 12. Accounting-period requirements

Bill posting resolves+locks the `OPEN` accounting period covering `bill_date`; payment posting resolves+locks the `OPEN` period covering `payment_date` — in both cases via the exact same "no covering period → 422, covering period is CLOSED → 422, `SELECT ... FOR UPDATE` to block a concurrent period close" pattern `JournalEntriesService.post()` already implements. No new period concept, no AP-specific period logic. Closing a period never touches already-posted bills/payments, exactly as it never touches already-posted journal entries.

## 13. Tax/VAT considerations

Explicitly minimal for this Work Item: `supplier_bill_lines.tax_amount_minor` is a flat, manually-entered value per line — no tax rate table, no jurisdiction logic, no automatic calculation, no tax return/reporting. It exists only so a bill's total can include tax and post a single aggregate debit to a configured tax-input account, which is the minimum needed for the total to be accounting-correct without inventing a tax engine. Full tax configuration, rate tables, calculation, posting rules, and reporting are the separate, already-roadmapped **Tax/VAT** capability area — building it is not part of AP Foundation, and this Work Item does not attempt to anticipate its shape beyond leaving `tax_amount_minor` as a plain integer column a future Tax capability could populate automatically instead of manually.

## 14. Currency considerations

Every bill and payment is created in the legal entity's single functional currency, resolved server-side exactly like `journal_entries.currency_code` — never client-supplied, never convertible. There is no foreign-currency bill/payment concept in this Work Item (no FX rate, no functional-vs-transaction-currency distinction). This mirrors the Journal Engine's own current constraint precisely and requires no new pattern; the documented Multi-Currency extension point (`docs/finance-journal-engine-proposal.md:110-122`, additive columns only) is the correct future home for foreign-currency AP, not something this Work Item should partially anticipate.

## 15. Payment/settlement architecture

A payment is created with its full set of allocations in one request (`supplier_id`, `payment_date`, `amount_minor`, `bank_account_gl_account_id`, `allocations: [{billId, amountMinor}, ...]`, optional `memo`) in `DRAFT` status, then posted via a separate `POST /payments/:id/post` call — the same two-step create-then-post shape as bills and journal entries, so a payment can be reviewed before it becomes an immutable accounting event. Posting requires `SUM(allocations.amountMinor) === amount_minor` (full allocation only — see §19 for the "payment on account" non-goal) and locks every allocated bill via `SELECT ... FOR UPDATE` (in a fixed order — ascending `bill_id` — to avoid deadlock against a concurrent second payment touching an overlapping bill set) before re-validating each bill still has sufficient remaining balance (`bill.total_minor - bill.paid_minor >= allocation.amount_minor`), so two concurrent payments cannot together over-allocate a single bill. Partial settlement is native to the model: `payment_status` simply reflects `paid_minor` versus `total_minor` after each posted allocation, and a bill can receive allocations from any number of separate payments over time until fully paid.

## 16. Required APIs

All under the existing `/v1/finance` prefix (no gateway change — §2). RBAC reuses the three existing roles; no new role namespace.

```
POST   /v1/finance/suppliers                    create                     finance.admin
GET    /v1/finance/suppliers                     list                      any finance.* role
GET    /v1/finance/suppliers/:id                 detail                    any finance.* role
PATCH  /v1/finance/suppliers/:id                 edit                      finance.admin
POST   /v1/finance/suppliers/:id/deactivate      soft-deactivate           finance.admin

POST   /v1/finance/ap/settings                    create/update (upsert)   finance.admin
GET    /v1/finance/ap/settings                    detail                   any finance.* role

POST   /v1/finance/bills                          create DRAFT              finance.poster
GET    /v1/finance/bills                          list                      any finance.* role
GET    /v1/finance/bills/:id                      detail incl. lines        any finance.* role
PATCH  /v1/finance/bills/:id                       edit — DRAFT only        finance.poster
DELETE /v1/finance/bills/:id                       delete — DRAFT only      finance.poster
POST   /v1/finance/bills/:id/post                  DRAFT → POSTED            finance.poster

POST   /v1/finance/payments                        create DRAFT incl. allocations   finance.poster
GET    /v1/finance/payments                        list                      any finance.* role
GET    /v1/finance/payments/:id                    detail incl. allocations  any finance.* role
DELETE /v1/finance/payments/:id                     delete — DRAFT only      finance.poster
POST   /v1/finance/payments/:id/post                DRAFT → POSTED           finance.poster

GET    /v1/finance/suppliers/:id/balance            open payable balance     any finance.* role
GET    /v1/finance/suppliers/:id/statement           bill/payment history     any finance.* role
GET    /v1/finance/ap/ageing                         bucketed ageing report   any finance.* role
```

Response shapes follow the existing conventions exactly: `ApiSuccess<T>` for single-resource reads, `PaginatedResponse<T>` for lists/statements with an extended `*Meta` type where useful (mirroring `LedgerMeta extends PaginatedMeta`), `ApiError` for failures. Balance/ageing endpoints borrow the GL read layer's `asOf`-date query-param convention.

## 17. Required e2e/unit tests

New spec files under `services/sphere-finance/test/`, real Postgres, following the established pattern exactly (signed JWTs via a local `tokenFor()` helper, full Nest app boot with the same pipe/interceptor/filter wiring as `main.ts`, `getPlatformDb()` + the service's own `getDb()` for seeding):

- `suppliers.e2e-spec.ts` — CRUD, RBAC, cross-tenant/cross-legal-entity isolation (404-not-403 convention).
- `ap-settings.e2e-spec.ts` — upsert, validation that the configured accounts are the correct type and in-scope.
- `supplier-bills.e2e-spec.ts` — draft CRUD, posting (balanced JE creation, journal-number allocation, period resolution/lock, account re-validation at posting), immutability after posting, cross-tenant/entity isolation.
- `supplier-payments.e2e-spec.ts` — draft creation with allocations, posting (JE creation, bill `paid_minor`/`payment_status` updates, full-allocation requirement), partial vs. full settlement scenarios, immutability after posting.
- `ap-concurrency.e2e-spec.ts` — concurrent posting of two payments against overlapping bills (must not over-allocate), concurrent bill-post vs. period-close (same shape as the existing `general-ledger-concurrency.e2e-spec.ts`/journal-entries concurrency tests).
- `ap-reports.e2e-spec.ts` — supplier balance, statement (ordering/running-balance correctness), ageing buckets.
- `ap-gl-reconciliation.e2e-spec.ts` — the invariant from §10: sum of every supplier's open balance equals the GL's own balance of the AP control account, checked after a sequence of bill/payment postings.
- DTO unit specs (`*.dto.spec.ts`) for every new DTO, mirroring `create-account.dto.spec.ts`'s style.
- `route-role-matrix.spec.ts` extended to cover the new AP controllers (it is a repo-wide reflection test, not per-module — confirm during implementation whether it auto-discovers new controllers or needs an explicit addition).

## 18. Required UI/API integration points

None in this Work Item. `apps/web` currently has only a login screen and a dashboard nav stub (`docs/roadmap.md`'s Phase 0 checklist) — no Finance UI of any kind exists yet, including for the already-complete Accounting Core. AP Foundation is API-only, consistent with how Accounting Core itself was built. A Finance web UI (for Accounting Core and AP alike) is unscoped future work, not part of this proposal.

## 19. Explicit non-goals for this work item

- Approval workflow beyond the existing `DRAFT → POSTED` shape (no multi-step approval chain, no delegation) — matches the Journal Engine's own stated non-goal and the roadmap's "Approval history (beyond DRAFT→POSTED)" still being marked planned.
- Purchase Orders, goods receipts, or 3-way matching — Procurement→AP integration is explicitly "not yet designed" per `docs/roadmap.md`'s cross-module integration section.
- Real bank account entities, bank feeds, or bank reconciliation — Banking & Cash Management is its own future capability area; payments here use a manually-selected GL account only.
- Automatic tax calculation, tax rate configuration, or tax reporting — Tax/VAT is its own future capability area (§13).
- Multi-currency/FX bills or payments (§14).
- Credit notes, debit notes, or any bill correction beyond editing a still-DRAFT bill — a posted bill is immutable; correcting one is a future correction-workflow Work Item, the same posture as the Journal Engine's reversal-of-reversal non-goal.
- "Payment on account" / partially-allocated payments (a payment must fully allocate at posting time in this Work Item).
- Unwinding or voiding a posted payment or bill.
- Recurring bills, bill templates, or attachments/supporting documents.
- Supplier Portal or any `TENANT_EXTERNAL`-facing surface — that is explicitly Phase 5 scope.
- Any web UI work (§18).
- AR, and any AP/AR netting.

## 20. Future dependencies on AR, Banking, Cash, Tax, etc.

- **AR Foundation** (separate future Work Item) mirrors this shape for customers/receivables; the two should stay structurally parallel (e.g., an eventual shared "party" concept between suppliers and customers is worth considering then, not now — introducing it here would be exactly the speculative abstraction the standing instructions warn against).
- **Banking & Cash Management**: once real bank account entities exist, `supplier_payments.bank_account_gl_account_id` is the natural seam to extend (add a `bank_account_id` alongside or instead of the raw GL account reference) rather than a redesign.
- **Tax/VAT**: once a tax engine exists, it would populate `supplier_bill_lines.tax_amount_minor` automatically instead of manual entry; the column and posting behavior already accommodate that without change.
- **Multi-Currency**: foreign-currency bills/payments would need the same additive-columns extension the Journal Engine proposal already documents for `journal_entries` (§14).
- **Procurement → AP** cross-module integration: a future Procurement module creating bills automatically from goods receipts is the documented but "not yet designed" roadmap integration point; this Work Item's `POST /bills` API is the seam it would call.
- **Financial Reporting**: `GET /v1/finance/ap/ageing` and the supplier balance/statement endpoints directly satisfy the roadmap's currently-unchecked "AP/AR ageing reports" and "Account statements" line items for the AP side.

## 21. Migration strategy

New tables added to the existing `services/sphere-finance/src/db/schema.ts` (one owning schema file, per the established convention — no new schema file, no new service). `pnpm --filter @noryx/sphere-finance run generate` (exact package name to confirm during implementation against `services/sphere-finance/package.json`) produces the new drizzle-kit-numbered migration + snapshot automatically — no hand-naming.

New RLS file `services/sphere-finance/drizzle/rls/003_ap_rls.sql` (continuing the existing `001_enable_rls.sql`, `002_journal_engine_rls.sql` sequence), covering all six new tables with the exact `tenant_isolation` policy shape, **including the `= ''` bypass-fix branch from day one** — the existing sphere-finance RLS files predate that fix and don't yet have it; new AP RLS should not repeat that gap.

New constraint file(s) under `services/sphere-finance/drizzle/constraints/`, continuing past the existing `001`–`004`: immutability triggers for `supplier_bills` (narrow-exception style, mirroring `003_journal_entries_immutability_trigger.sql` — only `paid_minor`/`payment_status` may change once `status = POSTED`), `supplier_bill_lines` (zero-exception style, mirroring `004_journal_lines_immutability_trigger.sql`), `supplier_payments` and `supplier_payment_allocations` (zero-exception style, immutable in full once `POSTED`).

`pnpm --filter @noryx/sphere-finance run migrate` (drizzle-kit migrate + `apply-rls.ts`) applies both; `apply-db-constraints.ts` applies the new constraint file(s), exactly as today. As with every prior Finance increment, actually applying this to a real database is a deployment action run from an environment with real network/credentials — this sandbox has none (confirmed repeatedly across this engagement) and would only rehearse against local dev/test Postgres, per the same operational-follow-up posture recorded for Work Item 7 and Milestone 3.2.

## 22. Implementation sequence

Proposed as four sub-increments, each its own commit and review checkpoint, mirroring the existing 2c-1/2c-2 risk-based split:

1. **AP-1a — Supplier master + AP settings.** Schema, RLS, controllers/services/DTOs for `suppliers` + `ap_settings`. Lowest risk, no Journal Engine interaction, unblocks everything else.
2. **AP-1b — Supplier Bills.** Schema (`supplier_bills`, `supplier_bill_lines`, `ap_number_counters`), draft CRUD, and posting (the highest-risk piece — direct `journal_entries`/`journal_lines` insertion per §9). Depends on AP-1a.
3. **AP-1c — Supplier Payments + allocations.** Schema, draft creation with allocations, posting (JE creation + bill `paid_minor`/`payment_status` updates + concurrency-safe multi-bill locking per §15). Depends on AP-1b.
4. **AP-1d — AP reporting.** Supplier balance, statement, ageing — read-only, lowest risk of the four, depends on AP-1b/AP-1c data existing to query.

Each sub-increment gets its own e2e spec file(s) from §17 and its own acceptance-criteria checklist at close, following the existing proposal-document convention (status banner, `§0` "what was read," numbered sections, closing acceptance criteria).

## 23. Verification strategy

Real-Postgres e2e throughout, no unit-mocked business logic — matching the Accounting Core's own 165-case suite discipline exactly. Full command checklist per sub-increment: `pnpm typecheck` / `lint` / `test` / `build` across the monorepo, plus a live-Postgres round trip, plus RLS re-verification (`relrowsecurity`/`relforcerowsecurity` on every new table, non-superuser `noryx_app` role re-check) before that sub-increment is considered closed — the same bar `finance-2d-general-ledger-read-layer-proposal.md`'s §16 acceptance criteria set. The reconciliation invariant in §10 (sub-ledger total = GL control-account balance) is treated as a first-class, always-tested property, not an incidental check — consistent with this codebase's practice of proving invariants with adversarial tests rather than assuming them from code inspection alone (e.g. the GL read-consistency fix `8ad9ea0` was itself driven by exactly this kind of adversarial concurrency testing).

---

## Explicitly out of scope for this proposal document itself

Designing AR, Banking, Tax, or Multi-Currency in any detail beyond the extension seams named in §20; any UI design; any change to `JournalEntriesModule`/`GeneralLedgerModule`/`AccountsModule`/`AccountingPeriodsModule`'s existing behavior; Milestone 3.3/3.4/3.5 hardening of any kind; any commit, bundle, or push.

## CTO decisions required before implementation begins

1. **Confirm AP lives inside `services/sphere-finance`** (this proposal's strong recommendation, per §2/architecture evidence) rather than as a new, separate service.
2. **Confirm the posting-integration approach in §9** — direct schema-level insertion into `journal_entries`/`journal_lines` inside AP's own transaction, not calling `JournalEntriesService` as a library — as the correct resolution to the atomicity mismatch identified there.
3. **Confirm the functional scope boundary in §4/§19** — specifically, that Payment recording/allocation is included in "AP Foundation" (as `docs/roadmap.md:161` itself lists "Payment processing, Payment allocation" under the Accounts Payable capability area) rather than split into a separate future Work Item.
4. **Confirm the four-part implementation sequence in §22**, or direct a different split/ordering.

No implementation will begin until the above is answered, per the standing discovery/proposal process. Per your instruction: no hardening work item is proposed or implied by this document, and Milestones 3.3–3.5 remain deferred and untouched.
