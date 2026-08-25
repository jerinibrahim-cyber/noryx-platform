# Finance Implementation Work Item 1b — Supplier Bills

**Status: DISCOVERY / IMPLEMENTATION-READINESS PROPOSAL — not implemented.** No production code, tests, dependencies, CI, migrations, or database state were modified to produce this document. Stops here for CTO/Product Owner review per the standing delivery process.

Baseline verified: local `HEAD` = `fdcc2b7` ("feat(finance): implement AP-1a supplier master and settings"), parent `a930878`, pushed to `origin/main` and bundle-verified. Working tree clean except the two pre-existing, out-of-scope items (`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md` modification, `docs/hardening/` untracked directory) — neither touched to produce this document.

## 0. What was read before writing this

This is a continuation of discovery already performed for AP-1a (`docs/finance-work-item-1-ap-foundation-proposal.md`), which itself sketched the full AP Foundation shape including bills (§5, §7-§10, §16, §21, §22). Rather than repeat that discovery, this document re-verifies the as-built state and refines the bill-specific design against real code:

- `services/sphere-finance/src/db/schema.ts` (full file, current) — `chartOfAccounts`, `accountingPeriods`, `journalNumberCounters`, `journalEntries`, `journalLines`, `suppliers`, `apSettings` as they exist today, post-AP-1a.
- `services/sphere-finance/src/journal-entries/journal-entries.service.ts` (full file) — the exact 10-step `post()` transaction (lock → status → line-count → balance → account re-validation → period resolve+lock → numbering → commit → audit), `reverse()`, and the private helpers (`resolveAndLockOpenPeriod`, `allocateJournalNumber`, `findByIdInTx`) this Work Item's bill-posting logic must replicate rather than call.
- `services/sphere-finance/src/journal-entries/journal-entries.controller.ts` (full file) — route shapes, `@Roles()` assignment (`finance.poster` for every write, `finance.viewer`/`finance.poster`/`finance.admin` for reads), `@HttpCode(200)` on `/post`.
- `services/sphere-finance/src/accounts-payable/**` (all AP-1a source — `suppliers.service.ts`, `ap-settings.service.ts`, controllers, DTOs) — the as-built patterns AP-1b's own services/controllers/DTOs must match exactly.
- `services/sphere-finance/src/db/db.ts` — `withTenant`/`TxClient` shape, `auditLogs`/`legalEntities` inclusion.
- `services/sphere-finance/drizzle/constraints/002_balance_invariant_trigger.sql`, `003_journal_entries_immutability_trigger.sql`, `004_journal_lines_immutability_trigger.sql` (full files) — the deferred balance-invariant trigger and the narrow-exception / zero-exception immutability trigger patterns this Work Item's own `supplier_bills`/`supplier_bill_lines` triggers are modeled on.
- `services/sphere-finance/drizzle/rls/003_ap_rls.sql` (full file) — the exact `tenant_isolation` policy template (including the `= ''` bypass-fix branch) new AP-1b tables reuse verbatim.
- `services/sphere-finance/src/route-role-matrix.spec.ts` — confirmed this is a repo-wide, not per-module, reflection test; new controllers must be added explicitly to both its import list and its `EXPECTED`/`actual` arrays (the exact gap AP-1a already hit and fixed).
- `services/sphere-finance/src/journal-entries/dto/create-journal-entry.dto.ts`, `create-journal-line.dto.ts` (full files) — the nested-array DTO validation convention (`@ValidateNested({ each: true })` + `@Type(() => ...)`, custom `ValidatorConstraint` for the single-sided/nonzero line rule) this Work Item's bill-line DTO reuses.
- `services/sphere-finance/src/accounts/dto/create-account.dto.ts` — the `code` field's safe-charset `@Matches` pattern, reused unchanged for `supplier_bills` where applicable (it is not — bills have no user-supplied code; see §4).
- `services/sphere-finance/package.json` — confirmed exact script names: `generate` (`drizzle-kit generate`), `migrate` (`drizzle-kit migrate && ts-node src/db/apply-rls.ts`). `apply-db-constraints.ts` is invoked separately: `services/sphere-finance/src/db/apply-db-constraints.ts` is this service's own script (fixed to its own `drizzle/constraints/` directory, per `.github/workflows/ci.yml`'s `pnpm --filter @noryx/sphere-finance exec ts-node src/db/apply-db-constraints.ts`) — `packages/db-core/src/apply-db-constraints.ts` is a _separate_, unrelated script for db-core's own role-catalog constraint. (Correction applied post-approval, during implementation: an earlier draft of this document misstated this as one shared script; verified against `ci.yml` and both scripts' fixed `__dirname`-relative paths before running anything.)
- `docs/roadmap.md` — re-confirmed AP Foundation's product-sequence position and the "Sphere Finance Functionally Complete" completion-gate language this Work Item's design must satisfy (real Journal Engine posting, no parallel posting mechanism).

No `git log`/`git diff`/schema/migration/test file was modified while producing this document.

## 1. Recap: what AP-1a already built (baseline for AP-1b)

- `suppliers` (tenant+legal-entity-scoped supplier master) and `ap_settings` (one AP control account + optional tax-input account per legal entity) — both live, migrated, RLS-enabled, RBAC-enforced, audited, e2e-tested (211/211 passing as of `fdcc2b7`).
- `AccountsPayableModule` already exists (`src/accounts-payable/accounts-payable.module.ts`) with a doc comment explicitly anticipating sibling modules for AP-1b/1c/1d — AP-1b adds a `supplier-bills/` sibling under the same `accounts-payable/` tree, registered in that same module, not a new top-level module.
- `SuppliersService.validateAccountRefOrThrow` and `ApSettingsService.validateControlAccountOrThrow`/`validateTaxAccountOrThrow` establish the exact "must exist, must be active, must be in this (tenantId, legalEntityId)" pattern this Work Item's bill-line account validation reuses verbatim (with no type restriction — see §4).
- `ap_number_counters` does **not** exist yet. AP-1a deliberately deferred it (schema.ts's doc comment: "no consumer until AP-1b"). AP-1b is that consumer — see §4 for the exact shape, including one deliberate refinement of the AP-1a proposal's original sketch (flagged in §24).

## 2. Scope of AP-1b

**In scope:**

- `supplier_bills` + `supplier_bill_lines` schema, RLS, immutability/balance triggers.
- A bill-numbering counter (`ap_number_counters`, bill-only for now — see §24).
- Draft CRUD for bills (create, list, get, edit, delete — DRAFT only).
- Bill posting: DRAFT → POSTED, producing exactly one balanced journal entry via direct `journal_entries`/`journal_lines` insertion (§6), replicating `JournalEntriesService.post()`'s validation/locking/numbering discipline.
- AP control-account and tax-input-account integration via the existing `ap_settings` row.
- Full RBAC/RLS/audit/e2e coverage matching AP-1a's bar.

**Explicitly out of scope for AP-1b** (deferred to AP-1c/1d or later, per AP-1a proposal §19/§20 — restated here narrowly for bills):

- Payments, payment allocation, partial/full settlement (`supplier_payments`, `supplier_payment_allocations` — AP-1c).
- `payment_status` transitions away from `UNPAID` (the column and its two allowed AP-1c-driven values exist on `supplier_bills` from day one — see §4 — but nothing in AP-1b ever writes anything other than `UNPAID` to it; that is entirely AP-1c logic, not built here).
- Supplier balance, statement, ageing reports (AP-1d).
- Credit/debit notes or any bill correction after posting (a posted bill is immutable — matches the Journal Engine's reversal-of-reversal non-goal posture).
- Automatic tax calculation/rate tables — `tax_amount_minor` remains a flat, manually-entered per-line value (AP-1a proposal §13, unchanged).
- Multi-currency bills (§14 below — no FX, single functional currency, unchanged from AP-1a proposal §14).
- Any web UI.

## 3. What already exists and is reused directly (no changes)

- `JournalEntriesModule`/`JournalEntriesService`/`JournalEntriesController` — **zero changes**. AP-1b depends on the shared `journal_entries`/`journal_lines`/`journal_number_counters` tables directly (§6), not on the service/controller classes — same architectural decision AP-1a's proposal already made and this Work Item reconfirms (§6 below restates it concretely for bills).
- `AccountingPeriodsService` — zero changes. Bill posting resolves+locks the covering `OPEN` period using the identical query/lock shape `JournalEntriesService.resolveAndLockOpenPeriod` already implements (re-derived inline in the new bill-posting code, per the "AP does not call JournalEntriesService" decision — see §6).
- `GeneralLedgerService`/`GeneralLedgerController` — zero changes. Once a bill posts real `journal_entries`/`journal_lines` rows, `GET /accounts/:id/ledger`, `/accounts/:id/balance`, `/trial-balance` reflect it automatically with no AP-specific GL code (§7).
- `chart_of_accounts`, `accounting_periods` — zero schema changes; referenced by real Postgres FK from the new tables (same-service, same-migration-lifecycle reasoning already established for `journal_lines.accountId`/`suppliers.defaultExpenseAccountId`).
- `suppliers`, `ap_settings` — zero schema changes; `supplier_bills.supplier_id` FKs to `suppliers.id`; bill posting reads `ap_settings.apControlAccountId`/`taxInputAccountId`.
- `@noryx/auth-core` (`JwtAuthGuard`, `RolesGuard`, `@Roles()`, `@CurrentUser()`, `requireTenantContext()`) — reused unmodified.
- `audit_logs` — reused unmodified, same tenant-scoped append-only table, new `entityType` values (`"supplier_bill"`).
- `withTenant`/`TxClient` (`src/db/db.ts`) — reused unmodified.
- `route-role-matrix.spec.ts` — extended (not replaced), same convention as AP-1a's extension.

## 4. Database schema

Both tables added to the existing `services/sphere-finance/src/db/schema.ts` (no new schema file — same file that owns `chart_of_accounts`/`journal_entries`/`suppliers`). Same cross-service FK policy as every existing table: no Postgres FK to `tenants`/`legal_entities` (app-layer validated from the verified JWT); real Postgres FK to every same-service table (`suppliers`, `chart_of_accounts`, `accounting_periods`, `journal_entries`). RLS is tenant-only; `legal_entity_id` isolation is an explicit service-layer predicate on every query, unchanged convention.

```
ap_number_counters                                          -- new
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  last_assigned_number  integer, not null, default 0
  PRIMARY KEY (tenant_id, legal_entity_id)
  -- Deliberately NO counter_type discriminator column in AP-1b — see §24
  -- for why this refines the AP-1a proposal's original two-counter-type
  -- sketch, and what AP-1c must decide when payment numbering is added.

supplier_bills                                               -- new
  id                    uuid PK, default random
  tenant_id             uuid, not null
  legal_entity_id       uuid, not null
  supplier_id           uuid, not null, FK -> suppliers.id
  supplier_bill_number  varchar(50), not null    -- the SUPPLIER's own invoice number; external reference, not unique in our system, not validated for format
  internal_reference    varchar(20), nullable     -- our own "BILL-000123"; assigned only at posting, mirrors journal_number's null-while-DRAFT/immutable-after-POST shape exactly
  status                enum('DRAFT','POSTED'), not null, default 'DRAFT'          -- narrower than AP-1a proposal's original 3-value sketch — VOID is not built in AP-1b, see §9
  payment_status        enum('UNPAID','PARTIALLY_PAID','PAID'), not null, default 'UNPAID'   -- column exists now (structural, not optional); AP-1b writes only 'UNPAID', never transitions it — see §2/§9
  bill_date             date, not null
  due_date              date, nullable            -- defaults to bill_date + supplier.paymentTermsDays at create time if the supplier has one configured, else null; independently editable while DRAFT
  currency_code         varchar(3), not null       -- resolved server-side from legal entity's functional currency, identical to journal_entries.currencyCode resolution
  subtotal_minor        bigint, not null           -- server-computed: SUM(line.amountMinor)
  tax_minor             bigint, not null, default 0  -- server-computed: SUM(line.taxAmountMinor)
  total_minor           bigint, not null           -- server-computed: subtotal_minor + tax_minor
  paid_minor            bigint, not null, default 0  -- AP-1b never writes anything but 0; AP-1c's payment-allocation posting is the only future writer
  journal_entry_id      uuid, nullable, FK -> journal_entries.id     -- set exactly once, at posting
  period_id             uuid, nullable, FK -> accounting_periods.id  -- set exactly once, at posting
  memo                  text, nullable
  created_by            uuid, nullable
  posted_by             uuid, nullable
  posted_at             timestamptz, nullable
  created_at, updated_at  timestamptz
  UNIQUE (tenant_id, legal_entity_id, internal_reference)   -- NULL-distinct, unlimited DRAFT rows — identical shape to journal_entries_tenant_entity_number_unique
  INDEX (tenant_id, legal_entity_id)
  INDEX (supplier_id)
  CHECK (total_minor = subtotal_minor + tax_minor)
  CHECK (subtotal_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0)
  CHECK (paid_minor = 0)   -- tightened for AP-1b specifically: until AP-1c's payment-posting code exists, no code path may ever set this nonzero; the constraint is loosened (paid_minor >= 0 AND paid_minor <= total_minor, per the original AP-1a sketch) in the AP-1c migration that introduces the first writer. Keeping it pinned to exactly 0 until there is a real writer is a direct application of "no speculative abstraction ahead of need" to a constraint, not just to code.

supplier_bill_lines                                         -- new
  id                uuid PK, default random
  tenant_id         uuid, not null            -- denormalized from parent bill; required for this table's own RLS policy, identical reasoning to journal_lines.tenantId
  bill_id           uuid, not null, FK -> supplier_bills.id, ON DELETE CASCADE
  line_number       integer, not null
  account_id        uuid, not null, FK -> chart_of_accounts.id   -- the expense/asset account this line's cost distributes to; NO type restriction (any active in-scope account), same posture as journal_lines.accountId
  description       varchar(500), nullable
  amount_minor      bigint, not null           -- net line amount, must be > 0
  tax_amount_minor  bigint, not null, default 0
  created_at        timestamptz, not null, default now()
  UNIQUE (bill_id, line_number)
  INDEX (account_id)
  CHECK (amount_minor > 0)
  CHECK (tax_amount_minor >= 0)
```

Both tables get Drizzle `pgEnum`s: `supplierBillStatusEnum = pgEnum("supplier_bill_status", ["DRAFT", "POSTED"])` and `billPaymentStatusEnum = pgEnum("bill_payment_status", ["UNPAID", "PARTIALLY_PAID", "PAID"])`.

## 5. Relationships

```
suppliers (existing) ──< supplier_bills >── accounting_periods (existing, period_id, set at posting)
                              │
                              ├──< supplier_bill_lines >── chart_of_accounts (existing, account_id)
                              │
                              └──> journal_entries (existing, journal_entry_id, set at posting)

ap_settings (existing, 1:1 per legal_entity) ──> chart_of_accounts (ap_control_account_id, tax_input_account_id)
                                                   [read only, at bill-posting time]

ap_number_counters (new, 1 row per legal_entity) ──> supplier_bills.internal_reference [allocated at posting]
```

## 6. Lifecycle / state machine

```
DRAFT ──(POST /bills/:id/post)──> POSTED
  │
  └──(DELETE /bills/:id, DRAFT only)──> [deleted, lines cascade]

POSTED is terminal for `status` in AP-1b. No VOID, no edit-after-post, no reopening to DRAFT —
matches journal_entries' posted-immutability convention exactly. No VOID status value exists on
the enum in AP-1b (a deliberate narrowing from the AP-1a proposal's original 3-value sketch —
see §9) because nothing in this Work Item ever produces or consumes it; introducing an unused
enum value would itself be speculative. A future correction/void Work Item adds it then, together
with the logic that uses it.
```

`payment_status` is present on the row but inert in AP-1b — every bill is created and stays `UNPAID` through this Work Item's entire test suite; AP-1c is the sole future writer (§2).

## 7. Posting/accounting behavior

Bill posting produces exactly one balanced journal entry:

```
Dr  <line 1 account_id>                     line 1 amount_minor
Dr  <line 2 account_id>                     line 2 amount_minor
...
Dr  <ap_settings.tax_input_account_id>      SUM(line.tax_amount_minor)     -- only emitted if tax_minor > 0
Cr  <ap_settings.ap_control_account_id>     total_minor
```

Balanced by construction: `total_minor = subtotal_minor + tax_minor = SUM(line.amount_minor) + SUM(line.tax_amount_minor)`, exactly the debit side's sum. Two failure modes are explicit 422s, not 500s or silent skips:

- Any line has `tax_amount_minor > 0` and `ap_settings.tax_input_account_id` is not configured → `422` at posting time (`ap_settings` may exist with only `apControlAccountId` set — `taxInputAccountId` is optional in AP-1a's schema).
- `ap_settings` has no row at all for this legal entity → `422` at posting time ("AP settings have not been configured for this legal entity," reusing `ApSettingsService.findOne`'s existing message, called from within the same transaction — see §8).

Line ordering in the journal entry: expense/asset lines first in the bill's own `line_number` order, then the aggregate tax line (if any) as the final debit line before the single credit line — deterministic, not required for correctness (the balance trigger doesn't care about order) but kept deterministic for readable ledger output and stable e2e assertions.

## 8. Interaction with the existing Journal Engine

Restates and makes concrete the architectural decision the AP-1a proposal already made at the design level (its §9): **AP-1b's bill-posting code does not call `JournalEntriesService`.** It performs the equivalent work directly, inside its own single `withTenant` transaction that also updates the bill's own row — the only way "bill is POSTED" and "journal entry exists and is POSTED" can be guaranteed atomic, since `JournalEntriesService.create()`/`.post()` each own their own transaction boundary.

Concretely, `SupplierBillsService.post()` replicates `JournalEntriesService.post()`'s 10-step shape, step-for-step, against the bill instead of a journal entry:

1. `SELECT ... FOR UPDATE` the `supplier_bills` row first (mirrors `findByIdInTx(..., { forUpdate: true })`).
2. `status === 'DRAFT'` else `409`.
3. At least one bill line exists (a bill with zero lines cannot post — analogous to journal entries' "≥ 2 lines" rule, but bills have their own natural minimum of 1, since a single-line bill is a valid business document unlike a journal entry which needs both a debit and credit leg supplied by the caller).
4. Re-validate every line's `account_id` is still an active, in-scope account (same `findInvalidAccountIds`-shaped query, reimplemented locally against `supplier_bill_lines`/`chart_of_accounts` — not imported from `JournalEntriesService`, which is private to that class; a small amount of intentional, documented duplication rather than reaching into another service's internals or introducing a shared exported helper that only two call sites would ever use).
5. Load `ap_settings` for this legal entity; `404`-equivalent (`422`, since this is a posting-time business-rule failure, not a request-shape one — see §7) if absent; validate `taxInputAccountId` is configured if any line carries tax.
6. Resolve + lock the `OPEN` accounting period covering `bill_date` (identical query/lock shape to `resolveAndLockOpenPeriod`, reimplemented locally for the same reason as step 4).
7. Allocate the bill's own `internal_reference` from `ap_number_counters` via the identical atomic `INSERT ... ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET last_assigned_number = last_assigned_number + 1 RETURNING last_assigned_number` pattern `allocateJournalNumber` already uses — a structurally identical but separate counter table/row, not a shared row with `journal_number_counters` (bills and journal entries must never contend for the same sequence, and their number formats differ: `BILL-NNNNNN` vs `JE-NNNNNN`).
8. Allocate the journal entry's own number from the **existing** `journal_number_counters` row for this `(tenant_id, legal_entity_id)` — the ordinary `JE-NNNNNN` sequence, no AP-only journal-number series. This is the literal implementation of "posts through the existing Journal Engine, not a parallel mechanism": the journal entry this produces is indistinguishable in `journal_entries`/`journal_lines` from one a human posted by hand through `POST /journal-entries/:id/post`.
9. Insert the `journal_entries` header as `DRAFT`, insert its lines, then update the header to `POSTED` — all three in the same transaction. (Correction made during implementation: an earlier draft of this document proposed inserting the header already `POSTED` and its lines afterward; `journal_lines_immutable` — correctly — rejects any `INSERT` once its parent `journal_entries` row is already `POSTED`, so the lines must exist before the status transition, mirroring `JournalEntriesService`'s own create-builds-lines-while-DRAFT/post-only-flips-status shape exactly, just collapsed into one transaction instead of two HTTP calls. Caught by this Work Item's own e2e verification before commit — see the delivery report.)
10. Update the `supplier_bills` row: `status: 'POSTED'`, `internal_reference`, `journal_entry_id`, `period_id`, `posted_by`, `posted_at`.
11. Write two `audit_logs` rows in the same transaction: `action: "POST"` / `entityType: "supplier_bill"` against the bill, and `action: "CREATE"` / `entityType: "journal_entry"` against the new journal entry — mirroring the two-audit-row shape `JournalEntriesService.reverse()` already establishes for a single logical operation that touches two entities.

A failure at any step rolls the entire transaction back — no burned bill number, no burned journal number, no orphaned journal entry, from a failed post. This exactly matches `JournalEntriesService.post()`'s own "no burned numbers from a failed post" guarantee (that file's doc comment), replicated rather than inherited because it cannot be inherited across two independently-transacted services.

**No change to `JournalEntriesModule`, `JournalEntriesService`, `JournalEntriesController`, or their tests.** This is new AP code depending on existing shared tables (`journal_entries`, `journal_lines`, `journal_number_counters` — already importable from `../db/schema` since AP-1a and Journal Engine share one schema file), not a modification of working functionality.

## 9. Interaction with GL/account balances

No General Ledger code changes. `GET /accounts/:id/ledger`, `/accounts/:id/balance`, `/trial-balance` reflect every posted bill automatically, since AP-1b writes real `journal_entries`/`journal_lines` rows against real `chart_of_accounts` rows — zero AP-specific code in the GL read layer. This is directly testable and is one of the required e2e cases (§18).

## 10. AP control-account integration

Bill posting reads (never writes) `ap_settings.apControlAccountId`/`taxInputAccountId` for the bill's legal entity, inside the same transaction as everything else in §8 (so a concurrent `ApSettingsService.upsert()` cannot swap the control account mid-post — see §14 for the lock discussion). No new write path to `ap_settings` is introduced; `ApSettingsService.upsert()` remains the only writer, unchanged from AP-1a.

## 11. Legal entity / accounting period enforcement

Every referenced id — `supplier_id`, every line's `account_id` — must belong to the same `(tenant_id, legal_entity_id)` as the bill. Enforced twice, matching the Journal Engine's own two-time-validation discipline: a soft check at draft create/edit time, and an independent, authoritative re-validation at posting time (an account or supplier can be deactivated between draft creation and posting — AP-1a's `SuppliersService` already supports deactivation, so this is not a hypothetical). `legal_entity_id` isolation is an explicit predicate in every query; RLS covers `tenant_id` only, unchanged convention.

Accounting-period enforcement: bill posting resolves+locks the `OPEN` period covering `bill_date`, via the identical "no covering period → 422, covering period is CLOSED → 422, `SELECT ... FOR UPDATE` to block a concurrent period close" pattern as journal entry posting (§8 step 6). No new period concept, no AP-specific period logic. Closing a period never touches already-posted bills, exactly as it never touches already-posted journal entries.

## 12. Tax/VAT considerations

Unchanged from the AP-1a proposal's §13: `supplier_bill_lines.tax_amount_minor` is a flat, manually-entered value per line — no tax rate table, no jurisdiction logic, no automatic calculation. It exists only so a bill's total can include tax and post a single aggregate debit to `ap_settings.taxInputAccountId`. Full tax configuration is the separate, already-roadmapped Tax/VAT capability area.

## 13. Currency considerations

Every bill is created in the legal entity's single functional currency, resolved server-side exactly like `journal_entries.currencyCode` — never client-supplied. No FX, no foreign-currency bill concept, no functional-vs-transaction-currency distinction, unchanged from AP-1a proposal §14. The `currency_code` column exists on `supplier_bills` for the same forward-compatibility reason it exists on `journal_entries` (the documented additive-columns Multi-Currency extension point) — this is not new speculation, it is reusing an already-approved pattern verbatim.

## 14. RLS / RBAC / concurrency

**RLS**: new file `services/sphere-finance/drizzle/rls/004_ap_bills_rls.sql` (continuing the numeric sequence after `003_ap_rls.sql`/`003_null_tenant_bypass_fix.sql`), covering `ap_number_counters`, `supplier_bills`, `supplier_bill_lines` with the exact `tenant_isolation` policy text from `003_ap_rls.sql` (including the `= ''` bypass-fix branch — no new pattern, direct copy per table).

**RBAC**: reuses the three existing roles, no new role namespace.

```
POST   /v1/finance/bills                finance.poster
GET    /v1/finance/bills                any finance.* role
GET    /v1/finance/bills/:id            any finance.* role
PATCH  /v1/finance/bills/:id            finance.poster
DELETE /v1/finance/bills/:id            finance.poster
POST   /v1/finance/bills/:id/post       finance.poster
```

This matches `JournalEntriesController`'s split exactly (poster writes, any role reads) rather than AP-1a's supplier/ap-settings split (admin writes, broader read set) — bills are a transactional/posting concern like journal entries, not master-data/configuration like suppliers, so the role split follows the _nature of the object_, not the module it lives in. Flagged explicitly in case this reasoning should be revisited (§24).

**Concurrency**: two cases beyond what §8/§11 already cover under row locks:

- Concurrent `POST /bills/:id/post` calls on the same bill: the `SELECT ... FOR UPDATE` in step 1 of §8 serializes them exactly as `JournalEntriesService.post()` already does for journal entries — the loser re-reads `status = 'POSTED'` after the winner commits and gets a clean `409`, not a race.
- Concurrent bill-post vs. `ApSettingsService.upsert()` changing the control account mid-post: bill posting does not currently take a row lock on `ap_settings` (it has no natural per-request lock target the way a bill/period row does — it is read once, inside the same transaction, under the connection's default read-committed isolation). This is called out explicitly as a narrow, low-probability window (an admin changing AP settings at the exact moment a bill is posting) rather than silently accepted — see §24 for whether `SELECT ... FOR UPDATE` on the `ap_settings` row should be added now or is acceptable to defer.

## 15. Audit trail

Every mutation writes an `audit_logs` row in the same transaction as its data write, exactly matching `SuppliersService`/`ApSettingsService`/`JournalEntriesService`'s convention: `CREATE` (draft create), `UPDATE` (draft edit), `DELETE` (draft delete), `POST` (posting — plus the linked `journal_entry` `CREATE` row, §8 step 11). `entityType: "supplier_bill"`.

## 16. Required APIs

All under the existing `/v1/finance` prefix, no gateway/manifest change (AP-1a already established this — `noryx.module.json`'s `basePath` covers the whole service).

```
POST   /v1/finance/bills            create DRAFT                finance.poster    201
GET    /v1/finance/bills            list (filters: status,       any finance.*     200
                                     supplierId, dateFrom, dateTo)
GET    /v1/finance/bills/:id        detail incl. lines           any finance.*     200
PATCH  /v1/finance/bills/:id        edit — DRAFT only            finance.poster    200
DELETE /v1/finance/bills/:id        delete — DRAFT only          finance.poster    200
POST   /v1/finance/bills/:id/post   DRAFT → POSTED                finance.poster    200
```

`/post` returns `200`, not the `@Post()` default `201`, matching `JournalEntriesController.post()`'s exact reasoning (transitions an existing resource; expected shape for a future concurrent-posting test: winner `200` / loser `409`). Response envelope conventions unchanged: `ApiSuccess<T>` / list wrapper / `ApiError`, matching every existing Finance controller.

## 17. DTOs

`CreateSupplierBillDto`:

```
supplierId            @IsUUID()
supplierBillNumber    @IsString() @MinLength(1) @MaxLength(50)
billDate              @IsDateString()
dueDate               @IsOptional() @IsDateString()               -- server computes a default if omitted; explicit value always wins
memo                  @IsOptional() @IsString() @MaxLength(2000)
lines                 @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CreateSupplierBillLineDto)
```

`supplierBillNumber` deliberately has no `@Matches` charset restriction — unlike `chart_of_accounts.code`/`suppliers.code`, this is the _supplier's_ external reference text, not an internal identifier this system generates or joins on structurally.

`CreateSupplierBillLineDto` (mirrors `CreateJournalLineDto`'s shape, not its single-sided-debit/credit constraint — bill lines are single-sided by nature, not by a validated invariant):

```
accountId          @IsUUID()
description         @IsOptional() @IsString() @MaxLength(500)
amountMinor         @IsInt() @Min(1)              -- > 0, not >= 0: a zero-amount bill line is meaningless (matches journal_lines_nonzero's spirit, expressed as a DTO-level Min(1) since there's only one side here, not the two-sided single-sided/nonzero constraint journal lines need)
taxAmountMinor      @IsOptional() @IsInt() @Min(0)
```

`UpdateSupplierBillDto`: same shape as `CreateSupplierBillDto` but every field optional, `lines` full-array-replacement semantics identical to `UpdateJournalEntryDto.lines` (delete all existing lines, insert the replacement set with fresh 1..N numbering) — not incremental add/remove, same convention, same rationale (`journal-entries.service.ts` doc comment on `update()`).

`currencyCode`, `status`, `paymentStatus`, `internalReference`, `journalEntryId`, `periodId`, `subtotalMinor`, `taxMinor`, `totalMinor`, `paidMinor` are absent from every DTO — all server-resolved/server-computed, never client input, unchanged convention from every existing Finance DTO.

## 18. Required tests

New spec file(s) under `services/sphere-finance/test/`, real Postgres, following the established pattern exactly (signed JWTs via `tokenFor()`, full Nest app boot, `getDb()` for seeding):

- `supplier-bills.e2e-spec.ts` — the primary suite:
  - RBAC: 401/403/200 across `finance.viewer`/`finance.poster`/`finance.admin` for every route (viewer/admin cannot write, all three can read).
  - Draft CRUD: create with lines, computed `subtotalMinor`/`taxMinor`/`totalMinor`, default `dueDate` from `supplier.paymentTermsDays` (and no default when the supplier has none configured), list filters (`status`, `supplierId`, `dateFrom`/`dateTo`), get, 404-not-403 on cross-tenant/cross-legal-entity access (matching every existing convention), edit (full-line-replacement semantics, header-only edit, edit rejected once POSTED with `409`), delete (DRAFT only, `409` once POSTED, lines cascade).
  - Validation: bill with zero lines rejected at create (`400`, DTO-level `@ArrayMinSize(1)`); line referencing a nonexistent/inactive/cross-entity `accountId` rejected (`400` at create/edit, `422` at posting-time re-validation — a dedicated test that archives the account _between_ create and post to prove the re-validation path, mirroring the equivalent existing journal-entries test).
  - Posting — the core of this Work Item: balanced journal entry produced with the exact debit/credit shape from §7 (including the aggregate tax line only when `tax_minor > 0`, and its absence when it is 0); `internal_reference` allocated in `BILL-NNNNNN` form and only at posting; `journal_entry_id`/`period_id` set; `journal_entries.journalNumber` allocated from the _same_ `journal_number_counters` sequence real journal entries use (a dedicated assertion that posting a bill and then manually creating+posting a journal entry via the existing `JournalEntriesController` produces the next sequential `JE-NNNNNN`, proving no parallel sequence exists); posting fails `422` with no covering `OPEN` period, `422` with a `CLOSED` covering period, `422` when `ap_settings` is unconfigured, `422` when a line carries tax but `taxInputAccountId` is unconfigured; posting an already-`POSTED` bill returns `409`.
  - Immutability after posting: any attempted UPDATE to a `POSTED` `supplier_bills` row outside the narrow `paid_minor`/`payment_status` exception is rejected at the trigger level (a raw-SQL test, mirroring the existing journal-entries immutability trigger tests); any attempted INSERT/UPDATE/DELETE on `supplier_bill_lines` once the parent bill is `POSTED` is rejected outright (zero-exception, mirroring `journal_lines_immutable`).
  - Cross-tenant / cross-legal-entity isolation, both for the bill header and for line-level account references.
  - Audit trail: `CREATE`/`UPDATE`/`DELETE`/`POST` rows with correct before/after state; the linked `journal_entry` `CREATE` audit row from §8 step 11.
- `ap-bill-gl-integration.e2e-spec.ts` — a dedicated, narrow suite proving §9's claim directly: post a bill, then independently call `GET /accounts/:apControlAccountId/balance` and `GET /accounts/:apControlAccountId/ledger` through the existing, unmodified GL endpoints and assert the posted bill's amounts appear correctly with zero AP-specific GL code — the concrete verification of the roadmap's "no parallel posting mechanism" completion-gate language for this Work Item.
- `ap-bill-concurrency.e2e-spec.ts` — concurrent `POST /bills/:id/post` on the same bill (winner `200`, loser `409`, same shape as the existing journal-entries concurrent-posting test); concurrent bill-post vs. period-close (same shape as the existing general-ledger/journal-entries concurrency tests).
- DTO unit specs (`create-supplier-bill.dto.spec.ts`, `update-supplier-bill.dto.spec.ts`, `create-supplier-bill-line.dto.spec.ts`), mirroring the AP-1a DTO spec style.
- `route-role-matrix.spec.ts` extended with `SupplierBillsController`'s 6 routes (import + `EXPECTED` + `actual` array — the exact manual-addition step AP-1a already had to do; this test does not auto-discover new controllers).

## 19. Migration strategy

New tables added to `services/sphere-finance/src/db/schema.ts` (same file, no new schema file). `pnpm --filter @noryx/sphere-finance run generate` produces the drizzle-kit-numbered migration + snapshot automatically. New RLS file `drizzle/rls/004_ap_bills_rls.sql` (§14). New constraint file(s) under `drizzle/constraints/`, continuing past `004`:

- `005_supplier_bills_immutability_trigger.sql` — narrow-exception style mirroring `003_journal_entries_immutability_trigger.sql`: once `status = 'POSTED'`, only `paid_minor` and `payment_status` may change (both currently unused by any AP-1b code path, per §4/§6 — the exception exists because these columns' entire reason for existing on this table is future mutation by AP-1c, not because AP-1b itself exercises it).
- `006_supplier_bill_lines_immutability_trigger.sql` — zero-exception style, mirroring `004_journal_lines_immutability_trigger.sql` exactly (join to parent `supplier_bills.status`, block INSERT/UPDATE/DELETE once `POSTED`).

`pnpm --filter @noryx/sphere-finance run migrate` applies the Drizzle migration + RLS; `pnpm --filter @noryx/sphere-finance exec ts-node src/db/apply-db-constraints.ts` (this service's own script, per `ci.yml`) applies the new trigger files — identical two-command sequence to every prior increment. As with every prior Finance increment, this sandbox has no production database access (confirmed repeatedly across this engagement); rehearsal is against local `noryx_test`/`noryx` only, and applying to any real environment is a deployment action outside this session's reach.

## 20. Implementation sequence within AP-1b

1. Schema (`ap_number_counters`, `supplier_bills`, `supplier_bill_lines`) + migration generation, reviewed for pure-additive DDL before proceeding (same discipline as AP-1a).
2. RLS file + immutability trigger files + balance verification these don't conflict with the existing `002_balance_invariant_trigger.sql` (they don't — that trigger is scoped to `journal_lines`/`journal_entries` only; bills have no analogous cross-row balance invariant enforced at the DB level, since `total_minor = subtotal_minor + tax_minor` is already a per-row CHECK, not a cross-row SUM).
3. `SupplierBillsService`/`SupplierBillsController`/DTOs — draft CRUD first (lower risk, no Journal Engine interaction), matching AP-1a's own internal build order.
4. Posting logic (§8) — the highest-risk piece, built and tested last, with the GL-integration and concurrency suites (§18) written alongside it, not after.
5. `route-role-matrix.spec.ts` extension.
6. Full verification pass (§21) before commit.

## 21. Verification strategy / acceptance criteria

Real-Postgres e2e throughout, no unit-mocked business logic — same bar as AP-1a's 211-case suite and the Journal Engine's own discipline. Before AP-1b is considered closed:

- `pnpm typecheck` / `lint` / `test` / `build` clean at both service and monorepo level.
- Migration generated and reviewed as pure-additive DDL; applied cleanly against local `noryx_test`.
- RLS re-verified directly via `psql` against the actual app DB role (`relrowsecurity`/`relforcerowsecurity`/`pg_policies` on all three new tables, `noryx_app` grant confirmation) — not inferred from application-level test passes alone, same discipline as every prior increment.
- Full e2e suite green, including every case in §18 — in particular the GL-integration suite proving zero-parallel-posting-mechanism, and the concurrency suite proving no double-post/no burned-number-on-failure.
- `route-role-matrix.spec.ts` passing with `SupplierBillsController`'s 6 routes correctly discovered and classified `role-restricted`.
- A manual sanity check (documented in the closing report, not a new automated test): post one bill with tax and one without, and confirm both journal entries appear correctly in `GET /trial-balance` alongside a manually-posted journal entry, with a single shared `JE-NNNNNN` sequence across all three.

## 22. What is deliberately left for later AP work

- `supplier_payments`, `supplier_payment_allocations`, payment posting, `payment_status` transitions beyond `UNPAID` — AP-1c (depends on AP-1b's `journal_entry_id`/`paid_minor` columns existing, per §4).
- Supplier balance, statement, ageing — AP-1d (depends on AP-1b + AP-1c data existing to query).
- The `VOID` bill status and any correction/credit-note workflow — a future, separate Work Item (§6).
- Deciding `ap_number_counters`' final shape once payment numbering is needed — AP-1c's own proposal (§24).
- Any web UI (unchanged from AP-1a — `apps/web` has no Finance UI of any kind yet).

## 23. Non-goals for AP-1b (restated narrowly, unchanged from AP-1a proposal §19 where applicable)

- Approval workflow beyond `DRAFT → POSTED` (no multi-step chain, no delegation).
- Purchase Orders, goods receipts, 3-way matching (Procurement → AP integration remains "not yet designed").
- Real bank account entities / bank feeds / reconciliation (out of scope for bills entirely; relevant only to AP-1c payments).
- Automatic tax calculation or tax reporting (§12).
- Multi-currency/FX bills (§13).
- Bill correction after posting; unwinding/voiding a posted bill (§6, §22).
- Recurring bills, templates, attachments/supporting documents.
- Supplier Portal / any `TENANT_EXTERNAL`-facing surface (Phase 5 scope).
- Any web UI work.

## 24. Decisions requiring CTO/Product Owner approval

Four judgment calls this document makes that either refine or narrow the AP-1a proposal's original forward-sketch (§5 of that document), flagged explicitly rather than silently decided, per the standing instruction to report proposal/repo conflicts rather than resolve them quietly:

1. **`ap_number_counters` shape.** The AP-1a proposal originally sketched one table with a `counter_type` enum (`'BILL' | 'PAYMENT'`) to avoid two near-identical tables later. This document instead proposes a bill-only table with no discriminator column now (§4), deferring the shape decision to AP-1c when a second counter is actually needed — consistent with the same "no speculative abstraction ahead of a real second consumer" reasoning AP-1a itself used to defer creating this table at all. **Recommendation: proceed with the bill-only table** (this document's default); AP-1c's own proposal will explicitly decide whether to widen this table with an added column (a compatible, additive migration either way) or introduce a separate one. Reversing this later costs one small migration, not a redesign.
2. **`supplier_bills.status` enum values.** The AP-1a proposal originally sketched three values (`DRAFT`, `POSTED`, `VOID`). This document proposes only `DRAFT`/`POSTED` for AP-1b (§6), since nothing in this Work Item produces or consumes `VOID`. **Recommendation: proceed with two values**; adding `VOID` later is a single additive `ALTER TYPE ... ADD VALUE`, not a breaking change, whenever a correction/void Work Item is actually approved.
3. **`paid_minor` CHECK constraint pinned to exactly 0 in AP-1b** (§4), tightened from the AP-1a proposal's original `>= 0 AND <= total_minor` range, on the reasoning that no AP-1b code path can ever produce a nonzero value and the constraint should say so until AP-1c's migration loosens it. **Recommendation: proceed** — this is the same philosophy as the `paid_minor = 0` intent already implicit in "AP-1b never writes anything but 0," just made enforceable at the DB layer instead of only true by convention.
4. **RBAC role split for bills** (§14): poster-writes/any-role-reads, matching `JournalEntriesController` rather than AP-1a's supplier/ap-settings admin-writes split. This is a judgment call about which existing precedent bills are more analogous to (a transactional document vs. master data/configuration), not dictated by either existing pattern. **Recommendation: proceed with the journal-entries-style split** as this document proposes — bills are the transactional object here, suppliers/ap-settings are configuration — but this is the one item in this list that is a genuine either-way design choice rather than a scope-tightening, so it is surfaced for explicit confirmation rather than assumed.

No other decision in this document is presented as requiring approval; everything else either directly reuses an already-approved pattern (AP-1a's own code, the Journal Engine's posting discipline) or narrows scope in a way with no other reasonable reading (e.g. no payments in a Work Item titled "Supplier Bills").
