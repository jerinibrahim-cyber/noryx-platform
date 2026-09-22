# Finance Work Item AR-1a — Customer Master + AR Foundation

Status: **approved for direct implementation.** The kickoff instruction for
this Work Item said to inspect the roadmap and existing implementation,
determine exact scope, surface only a genuine design decision if one
exists, and otherwise proceed — this document records that inspection and
the (small, non-blocking) design points found, then the design as built.

## 0. What was read before writing any code

- `docs/roadmap.md` §"Accounts Receivable" — `[ ] Customer master, [ ]
Customer invoices, [ ] AR workflows, [ ] Receipts, [ ] Receipt
allocation, [ ] AR ageing, [ ] AR reporting` — nothing in AR started
  yet; this Work Item is the first increment.
- `docs/finance-work-item-1-ap-foundation-proposal.md` — the direct
  template. AP-1a's own scope was deliberately narrow: supplier master +
  one configuration row per legal entity holding the AP control account,
  with bill/payment tables and their number counter deferred to AP-1b/1c.
  AR-1a mirrors that exact split for the receivable side.
- `src/accounts-payable/suppliers/{suppliers.service,suppliers.controller,
suppliers.module}.ts` and its `dto/*.ts` (full) — the literal template
  this Work Item's Customers module copies: create/list/findOne/update/
  deactivate/reactivate shape, legal-entity-scoped uniqueness on `code`,
  `defaultExpenseAccountId`-style optional pre-fill account reference
  (existence+active+legal-entity checked, type deliberately unrestricted),
  audit-log-in-the-same-transaction discipline, `findByIdInTx`/
  `validateAccountRefOrThrow` private-helper shapes.
- `src/accounts-payable/ap-settings/{ap-settings.service,
ap-settings.controller}.ts` and its `dto/upsert-ap-settings.dto.ts`
  (full) — the literal template for this Work Item's AR Settings module:
  single upsert endpoint (`POST`, both create and update), one row per
  `(tenantId, legalEntityId)`, a required control-account reference
  type-restricted to a specific `chart_of_accounts.type`, an optional
  tax-account reference deliberately left type-unrestricted.
- `src/db/schema.ts` (full, already read in the prior AP-1d Work Item and
  re-confirmed unchanged at HEAD `4570f8a`) — confirms `chart_of_accounts`
  already supports every account type AR-1a needs (`ASSET` for the AR
  control account, `REVENUE` for a customer's default invoice-line
  account, mirroring `EXPENSE` for suppliers) with zero schema change
  required to `chart_of_accounts` itself.
- `src/app.module.ts` — confirms the top-level module-registration
  convention (`AccountsPayableModule` imported as its own top-level entry,
  a sibling of `AccountsModule`/`JournalEntriesModule`/etc., not nested
  inside another module) — `AccountsReceivableModule` is added the same
  way.
- `drizzle/rls/003_ap_rls.sql` — the literal RLS template: tenant-only
  policy (the `= ''`/`IS NULL` bypass-fix branch included from day one),
  `legal_entity_id` deliberately NOT part of RLS (enforced as an explicit
  service-layer predicate instead, same reasoning `chart_of_accounts`'s
  own schema.ts comment gives).
- `drizzle/constraints/` directory listing — confirms AP-1a added **zero**
  constraint files (no immutability trigger — master data/configuration
  rows are always editable, unlike a posted bill or payment). AR-1a's
  customers/ar_settings tables are the same kind of row and get the same
  treatment: no new constraints file.
- `src/route-role-matrix.spec.ts` — the repo-wide reflection test every
  new controller must be added to.

## 1. Scope

**In scope** — exactly AP-1a's own split, mirrored for the receivable
side: Customer master (create/edit/list/detail/deactivate/reactivate) and
AR setup (one configurable AR control GL account, and an optional
tax-output GL account, per legal entity). This is the customer foundation
the later invoice/receipt flow (AR-1b onward) will build on — no invoice,
invoice line, receipt, or allocation table; no numbering counter (no
consumer for one yet, identical reasoning to AP-1a deferring
`ap_number_counters` to AP-1b); no posting logic; no Journal Engine
interaction of any kind.

**Out of scope, explicitly** (restated from the kickoff instruction and
AP-1a's own precedent): customer invoices, invoice lines, tax/VAT
calculation logic, invoice approval/status lifecycle, accounting
distribution, Journal Engine posting, receivables ledger/balance,
customer receipts, receipt allocation, partial/full settlement, customer
statements, AR ageing, GL integration reporting, AR reconciliation,
credit notes/corrections, multi-currency, advanced Finance/AI
capabilities. All of these are later AR Work Items (AR-1b onward),
exactly as AP-1b/1c/1d followed AP-1a one increment at a time. No
hardening, security audit, Milestone 3.x, or unrelated-module work of any
kind.

## 2. Design points surfaced (neither blocks implementation)

1. **AR control account is type-restricted to `ASSET`, not `LIABILITY`.**
   Accounts Receivable is unambiguously an asset (money owed _to_ the
   business), the mirror image of AP's control account being
   unambiguously a `LIABILITY` (money owed _by_ the business) — same
   "the account's real-world meaning is unambiguous, so the type check is
   safety, not guesswork" reasoning `ApSettingsService.validateControlAccountOrThrow`
   already documents for AP. Applying it here is not a new judgment call.
2. **The optional tax account is named `taxOutputAccountId`, not
   `taxInputAccountId`, and (like AP's) is deliberately left
   type-unrestricted.** A customer invoice charges _output_ tax (VAT
   collected on behalf of the tax authority — typically a liability the
   business owes), the mirror image of a supplier bill's _input_ tax
   (VAT paid, typically a recoverable asset) that `ap_settings.
tax_input_account_id` already models. Same reasoning as AP-1a's own
   schema.ts comment on `taxInputAccountId`: real-world tax treatment is
   jurisdiction-dependent, out of scope for this increment to decide on
   the caller's behalf, so no type constraint is imposed — consistent
   with, not a departure from, the AP precedent.
3. **No `creditLimitMinor` (or similar credit-control field) on the
   customer master in this Work Item.** AP-1a's supplier master has no
   analogous field (nothing to mirror), and the kickoff instruction's own
   framing — "implement the customer foundation needed for the later
   invoice/receipt flow" — does not require one for AR-1a specifically:
   no invoice-posting or receipt logic exists yet to enforce a credit
   limit against. Deliberately left for a later AR Work Item (credit
   control is a receivables-workflow concern, not a master-data-shape
   concern) rather than added speculatively ahead of a real consumer —
   the same "no speculative abstraction ahead of need" principle AP-1a's
   own schema.ts comment states explicitly for why it didn't add
   `ap_number_counters` before AP-1b needed it.

None of these affect any other part of the architecture and none require
approval to proceed — noted here per the kickoff instruction's "if there
is a genuine design decision, surface it briefly," then implementation
proceeds directly.

## 3. Database schema — two new tables, additive only

No change to any AP-1a/1b/1c/1d table, to `chart_of_accounts`, to the
Journal Engine, or to any existing migration. New migration
`0008_*.sql` (drizzle-kit-generated from schema.ts, following the exact
same generate → review → apply flow every prior Work Item used), adding:

```
customers
  id                          uuid PK, default random
  tenant_id                   uuid NOT NULL            -- app-validated, no FK (cross-service boundary)
  legal_entity_id             uuid NOT NULL             -- app-validated, no FK (cross-service boundary)
  code                        varchar(32) NOT NULL
  name                        varchar(255) NOT NULL
  is_active                   boolean NOT NULL DEFAULT true
  payment_terms_days          integer, nullable          -- future consumer: AR-1b due-date default + AR ageing
  tax_registration_no         varchar(64), nullable      -- informational only
  default_revenue_account_id  uuid, nullable, FK -> chart_of_accounts(id)  -- pre-fills invoice lines in AR-1b; unenforced type
  created_by                  uuid, nullable
  created_at / updated_at     timestamptz NOT NULL

  UNIQUE (tenant_id, legal_entity_id, code)
  INDEX (tenant_id, legal_entity_id)

ar_settings
  tenant_id              uuid NOT NULL   -- app-validated, no FK
  legal_entity_id         uuid NOT NULL   -- app-validated, no FK
  ar_control_account_id   uuid NOT NULL, FK -> chart_of_accounts(id)   -- must be ASSET (§2.1)
  tax_output_account_id   uuid, nullable, FK -> chart_of_accounts(id)  -- unrestricted type (§2.2)
  created_at / updated_at timestamptz NOT NULL

  PRIMARY KEY (tenant_id, legal_entity_id)
```

Same FK policy distinction every prior schema section documents: no
Postgres FK to db-core's `tenants`/`legal_entities` (cross-service
boundary, app-validated from the verified JWT); real FKs to
`chart_of_accounts` (Finance's own table, same migration lifecycle).

## 4. RLS, RBAC, audit

**RLS**: new file `drizzle/rls/006_ar_rls.sql`, tenant-only policy on both
tables (with the `= ''`/`IS NULL` bypass-fix branch from day one, same as
`003_ap_rls.sql`) — `legal_entity_id` isolation is an explicit
service-layer predicate on every query, not RLS, identical reasoning to
every table before it.

**RBAC**: `finance.admin` writes (create/edit/deactivate/reactivate
customers; upsert AR settings), any `finance.*` role reads — exactly
`SuppliersController`/`ApSettingsController`'s split, because customers
and AR settings are the same _kind_ of object suppliers and AP settings
are (master data/configuration), not a transactional/posting document
like a bill or payment (that distinguishing "poster writes" split doesn't
apply here, same as it didn't for AP-1a).

**Audit**: every mutation writes an `audit_logs` row in the same
transaction as the customers/ar_settings write (`entityType: "customer"`
/ `"ar_settings"`), identical convention to every prior Finance write.

## 5. APIs

```
POST   /v1/finance/customers                  create                    finance.admin
GET    /v1/finance/customers                   list                     any finance.* role
GET    /v1/finance/customers/:id                detail                   any finance.* role
PATCH  /v1/finance/customers/:id                edit                     finance.admin
PATCH  /v1/finance/customers/:id/deactivate     soft-deactivate          finance.admin
PATCH  /v1/finance/customers/:id/reactivate     soft-reactivate          finance.admin

POST   /v1/finance/ar/settings                   create/update (upsert)  finance.admin
GET    /v1/finance/ar/settings                   detail                  any finance.* role
```

Verbatim mirror of `suppliers`/`ap/settings`'s own route shapes (§16 of
the AP Foundation proposal), including `reactivate` — AP-1a's suppliers
route table included both `deactivate` and `reactivate`; this Work Item
matches that exactly (the AP Foundation proposal's own §16 route listing
under-quotes `reactivate` in its prose but the shipped
`SuppliersController` has it, confirmed by reading the controller
directly — AR-1a follows the shipped behavior).

## 6. Module layout

```
src/accounts-receivable/
  accounts-receivable.module.ts        -- parent module, sibling of accounts-payable.module.ts
  customers/
    customers.service.ts
    customers.controller.ts
    customers.module.ts
    dto/create-customer.dto.ts (+ .spec.ts)
    dto/update-customer.dto.ts (+ .spec.ts)
  ar-settings/
    ar-settings.service.ts
    ar-settings.controller.ts
    ar-settings.module.ts
    dto/upsert-ar-settings.dto.ts (+ .spec.ts)
```

`AccountsReceivableModule` imported into `app.module.ts` as its own
top-level entry, the same way `AccountsPayableModule` is — not nested
inside `AccountsPayableModule`, since Accounts Receivable is a sibling
product capability to Accounts Payable, not a sub-feature of it.

## 7. Tests

New spec files under `services/sphere-finance/test/`, real Postgres,
following the established harness exactly:

- `customers.e2e-spec.ts` — CRUD, RBAC, validation, deactivate/reactivate,
  cross-tenant/cross-legal-entity isolation (404-not-403 convention) —
  mirrors `suppliers.e2e-spec.ts`.
- `ar-settings.e2e-spec.ts` — upsert (create then update), validation
  that the configured AR control account must be `ASSET`-typed and
  in-scope, tax-output account existence/scope check with no type
  restriction — mirrors `ap-settings.e2e-spec.ts`.
- DTO unit specs (`create-customer.dto.spec.ts`,
  `update-customer.dto.spec.ts`, `upsert-ar-settings.dto.spec.ts`)
  mirroring the AP-1a DTO specs' style.
- `route-role-matrix.spec.ts` extended: import `CustomersController` and
  `ArSettingsController`, add both to `discoverRoutes()`, add their 8
  combined `EXPECTED` entries (40 → 48 routes, 9 → 11 controllers).

## 8. What's deliberately left for later (AR-1b onward)

Everything named out-of-scope in §1, plus the two smaller deferrals noted
in §2 (customer credit limit / credit control). AR-1b (Customer Invoices)
is the next Work Item in this product line, mirroring AP-1b's own
increment shape (draft CRUD, posting into the Journal Engine, its own
number counter table) once approved.
