# Finance Work Item Proposal: Banking & Cash Management

**Status:** Discovery + proposal only. No code, schema, migration, or test has
been modified to produce this document. Per the CTO's explicit process rule
for this phase, this document ends with a STOP — implementation begins only
after CTO review and approval.

**Discovery basis:** repository at `HEAD f039e30` (independently confirmed —
see §2.0), immediately after the Credit Notes (AR) & Debit Notes (AP) work
item was committed, bundled, and (per the CTO's own confirmation, itself
independently re-verified against `origin/main` via `git fetch`) pushed.

**Author:** Principal Engineer (Claude), per the CTO's discovery instruction.

---

## 1. Executive Summary

NoryX Finance today has **no bank-account or cash-account master entity of
any kind**. Every place the system needs "the bank/cash account a payment or
receipt moved money through" — `supplier_payments.bankCashAccountId` and
`customer_receipts.bankCashAccountId` — is a bare foreign key into
`chart_of_accounts`, validated only as "an active account of type `ASSET`."
This is not a bug; it is a **documented, intentional seam**, named explicitly
in both AP-1c's and AR-1c's own proposals and repeated verbatim in
`schema.ts`'s comments on both columns: _"No real bank-account entity yet...
documented future seam."_ The prior Finance reassessment
(`docs/finance-core-reassessment-91b9d47.md`) independently identified the
same gap and explicitly deferred closing it — first behind Financial
Statements, then behind Credit/Debit Notes — specifically because closing it
properly needs new master data and new schema, not just a new read layer.

That deferral ends here. This proposal's central finding, grounded
exhaustively in the actual repository (not assumption): **the gap is exactly
as narrow, and exactly as real, as the reassessment predicted.** There is no
bank-account entity, no bank-transaction ledger, no bank-statement concept,
and — critically — **no existing "bank reconciliation" anywhere in this
codebase**. What AR/AP call "reconciliation" today (`GET /ar/reconciliation`,
`GET /ap/reconciliation`) is a completely different concept: a sub-ledger
(open invoices/bills) vs. GL-control-account balance check. It has nothing
to do with matching a bank statement.

Given the size and risk of "Banking & Cash Management" as a single unit —
the reassessment's own words, independently confirmed by this discovery,
called it _"closer in shape to a new AP-1a/AR-1a foundation item"_ than to a
read-layer item — this proposal recommends **splitting it into three
sequential work items**: **Bank/Cash Account Master → Bank Transactions →
Bank Reconciliation**, each independently proposable, implementable, and
verifiable, exactly the way AP and AR themselves were sequenced
(1a → 1b → 1c → 1d). The **immediate next implementation target recommended
by this proposal is Work Item Banking-1a: Bank/Cash Account Master** — a
small, purely additive master-data module with no changes whatsoever to any
existing AP, AR, Financial Statements, or Credit/Debit Notes code.

---

## 2. Current Repository Evidence

### 2.0 Starting-point verification (as instructed)

```
$ git rev-parse HEAD
f039e30eba3fe71c39b6799c58c83cc74f65e605
$ git fetch origin && git rev-parse origin/main
f039e30eba3fe71c39b6799c58c83cc74f65e605
$ git status --short
 M docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md
?? docs/hardening/
```

`HEAD` and `origin/main` are confirmed identical at `f039e30` (independently
re-verified via a live `git fetch`, not taken on faith from the CTO's
message). The two standing hardening exceptions
(`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md`,
`docs/hardening/`) are the only working-tree state present, exactly as left
after the previous work item, and remain untouched by this discovery.

### 2.1 Accounting Core (foundation everything below builds on)

- **Chart of Accounts** (`src/db/schema.ts:50-101`): `accountTypeEnum` is
  exactly `["ASSET","LIABILITY","EQUITY","REVENUE","EXPENSE"]` — five values,
  no sub-type. `chart_of_accounts` has `id`, `tenantId`, `legalEntityId`,
  `code`, `name`, `type`, `parentId` (self-referential hierarchy, app-layer
  validated, no Postgres FK), `isActive`, timestamps. Unique on
  `(tenantId, legalEntityId, code)`. **There is no cash/bank marker of any
  kind** — no `isCash`, `isBank`, `subType`, `category` column; grep across
  `src/` for all of these returns zero hits.
- **Journal Entries / Journal Lines** (`schema.ts:186-343`): two-state
  `journal_entry_status` (`DRAFT`/`POSTED`, no `VOID`); `journalNumber`
  format `JE-{n:06d}` from `journal_number_counters`, allocated atomically
  (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`); `currencyCode` fixed
  per legal entity's functional currency, never client-supplied; a
  `DEFERRABLE INITIALLY DEFERRED` DB trigger enforces debits = credits per
  entry (`drizzle/constraints/002_balance_invariant_trigger.sql`).
- **Accounting Periods** (`schema.ts:121-165`): `OPEN`/`CLOSED` only, no
  reopen. Overlap prevented by a Postgres `EXCLUDE USING gist` constraint
  (`drizzle/constraints/001_period_overlap_exclusion.sql`), not just an app
  check. Posting locks the covering period row `FOR UPDATE` inside the same
  transaction.
- **Journal Engine posting architecture — the single most important
  precedent for this proposal.** `JournalEntriesService.post()`
  (`journal-entries.service.ts:292-398`) is a self-contained 10-step
  transaction (lock → status check → line-count check → balance check →
  re-validate every account → lock period → allocate number → insert →
  flip status → audit). **No sub-ledger module calls it.** Every existing
  sub-ledger (`supplier-bills`, `supplier-payments`, `supplier-debit-notes`,
  `customer-invoices`, `customer-receipts`, `customer-credit-notes`)
  independently replicates that exact discipline directly against the same
  `journal_entries`/`journal_lines`/`journal_number_counters` tables, inside
  its _own_ `withTenant` transaction. The reason is stated explicitly and
  repeated verbatim across every later work item's `schema.ts` comments
  (`docs/finance-work-item-1-ap-foundation-proposal.md` §9): calling
  `JournalEntriesService` as two sequential calls would split "document
  POSTED" and "journal entry POSTED" into two transactions — unacceptable
  for Finance. **This proposal follows the identical pattern** for any new
  posting logic (Banking-1b), and explicitly does _not_ invent a second
  accounting engine.
- **General Ledger read layer** (`general-ledger.service.ts`): `getLedger`,
  `getBalance`, `getTrialBalance`, all read-only, `REPEATABLE READ`/read-only
  transactions. **No "reconciled" concept exists anywhere in this file.**
- **RLS**: `tenant_isolation` policy, identical SQL pattern repeated in every
  `drizzle/rls/*.sql` file (quoted in full in §12). `legal_entity_id` is
  deliberately _not_ part of RLS — enforced instead as an explicit
  `eq(table.legalEntityId, legalEntityId)` predicate in every service query.
- **Audit**: shared `audit_logs` table (owned by `@noryx/db-core`), written
  inside the same transaction as the business mutation, `entityType` a
  snake_case singular noun (`journal_entry`, `supplier_payment`,
  `customer_receipt`, …), `action` one of `CREATE`/`UPDATE`/`DELETE`/`POST`/
  `REVERSE`/`ARCHIVE`/`CLOSE`.
- **Immutability trigger convention**: every posted-document table gets a
  DB trigger rejecting UPDATE/DELETE once `status = 'POSTED'`. Two styles
  exist: a **zero-exception** style (the default starting point for a new
  table — e.g. `customer_receipts`, `customer_credit_notes`) and a
  **narrow-exception** style added only once a genuine future writer exists
  (e.g. `customer_invoices`/`supplier_bills`' `paidMinor`/`paymentStatus`
  exception, added ahead of AR-1c/AP-1c). **Master-data tables
  (`chart_of_accounts`, `customers`, `suppliers`, `ap_settings`,
  `ar_settings`) have no immutability trigger at all** — confirmed by a
  direct grep of every file in `drizzle/constraints/` (18 files, all named
  for a _document_ table, none for a master-data table).

### 2.2 AP (`accounts-payable/`)

- **Supplier Bills**: Dr expense/asset line accounts (+ Dr tax input) / Cr
  `apControlAccountId`. No cash leg.
- **Supplier Payments — the load-bearing precedent for `bankCashAccountId`.**
  `post()` (`supplier-payments.service.ts:342-633`) is a 13-15 step
  transaction; the journal it writes is exactly two lines:
  ```
  Line 1: DEBIT  apSettings.apControlAccountId   for paymentAmountMinor
  Line 2: CREDIT before.bankCashAccountId        for paymentAmountMinor
  ```
  `bankCashAccountId` validation (`validateBankCashAccountOrThrow`,
  `:661-691`, and an identical posting-time re-check) is **exactly**: exists,
  belongs to the caller's own `(tenantId, legalEntityId)`, `isActive = true`,
  `type = "ASSET"`. Nothing more. No dedicated bank-account entity, no
  "is this really a bank account" check beyond generic `ASSET` typing.
  Schema comment (`schema.ts:719-723`), verbatim: _"Manually-selected GL
  cash/bank account — validated ACTIVE + type ASSET at create/edit/post
  time. **No real bank-account entity yet** (proposal §1/§13's documented
  future seam)."_
- **Supplier Debit Notes — confirmed to never touch `bankCashAccountId`.**
  Grepped the full service file: zero occurrences. A debit note settles
  purely against `supplier_bills.paidMinor`/`paymentStatus`, no cash leg,
  journal is Dr AP control / Cr line accounts (+ Cr tax input) — the bill's
  own polarity reversed, confirmed in `supplier-debit-notes.service.ts:78-87,
535-577`.
- **AP Settings** (`schema.ts:414-448`): exactly `apControlAccountId`
  (required, must be `LIABILITY`) and `taxInputAccountId` (optional). **No
  default-bank-account field of any kind.** Every cash-touching document
  picks its own `bankCashAccountId` per-document; there is no
  legal-entity-wide default to inherit.
- **AP/GL Reconciliation** (`ap-reports.service.ts:581-626`) — precisely:
  `subLedgerTotalOutstandingMinor` (Σ `supplier_bills.totalMinor -
paidMinor`) vs. `glApControlAccountBalanceMinor` (`SUM(credit) -
SUM(debit)` over `journal_lines` for `apSettings.apControlAccountId`).
  **This is a sub-ledger-vs-GL-control-account check. It has nothing to do
  with a bank statement**, confirmed by the module's own doc comment:
  _"every number here is derived from supplier_bills/supplier_payments/
  supplier_payment_allocations/journal_lines"_ — no bank/cash table is an
  input.
- **Exhaustive grep** across all of `accounts-payable/` for `bank statement`,
  `reconcil`, `settlement`, `deposit`, `withdrawal`, `transfer`, `UPI`,
  `card`, `POS`, `payment provider`, `gateway`: the only hits are (a) the
  AP-sub-ledger-vs-GL reconciliation endpoint described above, and (b) the
  string literals `"BANK_TRANSFER"`/`"CARD"` inside `paymentMethodEnum` — a
  free-text classification label on the payment header with no behavior
  attached to it whatsoever. **No bank-transaction ledger, bank-statement
  concept, or bank-reconciliation concept exists anywhere in AP.**

### 2.3 AR (`accounts-receivable/`)

Structurally the exact mirror of AP, confirmed independently:

- **Customer Receipts** — journal is Dr `bankCashAccountId` / Cr
  `arControlAccountId` (mirror-image polarity of the payment entry, per the
  service's own doc comment). `bankCashAccountId` validation is the
  byte-identical WHERE clause used by supplier-payments (exists + own
  tenant/entity + `isActive` + `type = ASSET`). Schema comment
  (`schema.ts:1197-1202`), verbatim: _"No real bank-account entity yet
  (proposal §4's documented future seam)."_
- **Customer Credit Notes — confirmed to never touch `bankCashAccountId`.**
  Zero occurrences in the service file. Settlement is purely
  `customer_invoices.paidMinor`/`paymentStatus`, journal is Dr line
  accounts (+ Dr tax output) / Cr AR control — the invoice's polarity
  reversed.
- **AR Settings** (`schema.ts:882-917`): `arControlAccountId` (required,
  must be `ASSET`) + `taxOutputAccountId` (optional). **No default-bank
  field.**
- **AR/GL Reconciliation** (`ar-reports.service.ts:624-669`) — the exact
  mirror of AP's: sub-ledger outstanding (invoices − receipts − credit
  notes) vs. `journal_lines` for `arSettings.arControlAccountId`. Same
  conclusion: **not a bank reconciliation.**
- **Exhaustive grep** across `accounts-receivable/` for the same term list:
  identical result to AP — no bank-transaction, bank-statement, or
  bank-reconciliation concept anywhere.
- **Route-role-matrix convention for a document-lifecycle module**
  (`route-role-matrix.spec.ts:439-458` for receipts, `:490-511` for credit
  notes): every write verb (`POST` create, `PATCH`, `DELETE`, `POST .../post`)
  requires `finance.poster` only; every read verb (`GET` list, `GET` by id)
  is open to all three roles. Stated convention: _"Same
  finance.poster-writes/any-role-reads split as SupplierPaymentsController —
  [these] are a transactional/posting document, not master data."_

### 2.4 Financial Statements

- **Balance Sheet / P&L** (`financial-statements.service.ts`) group strictly
  by `chart_of_accounts.type` (`ASSET`/`LIABILITY`/`EQUITY` for the Balance
  Sheet, `REVENUE`/`EXPENSE` for P&L), then roll up by the `parentId`
  hierarchy **within** that type. **There is no "Cash and Cash Equivalents"
  sub-category, and no special-casing for bank-charge/interest accounts** —
  every `ASSET` (or `EXPENSE`) row is queried and treated identically
  regardless of what it conceptually represents. Confirmed by the query
  itself (`fetchTypeBalancesAsOf`/`fetchTypeBalancesWithinRange`, filtered
  only on `coa.type = ${type}`) and by the Financial Statements proposal's
  own §2.1/§8.1/§6.1, which describe scope purely in terms of the five
  `accountType` values.
- **Cash Flow Statement is explicitly deferred**, per that same proposal's
  §3: _"Cash Flow Statement (direct or indirect method) — explicitly
  deferred per CTO decision 4. No cash-flow tables, classification models,
  or APIs."_ No extensibility hook (reserved sub-type, tagging mechanism)
  for a future Cash Flow statement exists anywhere in the current schema.
- **Repo-wide grep** for `CashFlow`, `cash flow`, `cash_flow`,
  `cashPosition`, `BankReconciliation`, `bank_reconciliation`,
  `bankStatement`, `importedStatement`: **zero hits, every term.**

### 2.5 Prior architectural commentary (`docs/finance-core-reassessment-91b9d47.md`)

This document — the same reassessment that led to Financial Statements, then
Credit/Debit Notes, being chosen ahead of Banking — already contains the
clearest statement of this gap in the repository, quoted here in full because
it is directly load-bearing for this proposal's recommendations:

> "Banking / Reconciliation | **Not started** | No bank-account entity, no
> bank-statement import, no bank-to-GL reconciliation. `bankCashAccountId`
> on payments/receipts is an unconstrained reference into `chartOfAccounts`
> — nothing enforces it actually points at a bank/cash-type account"
> (capability map).
>
> "AP-1c and AR-1c introduced `bankCashAccountId` on
> `supplierPayments`/`customerReceipts` as a plain reference into
> `chartOfAccounts`, with no dedicated bank-account entity and no constraint
> that the referenced account is actually bank/cash-typed. AP/AR's existence
> is what exposes this — it wasn't visible as a gap before payments/receipts
> existed to reference 'a bank account' in the first place." (§C.4)
>
> "...closing that gap properly needs new master data (a Bank Account
> entity, at minimum) and very likely new schema (bank transactions, a
> bank-statement-import shape) before any reconciliation logic can be
> written — this is a materially larger, higher-risk scope than a read
> layer, closer in shape to a new AP-1a/AR-1a foundation item than to
> AP-1d/AR-1d." (§E.2)
>
> "Any future capability that needs to reconcile a subledger to a GL
> control account (e.g. a future Bank/Cash subledger reconciling to a
> bank-control GL account) now has two working, tested reference
> implementations to mirror rather than a novel design problem." (§C.2)

This discovery independently confirms every factual claim in that
assessment against the actual `f039e30` repository state (not merely citing
the prior document as authoritative) — see §2.1-2.4 above.

### 2.6 Roadmap alignment

`docs/roadmap.md:167` already itemizes the target checklist for this
capability area (all unchecked, none implemented by any prior work item):
_"Bank accounts, Bank transactions, Bank reconciliation, UPI/card/bank
payment reconciliation where applicable, Cash management, Cash receipts,
Cash payments, Bank transfers, Cash position."_ This proposal's three-item
split (§5, §21) is structured to retire this checklist in the same
deliberate, incremental order the roadmap's own phrasing suggests (master
data first, then transactions, then reconciliation/UPI-card boundary last).

---

## 3. Existing Banking/Cash Capability

**None.** To state this as plainly as the evidence supports: there is no
bank-account or cash-account table, no bank-transaction table, no
bank-statement table, no reconciliation-matching table, and no reconciliation
service or endpoint that touches anything resembling a bank statement,
anywhere in `services/sphere-finance`. The only artifacts that gesture at
banking at all are:

1. `bankCashAccountId` on `supplier_payments` and `customer_receipts` — a
   bare `chart_of_accounts` FK, validated only as active + `ASSET`-typed.
2. `paymentMethodEnum` values `"BANK_TRANSFER"` and `"CARD"` — free-text
   classification labels on a payment/receipt header, with zero downstream
   behavior.
3. Two explicit "documented future seam" comments in `schema.ts`, both
   pointing at exactly the gap this proposal now closes.

---

## 4. Problem / Gap Definition

Three concrete problems follow directly from §2-3, not from speculation:

1. **No entity to hang bank/cash-specific data or behavior off.** A payment
   or receipt today references _some_ ASSET account — there is no way to
   know, list, or manage "the set of bank/cash accounts this legal entity
   actually has," what currency each is in, what institution it's at, or
   whether it's a real bank account vs. a petty-cash till. `AccountsService`
   has no concept of this at all.
2. **No mechanism to compare book balances against external bank-statement
   truth.** AR/AP's existing "reconciliation" reports are a different concept
   entirely (§2.2-2.3) and cannot be extended to mean bank reconciliation
   without conflating two unrelated invariants.
3. **No seam for the stated future requirement** — UPI/card/bank settlement
   reconciliation for India/GCC POS — to attach to, without a rewrite,
   because there is currently nothing to attach it to.

None of these are AP/AR/Financial-Statements/Credit-Debit-Notes defects —
those modules did exactly what their own explicitly-approved proposals said
they would do, and named this gap honestly at the time (§2.2, §2.3, §2.5).

---

## 5. Proposed Scope

**Recommendation: split "Banking & Cash Management" into three sequential
work items**, not one, matching the reassessment's own sizing judgment
(§2.5) and this codebase's established sequencing discipline (AP/AR were
never built as one work item either):

| Work item                                                                               | Scope                                                                                                                                                                                                                | Depends on                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Banking-1a — Bank/Cash Account Master** (_recommended immediate next implementation_) | New `bank_cash_accounts` master-data table + CRUD module. No transactions, no reconciliation, no reports beyond list/get.                                                                                            | Accounting Core only (existing) |
| **Banking-1b — Bank Transactions**                                                      | Bank transfers, cash deposits/withdrawals not tied to an AP/AR document, bank fees, interest — a new lightweight posted-document type.                                                                               | Banking-1a                      |
| **Banking-1c — Bank Reconciliation**                                                    | `bank_statement_lines` (manual entry first), matching engine, reconciliation session, and the reporting this unlocks (Bank/Cash Account Statement, Cash Position, Unreconciled Transactions, Reconciliation Report). | Banking-1a, Banking-1b          |

This document proposes the **full architecture for all three** (per the
CTO's explicit ask, §11 in particular covers Banking-1c's design in detail)
but recommends implementing **only Banking-1a next**, as its own
independently-approved, independently-verified work item — exactly the
granularity every prior Finance work item in this repository has used.

### 5.1 Banking-1a scope, precisely

- One new table: `bank_cash_accounts` (+ one new enum,
  `bank_cash_account_kind`).
- One new NestJS module (`bank-cash-accounts/`), mirroring
  `SuppliersModule`'s file/route shape exactly (§13).
- Full CRUD lifecycle: create, list, get, edit, deactivate, reactivate —
  **no draft/post lifecycle** (this is master data, not a transactional
  document — see §10).
- RLS, RBAC, audit logging, route-role-matrix update — all mirroring
  established conventions with no deviation except where explicitly
  justified (§12, §19).
- Unit (DTO) + e2e test coverage matching `SuppliersModule`'s/
  `CustomersModule`'s own existing rigor.
- **Zero changes to any existing file outside this new module, its
  migration, its RLS file, and the route-role-matrix.**

---

## 6. Explicit Exclusions (this proposal, all three sub-items)

Not in Banking-1a:

- Any new transaction/document type (deferred to Banking-1b).
- Any reconciliation, matching, or bank-statement concept (deferred to
  Banking-1c).
- Any report beyond the master entity's own list/get (deferred; a
  meaningful Bank/Cash Account Statement needs Banking-1b's transactions to
  exist first — see §14).
- Any change to `supplier_payments.bankCashAccountId` or
  `customer_receipts.bankCashAccountId`'s schema or validation (§9).
- Any change to AR/AP reconciliation reports, Financial Statements, or
  Credit/Debit Notes logic.

Not in Banking-1a, 1b, or 1c (all deferred beyond this proposal's scope
entirely):

- Bank-statement **file import** (CSV/Excel/OFX/API) — §11.3 explains why,
  and what is reserved instead.
- Any UPI/card/POS/payment-gateway integration — §15 defines the boundary
  precisely.
- Multi-currency bank accounts / FX — §11 (currency) explains why.
- Any change to the Balance Sheet's account grouping (e.g. a "Cash and Cash
  Equivalents" presentational sub-total) or the Cash Flow Statement — both
  remain exactly as scoped (or deferred) by the Financial Statements work
  item; nothing here reopens that decision.

---

## 7. Domain Model

```
Legal Entity
   │
   ├── Chart of Accounts (existing)
   │      └── one ASSET-type row  ←──────┐
   │                                       │ exactly one (new UNIQUE constraint)
   ├── Bank/Cash Account (NEW, Banking-1a)─┘
   │      kind: BANK | CASH
   │      currency: inherited from legal entity (no FX)
   │      │
   │      ├── (existing) Supplier Payments / Customer Receipts
   │      │      that happen to reference this account's GL account
   │      │      — visible via a JOIN, no schema change (§9)
   │      │
   │      ├── Bank Transaction (NEW, Banking-1b)
   │      │      transfer | deposit | withdrawal | fee | interest
   │      │      → posts a journal entry, same discipline as every
   │      │        other sub-ledger (§10)
   │      │
   │      └── Bank Statement Line (NEW, Banking-1c)
   │             source: MANUAL | (reserved: IMPORTED, POS_SETTLEMENT)
   │             → matched against book transactions (Bank Transactions,
   │               and existing Payment/Receipt journal lines) to produce
   │               a Reconciliation Session (§11)
```

A Bank/Cash Account is master data (like Customer/Supplier/Chart of
Accounts), not a document. A Bank Transaction is a document (like
Payment/Receipt/Credit-Debit Note), with the same DRAFT→POSTED lifecycle and
immutability convention. A Bank Statement Line and Reconciliation Session are
new concepts with no precedent elsewhere in this codebase, designed in §11
to reuse as much of the existing convention set as legitimately applies.

---

## 8. Database / Schema Proposal

**This section is a design proposal only — no migration has been created,
no `schema.ts` edit has been made.** SQL/Drizzle shown here is illustrative
of the intended shape, following the exact column/constraint conventions
found throughout `schema.ts` (§2.1, §12).

### 8.1 Banking-1a (proposed for immediate implementation)

```ts
export const bankCashAccountKindEnum = pgEnum("bank_cash_account_kind", [
  "BANK",
  "CASH",
]);

export const bankCashAccounts = pgTable(
  "bank_cash_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /// Short internal code, mirroring chart_of_accounts.code /
    /// customers.code / suppliers.code exactly — same master-data
    /// convention, not a new one.
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    kind: bankCashAccountKindEnum("kind").notNull(),
    /// Exactly one GL account per bank/cash account (§9's answer to
    /// Q2/Q3) — validated ACTIVE + type ASSET at write time, identical
    /// predicate to supplierPayments/customerReceipts.bankCashAccountId's
    /// own existing validation. Real FK: chart_of_accounts is Finance's
    /// own table, same migration lifecycle.
    glAccountId: uuid("gl_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    /// Resolved from the legal entity's functional currency at creation
    /// — never client-supplied, identical posture to every other
    /// currencyCode column in this schema (journal_entries,
    /// customer_invoices, supplier_bills, ...). No FX (§11).
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    /// Free text, no format validation — same posture as
    /// supplierBills.supplierBillNumber / customerReceipts.reference.
    /// Only meaningful when kind = BANK; not DB-enforced.
    bankName: varchar("bank_name", { length: 255 }),
    maskedAccountNumber: varchar("masked_account_number", { length: 50 }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bank_cash_accounts_tenant_entity_code_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.code,
    ),
    /// The one genuinely new invariant this proposal introduces
    /// (§9, Q2): a GL account may back at most one bank/cash account,
    /// enforced as a real DB constraint (not just a service-layer
    /// check), following the exact same "friendly pre-check + DB
    /// constraint as the real race-closer" pattern already established
    /// by accounting_periods' overlap-exclusion constraint.
    unique("bank_cash_accounts_gl_account_unique").on(t.glAccountId),
  ],
);
```

No `bank_cash_account_number_counters` table — this is master data, not a
sequentially-numbered document (no `internalReference`-style field is
needed, matching `customers`/`suppliers`, which also have none).

**No `bank_cash_settings` singleton table.** Unlike AP/AR (which need
exactly one legal-entity-wide default control account because bills/
invoices don't choose their control account per-document), every
cash-touching document **already** selects a specific `bankCashAccountId`
per-document, and will continue to for Bank Transactions in Banking-1b. The
`bank_cash_accounts` list itself _is_ the configuration; there is no
additional legal-entity-wide default to store. (This is a deliberate,
evidence-grounded departure from mechanically mirroring
`ap_settings`/`ar_settings` — see §9.)

### 8.2 Banking-1b (design only, not proposed for immediate implementation)

Illustrative shape only, to show the invariant carries forward cleanly:

```ts
export const bankTransactionTypeEnum = pgEnum("bank_transaction_type", [
  "TRANSFER",
  "DEPOSIT",
  "WITHDRAWAL",
  "FEE",
  "INTEREST",
]);
export const bankTransactionStatusEnum = pgEnum("bank_transaction_status", [
  "DRAFT",
  "POSTED",
]);

// bank_transactions: id, tenantId, legalEntityId, internalReference
//   (null-while-DRAFT, "BTX-NNNNNN"), status, type, transactionDate,
//   bankCashAccountId (FK -> bank_cash_accounts.id, the primary leg),
//   counterpartyBankCashAccountId (FK -> bank_cash_accounts.id, nullable,
//   required only for TRANSFER), amountMinor, glAccountId (for FEE/
//   INTEREST, the offsetting P&L account), memo, journalEntryId, periodId,
//   createdBy/postedBy/postedAt, timestamps.
```

### 8.3 Banking-1c (design only, not proposed for immediate implementation)

```ts
export const bankStatementLineSourceEnum = pgEnum(
  "bank_statement_line_source",
  ["MANUAL", "IMPORTED", "POS_SETTLEMENT"], // latter two reserved, unused
);

// bank_statement_lines: id, tenantId, legalEntityId, bankCashAccountId,
//   lineDate, amountMinor (signed: +credit/-debit on the statement),
//   description, source (default MANUAL), externalReference (nullable,
//   reserved for a future import/POS-settlement batch id — §15),
//   matchedBankTransactionId / matchedJournalLineId (nullable, set once
//   matched), reconciledAt, reconciledBy, createdAt.

// A "reconciliation session" per bank_cash_account + as-of date: book
// balance, statement balance, list of unreconciled book transactions
// (outstanding deposits/withdrawals), list of unmatched statement lines,
// differenceMinor, reconciled: boolean — computed, not a stored table,
// mirroring how AR/AP's own reconciliation endpoints are pure read-layer
// computations over existing rows (ar-reports.service.ts:624-669), not a
// new "reconciliation record" table.
```

---

## 9. GL Integration — and the `bankCashAccountId` Question (§Q3, the

critical one)

**No second accounting engine.** Banking-1b's Bank Transactions will post
through the exact same replicated-discipline pattern every other sub-ledger
uses (§2.1) — lock, validate, re-validate accounts, lock period, allocate a
journal number from the _same_ `journal_number_counters` sequence, insert
directly into `journal_entries`/`journal_lines`, audit — inside Banking's own
transaction. `JournalEntriesService` is not called, for the identical
transaction-atomicity reason already established and repeated by every prior
work item.

**The `bankCashAccountId` relationship — evidence-grounded answer.**
`supplier_payments.bankCashAccountId` and `customer_receipts.bankCashAccountId`
are, today, plain `chart_of_accounts` FKs (§2.2-2.3). Banking-1a's
`bank_cash_accounts.glAccountId` establishes a **1:1 invariant between a
bank/cash account and a GL account** (§8.1's new unique constraint). Because
that invariant holds, **no schema change to `supplier_payments` or
`customer_receipts` is required at all** — a Bank/Cash Account is
determined by a plain join:

```sql
SELECT bca.*
FROM bank_cash_accounts bca
WHERE bca.gl_account_id = supplier_payments.bank_cash_account_id
```

This is **purely additive**: existing payments/receipts continue to
reference a `chart_of_accounts` row exactly as before; a Bank/Cash Account
"adopts" any historical (or future) payment/receipt whose `bankCashAccountId`
happens to match its `glAccountId`, with no backfill, no data migration, and
no risk of breaking a single existing row. If no `bank_cash_accounts` row
yet exists for a given GL account, payments/receipts referencing it simply
don't participate in any Banking report until an admin creates one (a
transparent, non-destructive limitation — §18).

**What this proposal deliberately does _not_ do**, because the CTO's
process rule requires flagging rather than silently deciding any integration
change to completed AP/AR logic: it does **not** tighten
`validateBankCashAccountOrThrow`/`revalidateBankCashAccountForPostingOrThrow`
in `supplier-payments.service.ts`/`customer-receipts.service.ts` to require
the referenced account to belong to an _active_ `bank_cash_accounts` row (as
opposed to merely being any active `ASSET` account, as today). That would be
a real, if small, integration change to two already-completed, already-shipped
services. **This is flagged as an explicit open CTO decision (§19, item 5)**,
recommended to be considered only after Banking-1a and Banking-1b exist and
real usage data exists to justify it — not decided unilaterally here, and
not part of Banking-1a's scope regardless of how that future decision goes.

**Answering the flow diagrams in the CTO's prompt directly, with the actual
correct model** (not the AP/AR-mirroring assumption the prompt itself
flagged as needing verification):

```
Supplier Payment.post()
    → writes a journal_lines row: CREDIT bankCashAccountId (a chart_of_accounts row)
    → (Banking-1a, read-only join) that GL account may resolve to a Bank/Cash Account
    → (Banking-1c) that journal line becomes an unreconciled "book transaction"
      for that Bank/Cash Account, until matched to a Bank Statement Line

Customer Receipt.post()
    → writes a journal_lines row: DEBIT bankCashAccountId
    → (same join, same downstream reconciliation path)
```

No change to Supplier Payment's or Customer Receipt's own posting logic is
needed for this to work correctly — it is a pure read-side consequence of
the 1:1 invariant established in Banking-1a.

---

## 10. Bank/Cash Transaction Lifecycle

**Bank/Cash Account (Banking-1a) has no lifecycle beyond active/inactive.**
It is master data, exactly like `chart_of_accounts`/`customers`/`suppliers`
— no `DRAFT`/`POSTED` status, no immutability trigger (none of those three
precedent tables has one either — confirmed by grep, §2.1). Its only state
transitions are create → edit → deactivate ⇄ reactivate.

**Bank Transaction (Banking-1b, design only)** follows the exact
`DRAFT → POSTED` lifecycle and zero-exception immutability convention every
other posted document uses (§2.1): create (DRAFT) → edit (DRAFT-only) →
delete (DRAFT-only) → post (DRAFT→POSTED, atomic with its journal entry,
immutable thereafter). No new lifecycle shape is invented.

---

## 11. Reconciliation Architecture (design for Banking-1c; not built now)

### 11.1 What "bank reconciliation" means here — the boundary the CTO asked

for, defined precisely and only from evidence/business necessity, not
invention:

- **Book balance** — the Bank/Cash Account's GL account's own posted balance
  as of a date, computed identically to how `ar-reports.service.ts`'s
  `glAssetBalance` already computes the AR control account's balance
  (`SUM(debit) - SUM(credit)` over POSTED `journal_lines`, `ASSET`-normal
  sign) — same query shape, zero new computation logic invented.
- **Bank statement balance** — the ending balance stated on an actual bank
  statement; external truth, entered via a `bank_statement_lines` row (or a
  header-level "statement ending balance" figure) — always sourced from
  outside the system, never derived.
- **Unreconciled transactions** — book-side journal lines (from Payments,
  Receipts, and Banking-1b's Bank Transactions) touching this account's GL
  account that have no matched `bank_statement_lines` row yet.
- **Reconciled transactions** — a book transaction matched 1:1 (or, for
  batched bank fees, potentially many:1) to a statement line.
- **Outstanding deposits** — book-side receipts/deposits posted but not yet
  appearing on the statement (timing lag).
- **Outstanding withdrawals** — book-side payments/withdrawals posted but
  not yet cleared on the statement (e.g. an issued cheque not yet cashed).
- **Bank fees / interest** — appear on the statement before they exist in
  the books; require a new Banking-1b Bank Transaction (`FEE`/`INTEREST`
  type) to be entered so the book side can catch up and match.
- **Transfers** — a two-sided movement between two Bank/Cash Accounts, both
  legs needing their own book transaction (Banking-1b's `TRANSFER` type,
  `bankCashAccountId` + `counterpartyBankCashAccountId`).
- **Adjustments** — a manual correcting entry for a genuine discrepancy (not
  a timing difference); always audited, never a silent balance override.

This list is exactly the set of terms the CTO's own prompt named, no more —
nothing here is invented beyond what standard bank-reconciliation practice
and the prompt's explicit vocabulary already require.

### 11.2 Matching granularity — a combination, evidence-justified

**Transaction-level matching against statement lines is the real mechanism;
balance-level figures are a derived summary, not a separate mechanism.**
This directly mirrors the precedent AR/AP reconciliation already
established: the _real_ invariant AR/AP reconciliation checks is
per-account-total, but it is itself built from per-invoice/per-bill
`paidMinor` figures underneath. Banking-1c should mirror that shape: the
underlying mechanism is matching individual book transactions to individual
statement lines (transaction-level, 1:1 or small many:1 for batched fees);
the "book balance / statement balance / difference / reconciled" figure
shown in a report is a derived roll-up over that matching state, exactly the
same "matched detail rows → summary invariant" shape
`ArReconciliationResult`/`ApReconciliationResult` already use.

### 11.3 Should imported bank statements belong in this work item? — No,

deferred, with a defined minimal abstraction that avoids blocking on it

**Deferred**, for a concrete reason grounded in this repository, not
caution for its own sake: **there is no file-upload/ingestion capability
anywhere in `sphere-finance` today** — confirmed by `docs/security.md`
having zero coverage of import/upload/ingestion security, and zero existing
precedent anywhere in the codebase for parsing an external file format.
Building CSV/OFX/API import now, before any real India/GCC bank statement
format has been examined, risks building the wrong abstraction — exactly the
kind of premature, unevidenced design this discovery process exists to
prevent.

**What is _not_ deferred**: the `bank_statement_lines` schema (§8.3) is
designed to be **import-source-agnostic from day one** — a `source` enum
(`MANUAL` today; `IMPORTED`/`POS_SETTLEMENT` reserved, unused columns) and a
nullable `externalReference` field mean a future import/POS-settlement
adapter can insert rows into the _same_ table, matched by the _same_ engine,
with **no schema migration required** when that day comes. Banking-1c itself
only builds the `MANUAL` path (a poster keys in statement lines from a
paper/PDF/portal statement) — this unblocks real reconciliation immediately
without gambling on an unverified import format.

### 11.4 How bank transactions enter the GL — answered in §9. No second

accounting engine; Bank Transactions post through the same replicated
Journal Engine discipline every other sub-ledger uses.

### 11.5 Treatment of transfers/deposits/withdrawals/fees/interest/

unidentified

**In scope for Banking-1b** (needed for reconciliation to ever actually
close — without a way to book fees/interest/transfers, "outstanding items"
could never resolve): transfers, cash deposits/withdrawals, bank fees,
interest.

**Explicitly deferred, and explained why**: an "unidentified transaction"
workflow (a statement line with no plausible book-side match — e.g. an
unattributed incoming wire) is, on the evidence of the CTO's own stated
future requirement, much closer to the **POS/payment-provider settlement
problem** (§15) than to core double-entry bank reconciliation — a suspense-
account/exception-queue workflow makes far more sense once real
UPI/card-settlement data exists to shape it, rather than being guessed at
now.

---

## 12. Security / RBAC / RLS

**RLS**: `bank_cash_accounts` gets the identical `tenant_isolation` policy
every other Finance table uses, verbatim (quoted from
`drizzle/rls/009_ar_credit_notes_rls.sql`, the most recent precedent):

```sql
ALTER TABLE bank_cash_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_cash_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_cash_accounts;
CREATE POLICY tenant_isolation ON bank_cash_accounts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
```

`legal_entity_id` isolation is, as everywhere else, an explicit service-layer
predicate, not RLS (§2.1) — bank accounts must never cross legal-entity
boundaries, enforced the identical way `suppliers`/`customers` already are,
proven by the identical style of cross-legal-entity e2e test every other
master-data module already has.

**RBAC** — this required checking two _different_ existing conventions,
since master data in this codebase is not RBAC-uniform:

| Resource                                                             | Writes                | Reads                                                        |
| -------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `accounts` (Chart of Accounts)                                       | `finance.admin` only  | `finance.viewer`, `finance.admin` (**not** `finance.poster`) |
| `customers` / `suppliers` / `ap/settings` / `ar/settings`            | `finance.admin` only  | all three roles                                              |
| `payments` / `receipts` / `credit-notes` / `debit-notes` (documents) | `finance.poster` only | all three roles                                              |

(Confirmed directly from `route-role-matrix.spec.ts` lines 202-211, 285-314,
384-411, 439-511 — Chart of Accounts is the one master-data resource that
excludes `finance.poster` from reads; every other master-data resource
includes it.)

**Recommendation for `bank_cash_accounts`: mirror the
customers/suppliers/settings pattern, not the Chart-of-Accounts pattern.**
Reasoning: a `finance.poster` will need to _select_ a bank/cash account when
creating a Banking-1b Bank Transaction, exactly the same operational need
that already justifies letting posters read `suppliers`/`customers` (to
select a counterparty when creating a bill/invoice). Chart of Accounts'
narrower read set looks like it reflects CoA's role as raw accounting
structure rather than an operational selection list — a Bank/Cash Account is
operationally selected, like a supplier or customer, not raw GL structure.

Proposed route-role table for Banking-1a:

```
POST   /bank-cash-accounts                    finance.admin
GET    /bank-cash-accounts                    finance.viewer, finance.poster, finance.admin
GET    /bank-cash-accounts/:id                finance.viewer, finance.poster, finance.admin
PATCH  /bank-cash-accounts/:id                finance.admin
PATCH  /bank-cash-accounts/:id/deactivate     finance.admin
PATCH  /bank-cash-accounts/:id/reactivate     finance.admin
```

(Mirrors `suppliers`'/`customers`' exact verb set — `PATCH .../deactivate`
and `PATCH .../reactivate` as two distinct endpoints, not a single toggle —
same convention, no new shape invented.)

**No new role.** The three-role catalog (`finance.viewer`/`finance.poster`/
`finance.admin`) is enforced by a DB-level `CHECK` constraint in
`packages/db-core` (`001_role_catalog_check.sql:39-40`) — a cross-service
schema change with real blast radius. Nothing discovered in this proposal's
scope (Bank/Cash master, or even the reconciliation design in §11) requires
a capability the existing three roles can't already express: creating/
editing bank accounts is an admin action (mirrors settings), posting a bank
transaction or performing a match/reconciliation action is a poster action
(mirrors posting any other document), reading is open to all three. **A
future import/POS-settlement adapter (§15) might eventually need a distinct
service-identity concept** (not a human role) — flagged as out of scope
entirely, not decided here.

**Audit**: every mutation on `bank_cash_accounts` writes an `audit_logs` row
in the same transaction, `entityType: "bank_cash_account"`, `action` one of
`CREATE`/`UPDATE`/`DEACTIVATE`/`REACTIVATE` — same convention, no deviation.

---

## 13. API / Module Structure

Mirrors `SuppliersModule` exactly (§2's confirmed convention):

```
bank-cash-accounts/
├── bank-cash-accounts.controller.ts
├── bank-cash-accounts.module.ts
├── bank-cash-accounts.service.ts
└── dto/
    ├── create-bank-cash-account.dto.ts (+ .spec.ts)
    └── update-bank-cash-account.dto.ts (+ .spec.ts)
```

**Module wiring**: registered as a **new top-level sibling** of
`AccountsPayableModule`/`AccountsReceivableModule`/`GeneralLedgerModule` in
`AppModule` — not nested under either AP or AR, since Banking is its own
domain that both will eventually read from (via the join in §9), not a
child of one side. This matches the precedent the Financial Statements
proposal itself already established for `GeneralLedgerModule`'s own
placement (§2 discovery, item 7): _"imported directly into AppModule as a
top-level sibling... not nested under either."_

All routes under the existing `/v1/finance` prefix (no new API Gateway
manifest needed — `sphere-finance` is registered as one module, per
`docs/plug-and-play-modules.md`'s confirmed single-manifest-per-service
convention).

---

## 14. Reporting Implications

**Banking-1a**: list/get only (already covered by the CRUD endpoints in
§13) — no dedicated "report" endpoint. A Bank/Cash Account Statement report
would be thin and largely redundant with existing GL Ledger/AR-AP statement
reports until Banking-1b's own transactions exist to populate it
meaningfully — deferring it is a scope decision, not an oversight.

**Banking-1b** (design only): once Bank Transactions exist, a genuine
**Bank/Cash Account Statement** (running balance of all book transactions —
Payments, Receipts, and Bank Transactions — touching one account, mirroring
`ar-reports.service.ts`'s `getCustomerStatement` shape exactly) becomes
meaningful and should likely land alongside or shortly after Banking-1b.

**Banking-1c** (design only): unlocks **Bank Reconciliation Report** (book
balance, statement balance, outstanding items, `reconciled: boolean` —
mirroring `ArReconciliationResult`'s shape), **Cash Position** (Σ closing
balance across every active Bank/Cash Account's GL account for a legal
entity — a lightweight aggregate reusing the same `glAssetBalance`-style
query per account, no new computation), and **Unreconciled Transaction
Report** (book transactions with no statement-line match as of a date).

None of these are proposed for implementation now — this section answers the
CTO's question of _where they eventually land_, not a commitment to build
them in Banking-1a.

---

## 15. POS / UPI / Card Future Integration Boundary

**A. Core Finance banking/cash capability (this proposal, all three
sub-items):** Bank/Cash Account master, Bank Transactions (manual, posted
by a human), Bank Reconciliation (statement lines entered manually, matched
by a human or a matching algorithm operating on already-present rows).

**B. Future payment-provider/POS settlement integration (explicitly out of
scope of this proposal and everything it recommends implementing):** an
adapter that ingests a UPI/card/POS-provider settlement batch (e.g. a daily
Razorpay/Stripe/local-acquirer settlement file or webhook) and
**programmatically inserts rows into the same `bank_statement_lines` table**
Banking-1c already defines, tagged `source = 'POS_SETTLEMENT'` with a
`providerBatchId`/`externalReference` populated. **No new table, no new
matching engine, and no rewrite of Banking-1c's design would be required**
when that day comes — this is the concrete answer to "design so future POS
settlement/reconciliation can integrate cleanly": the seam is a `source`
enum value and a nullable reference column reserved in §8.3's schema today,
not a promise to revisit the architecture later.

Two further design choices in this proposal exist specifically to keep that
boundary clean, both already justified elsewhere in this document: (1)
`bank_cash_accounts.kind` (`BANK`/`CASH`, §8.1) already anticipates that a
payment-provider settlement account (e.g. "Razorpay Settlement") is itself
just another `BANK`-kind Bank/Cash Account, no special-casing needed; (2)
reconciliation matching (§11.2) is designed against the generic
"book-transaction ↔ statement-line" abstraction, not bank-specific fields,
so a POS-settlement-sourced statement line matches through the identical
engine a manually-entered one does.

---

## 16. Testing Strategy

Matches the rigor established by every prior Finance work item in this
repository (most recently, Credit/Debit Notes' 33-test e2e suites per new
document type):

**Banking-1a**: DTO unit specs for create/update (mirroring
`create-supplier.dto.spec.ts`/`update-supplier.dto.spec.ts` exactly — valid
payload, every optional field, non-UUID rejections, missing/invalid `kind`,
maxlength rejections). E2e suite (`bank-cash-accounts.e2e-spec.ts`)
covering: RBAC (all three roles × all six routes), create/list/get/edit/
deactivate/reactivate happy paths, `glAccountId` validation (nonexistent,
inactive, wrong-type, cross-tenant, cross-entity), the new
`glAccountId`-uniqueness invariant (second bank/cash account attempting to
claim an already-claimed GL account → 409, mirroring
`accounting-periods.e2e-spec.ts`'s overlap-conflict test shape), duplicate-
code-within-entity rejection, cross-tenant/cross-legal-entity isolation,
audit-row verification. Independent PostgreSQL verification (RLS/policy
presence, unique-constraint presence, raw-SQL cross-tenant read attempt)
matching the rigor demonstrated in the Credit/Debit Notes delivery's 19-check
independent verification pass.

**Banking-1b/1c** (design only): to be scoped in their own proposals,
following the identical pattern (DTO specs, a dedicated e2e suite per new
document/concept, immutability-trigger e2e coverage once Banking-1b's
posted-document table exists, and — mirroring how Credit/Debit Notes
extended the _existing_ AR/AP report e2e suites rather than only adding new
ones — likely extensions to AR/AP report suites are **not** expected here,
since Banking does not touch AR/AP sub-ledger totals at all).

---

## 17. Migration / Backward Compatibility

**Fully additive, at every step of this proposal's recommended sequence.**
Banking-1a: one new migration (next available: `0012`), one new RLS file
(next available: `011_bank_cash_accounts_rls.sql`), zero `ALTER` statements
against any existing table, zero changes to any existing service, DTO,
controller, or test file. No backfill is required or proposed — historical
`bankCashAccountId` values on existing payments/receipts require no
migration to keep working exactly as they do today, and will retroactively
"adopt" a Bank/Cash Account the moment one is created for the matching GL
account (§9). No existing API contract changes. No existing e2e test in the
repository should require modification — confirmed by this proposal
touching zero files outside its own new module.

Banking-1b/1c (design only) are each independently additive in the same way
— new tables, no `ALTER` of anything from Banking-1a, AP, AR, Financial
Statements, or Credit/Debit Notes.

---

## 18. Risks and Limitations

- **GL-account-sharing onboarding friction.** If an organization has
  historically used one shared `ASSET` GL account across what are, in
  reality, multiple physical bank accounts (via ad hoc `bankCashAccountId`
  selection before Banking existed), the new `glAccountId` uniqueness
  constraint (§8.1) means only one Bank/Cash Account can claim that GL
  account. Onboarding those organizations onto distinct Bank/Cash Accounts
  requires creating new, distinct GL accounts going forward for the
  previously-conflated ones — a real but one-time, transparent, admin-level
  onboarding step, not a data-integrity risk.
- **Retroactive-adoption UX.** A Bank/Cash Account created after historical
  payments/receipts already exist will "adopt" them silently via the join
  (§9) — functionally correct, but an admin might expect an explicit
  "link existing transactions" action. Worth a one-line UI note when
  Banking-1a ships; not a data risk.
- **Two RBAC precedents existed for master data (§12) and this proposal
  picked one (customers/suppliers/settings) over the other (Chart of
  Accounts).** This is a judgment call, not directly evidenced either way —
  flagged explicitly as an open decision (§19).
- **Deactivate/reactivate vs. one-way archive** (§19) is similarly a
  judgment call between two existing precedents.
- **No FX/multi-currency bank accounts.** A foreign-currency bank account
  literally cannot be modeled correctly until real multi-currency lands
  system-wide (§2.1 — `currencyCode` is fixed per legal entity everywhere
  today) — an intentional, system-wide limitation this proposal inherits
  rather than works around, consistent with "respect the single-currency
  constraint without prematurely introducing full multi-currency."

---

## 19. Open CTO Decisions

1. **Naming**: `bank_cash_accounts`/`bankCashAccountId`-family terminology
   (recommended, for continuity with the existing column name) vs. a
   shorter `bank_accounts` name that would then need `kind` to also cover
   cash tills. _Recommendation: `bank_cash_accounts`._
2. **Lifecycle verbs**: `deactivate`/`reactivate` (suppliers/customers
   precedent, two-way) vs. one-way `archive` (Chart of Accounts precedent).
   _Recommendation: `deactivate`/`reactivate` — a bank account can
   plausibly be closed and later reopened, unlike a GL account._
3. **RBAC reads**: include `finance.poster` (suppliers/customers/settings
   precedent) vs. exclude it (Chart of Accounts precedent). _Recommendation:
   include — posters will need to select a bank/cash account operationally,
   same as they already select a supplier/customer._
4. **`glAccountId` uniqueness**: a hard DB `UNIQUE` constraint now
   (recommended, matching this codebase's consistent "friendly check + DB
   constraint as the real race-closer" pattern) vs. a service-layer-only
   check deferred to a later hardening pass.
5. **Whether/when to tighten `supplier_payments`/`customer_receipts`'
   `bankCashAccountId` validation** to require an active `bank_cash_accounts`
   row (rather than any active `ASSET` account, as today). _Recommendation:
   defer entirely; do not decide now; revisit only after Banking-1a and
   Banking-1b exist and real usage data exists._ This is the one place a
   future integration change to already-completed AP/AR code is plausible,
   and it is being surfaced rather than silently assumed, per the CTO's
   explicit instruction.
6. **Reporting sequencing**: fold Bank/Cash Account Statement into
   Banking-1b, or hold all Banking reports until Banking-1c (recommended
   above, §14) — open to CTO preference either way; low-stakes either
   direction.
7. **Confirm the three-item split and Banking-1a as the immediate next
   implementation target** — the core sequencing recommendation this entire
   proposal rests on.

---

## 20. Acceptance Criteria (Banking-1a, the recommended immediate

implementation target)

- New migration (additive only) creates `bank_cash_account_kind` enum and
  `bank_cash_accounts` table exactly as designed in §8.1, or as amended by
  CTO decisions in §19.
- Full CRUD (create/list/get/edit/deactivate/reactivate) via a new
  `BankCashAccountsController`/`Service`/`Module`, file-structured
  identically to `SuppliersModule` (§13).
- `glAccountId` validated at create/edit time and re-validated at every
  subsequent read that matters: exists, `isActive = true`, `type = "ASSET"`,
  in the caller's own `(tenantId, legalEntityId)`, and not already claimed
  by another active `bank_cash_accounts` row (friendly pre-check + DB
  unique-constraint race-closer, 409 on conflict).
- `currencyCode` resolved from the legal entity's functional currency,
  never client-supplied.
- RLS `tenant_isolation` policy applied
  (`011_bank_cash_accounts_rls.sql`), `legal_entity_id` isolation enforced
  as an explicit service-layer predicate on every query.
- RBAC per §12's table; `route-role-matrix.spec.ts` updated and green.
- Audit rows (`CREATE`/`UPDATE`/`DEACTIVATE`/`REACTIVATE`,
  `entityType: "bank_cash_account"`) written inside the same transaction as
  every mutation.
- **No immutability trigger** — deliberate, matching the master-data
  precedent (§2.1, §10), not an oversight.
- **Zero changes to any file outside**: the new module, its migration, its
  RLS file, and the route-role-matrix — confirmed via an exact `git diff`
  scope review at delivery time, exactly as done for the Credit/Debit Notes
  work item.
- Full unit (DTO) + e2e test coverage (§16); typecheck/lint/build clean;
  the complete pre-existing unit + e2e suites re-run with **zero
  regressions**, proving true additivity; e2e suite run twice for
  stability, matching the standing verification bar.
- Independent PostgreSQL verification (schema/enum/RLS/constraint
  presence, raw-SQL cross-tenant/cross-entity isolation checks,
  uniqueness-constraint enforcement) bypassing the application layer,
  matching the rigor of the Credit/Debit Notes delivery's 19-check pass.

---

## 21. Implementation Sequence (procedural, once approved — not started)

1. Migration `0012`: `bank_cash_account_kind` enum + `bank_cash_accounts`
   table (§8.1, as amended by §19 decisions).
2. RLS file `011_bank_cash_accounts_rls.sql`.
3. `BankCashAccountsModule` (controller/service/module/DTOs), registered as
   a new top-level sibling module in `AppModule` (§13).
4. `route-role-matrix.spec.ts` update (§12).
5. Unit (DTO) tests + new `bank-cash-accounts.e2e-spec.ts` (§16).
6. Full verification suite: typecheck, lint, build, complete unit suite,
   complete e2e suite run twice, independent PostgreSQL verification —
   identical rigor and sequence to the Credit/Debit Notes work item's own
   Tasks #122-123.
7. Exact `git diff` scope review confirming zero out-of-scope files touched
   (including the two standing hardening exceptions, left untouched),
   commit, create and verify a delivery bundle. **Do not push without
   explicit instruction**, per standing process.

---

## STOP

Discovery and proposal complete. No source code, schema, migration, or test
has been modified. No commit has been made. Awaiting CTO review, correction,
and explicit approval before any implementation begins.
