# Finance Work Item — Banking-1b: Bank Transactions

**Status: DISCOVERY + PROPOSAL ONLY. No source code, schema, migration, RLS
file, constraint file, or test has been created or modified. No commit. No
push.**

Baseline verified independently at the start of this discovery (not taken on
the CTO prompt's word):

```
$ git rev-parse HEAD
f750406c447f15e56e096e3ea288e4c4c2295874
$ git rev-parse origin/main
f750406c447f15e56e096e3ea288e4c4c2295874
$ git status --short
 M docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md
?? docs/hardening/
```

`HEAD == origin/main == f750406` — Banking-1a is confirmed merged and
pushed. The two standing hardening exceptions remain exactly as they were;
this discovery pass did not touch them.

---

## 1. Executive Scope

Banking-1b implements **Bank Transactions**: a new, additive Finance
document type representing bank/cash movements that are **not** already
captured by an existing AP/AR document — transfers between two Bank/Cash
Accounts, cash deposits, cash withdrawals, bank fees, and bank interest.
Each Bank Transaction follows the identical `DRAFT → POSTED` lifecycle and
replicated-journal-engine posting discipline every other Finance document in
this repository already uses, and becomes the **first real consumer** of
Banking-1a's `bank_cash_accounts` master entity as a genuine foreign-key
target (not merely a read-side join, as Banking-1a's own relationship to
`supplier_payments`/`customer_receipts` remains).

Banking-1b explicitly does **not** include bank statement import, bank
reconciliation, a matching engine, cash position reporting, or any
POS/UPI/card/payment-provider integration. It also does **not** modify
`supplier_payments`, `customer_receipts`, or any other completed AP/AR/GL
behavior — those keep referencing `chart_of_accounts` directly, exactly as
Banking-1a left them, per the already-approved proposal's §9 and the open
decision at §19 item 5, which this document does not re-decide.

Banking-1b is the second of three sequential Banking work items
(`docs/finance-work-item-banking-cash-management-proposal.md` §8):
Banking-1a (Bank/Cash Account Master, shipped `f750406`) → **Banking-1b
(this document)** → Banking-1c (Bank Reconciliation, not started, not
designed further than the already-approved §8.3/§11 sketch).

---

## 2. Current Repository Evidence

All of the following was re-verified directly against the repository at
`f750406` during this discovery pass — nothing here is carried forward from
an earlier summary without a fresh check.

### 2.1 Banking-1a, as actually shipped

- `src/db/schema.ts:1719-1827` — `bankCashAccountKindEnum`
  (`BANK`/`CASH`) and `bankCashAccounts`: `id`, `tenantId`, `legalEntityId`,
  `code`, `name`, `kind`, `glAccountId` (FK → `chart_of_accounts.id`, `UNIQUE`),
  `currencyCode`, `bankName`, `maskedAccountNumber`, `isActive`, `createdBy`,
  `createdAt`, `updatedAt`. Unique on `(tenantId, legalEntityId, code)` and,
  separately, on `glAccountId` alone — a GL account backs at most one
  Bank/Cash Account.
- `src/bank-cash-accounts/bank-cash-accounts.service.ts` — master-data
  CRUD (`create`/`list`/`findOne`/`update`/`deactivate`/`reactivate`, no
  `DELETE`). `validateGlAccountOrThrow` (create/edit only: exists, own legal
  entity, `isActive`, `type = ASSET`, not already claimed) is **never**
  called from `list()`/`findOne()` — reads never re-check the linked GL
  account's state (the locked "historical-read" correction).
  `resolveCurrency` reads `legalEntities.currencyCode`; never client-supplied.
- `src/bank-cash-accounts/bank-cash-accounts.controller.ts` — six routes,
  `POST/PATCH/deactivate/reactivate` = `finance.admin`, `GET`
  (list/by-id) = `finance.viewer`+`finance.poster`+`finance.admin`. No
  `DELETE` route.
- `drizzle/migrations/0012_sweet_maddog.sql` — purely additive: one
  `CREATE TYPE`, one `CREATE TABLE`, one deferred FK add. Zero `ALTER` of
  any pre-existing table.
- `drizzle/rls/011_bank_cash_accounts_rls.sql` — the standard
  `tenant_isolation` `USING` policy, `ENABLE`+`FORCE ROW LEVEL SECURITY`.
  `legal_entity_id` is not RLS-covered (confirmed: no `legal_entity_id`
  predicate anywhere in the policy text).
- `src/route-role-matrix.spec.ts` — currently **84 routes across 18
  controllers** (re-counted directly from the file, not assumed), 89/89
  tests, `BankCashAccountsController`'s 6 routes present exactly as above.
- `test/bank-cash-accounts.e2e-spec.ts` — 46 tests; no test exercises
  anything beyond master-data CRUD (no journal-posting test exists here,
  confirming Banking-1a genuinely posts nothing).
- **No immutability trigger exists for `bank_cash_accounts`**
  (`drizzle/constraints/` currently ends at `018_supplier_debit_note_
allocations_immutability_trigger.sql` — 18 files, all named for a
  _document_ table; `bank_cash_accounts` is not among them, confirming it
  remains master data with no trigger, as designed).

### 2.2 Journal Engine posting architecture (re-read directly, not assumed)

`JournalEntriesService.post()` (`journal-entries/journal-entries.service.ts:292-398`)
is a self-contained transaction: lock+load the journal entry
(`forUpdate: true`) → status must be `DRAFT` → ≥2 lines → debits=credits
(app-level check; a `DEFERRABLE INITIALLY DEFERRED` DB trigger,
`drizzle/constraints/002_balance_invariant_trigger.sql`, is the real
backstop) → re-validate every line's account → resolve+lock the covering
`OPEN` accounting period (`FOR UPDATE`) → allocate a journal number from
`journal_number_counters` (atomic `INSERT ... ON CONFLICT DO UPDATE ...
RETURNING`) → flip `DRAFT → POSTED` → audit.

**No sub-ledger module calls this service.** Re-read directly:
`SupplierPaymentsService.post()` (`accounts-payable/supplier-payments/
supplier-payments.service.ts:342-633`) independently inserts a `DRAFT`
`journal_entries` row, its two `journal_lines`, then flips it to `POSTED`
itself, inside its own `withTenant` transaction, drawing the journal number
from the _same_ `journal_number_counters` sequence. Its own inline comment
states the reason verbatim: calling `JournalEntriesService` as a second,
sequential call would split "document POSTED" and "journal entry POSTED"
into two transactions — unacceptable for Finance. Every other posting
sub-ledger (`supplier-bills`, `supplier-debit-notes`, `customer-invoices`,
`customer-receipts`, `customer-credit-notes`) replicates the identical
discipline. **Banking-1b must follow the same pattern** — no second
accounting engine, no call into `JournalEntriesService`.

### 2.3 AP/AR `bankCashAccountId` — confirmed untouched by Banking-1a

Direct grep of `supplier-payments.service.ts` and `customer-receipts.service.ts`
for `bank_cash_accounts`/`BankCashAccount`: **zero hits in either file.**
Both still validate `bankCashAccountId` against `chart_of_accounts` only
(`exists, own tenant/legal entity, isActive, type=ASSET` —
`supplier-payments.service.ts:661-691,697-726`; the byte-identical
predicate in `customer-receipts.service.ts`). The schema comments on both
columns (`schema.ts:719-723` and the AR equivalent) still literally read
_"No real bank-account entity yet"_ — stale now that Banking-1a exists, but
functionally accurate: neither table has a `bank_cash_accounts` FK, and
Banking-1a's proposal (§9, §19 item 5) explicitly deferred deciding whether
to ever add one. **This proposal carries that deferral forward unchanged —
Banking-1b does not touch `supplier_payments` or `customer_receipts`.**

`SupplierPaymentsService.post()`'s two-line journal
(`supplier-payments.service.ts:494-513`):

```
Line 1: DEBIT  apSettings.apControlAccountId    for paymentAmountMinor
Line 2: CREDIT before.bankCashAccountId         for paymentAmountMinor
```

`CustomerReceiptsService.post()` is the mirror-image (`DEBIT
bankCashAccountId` / `CREDIT arControlAccountId`). Both remain entirely as
shipped.

### 2.4 Accounting Periods (`accounting-periods/`)

`OPEN`/`CLOSED` only, no reopen. A Postgres `EXCLUDE USING gist` constraint
(`drizzle/constraints/001_period_overlap_exclusion.sql`) prevents overlap,
not just an app check. Every poster (`resolveAndLockOpenPeriod`, duplicated
per-service — e.g. `supplier-payments.service.ts:819-850`) runs the
byte-identical query: find the period row covering the transaction's date
`FOR UPDATE`, `throw` if none exists, `throw` if the found period is not
`OPEN`. **No separate "future-dated transaction" restriction exists
anywhere** — if an `OPEN` period happens to cover a future date, posting
against it already succeeds today for every existing document type. Banking-1b
introduces no new restriction here; it reuses the identical predicate.

### 2.5 Document-numbering convention (re-confirmed by direct grep)

Every posted-document table has its **own**, separate
`{prefix}_number_counters` table, distinct from `journal_number_counters`
and from every other document type's counter — `ap_number_counters`
(`BILL-NNNNNN`), `ap_payment_number_counters` (`PAY-NNNNNN`),
`ar_number_counters` (`INV-NNNNNN`), `ar_receipt_number_counters`
(`RCT-NNNNNN`), `customer_credit_note_number_counters` (`CRN-NNNNNN`),
`supplier_debit_note_number_counters` (`DBN-NNNNNN`). All are structurally
identical: `(tenantId, legalEntityId)` primary key, `lastAssignedNumber`
integer, allocated via the atomic `INSERT ... ON CONFLICT DO UPDATE ...
RETURNING` pattern. No prefix collides with `BTX` (Bank Transaction, the
prefix already sketched illustratively in the approved Banking-1a proposal
§8.2).

### 2.6 Immutability trigger convention (re-confirmed)

`drizzle/constraints/` has exactly 18 files, one per posted-document table,
none for a master-data table. Two styles exist: **zero-exception** (the
default for a new table — e.g. `007_supplier_payments_immutability_
trigger.sql`: once `status = 'POSTED'`, no `UPDATE` or `DELETE` of any
column is permitted, full stop) and **narrow-exception** (added only once a
genuine future writer exists — e.g. `supplier_bills`' `paidMinor`/
`paymentStatus` exception, added ahead of its AP-1c consumer). Banking-1b has
no known future writer to a `POSTED` Bank Transaction row (no
correction/void workflow exists in this proposal or in Banking-1c's design),
so it should start **zero-exception**, exactly like `customer_receipts`
started.

### 2.7 RBAC precedent (re-confirmed against the live `route-role-matrix.spec.ts`)

Three distinct RBAC shapes coexist in this codebase, confirmed by direct
inspection of the file's current 84-route `EXPECTED` array:

| Resource kind                                                           | Writes                | Reads                             |
| ----------------------------------------------------------------------- | --------------------- | --------------------------------- |
| Chart of Accounts (raw structure)                                       | `finance.admin` only  | `finance.viewer`, `finance.admin` |
| Master data (Suppliers/Customers/AP-AR-Settings/**Bank-Cash-Accounts**) | `finance.admin` only  | all three roles                   |
| **Documents** (Bills/Payments/Invoices/Receipts/Credit-Debit-Notes)     | `finance.poster` only | all three roles                   |

Bank Transaction is a **document** (has a `DRAFT→POSTED` lifecycle, posts a
journal entry) — it belongs in the third row, not the second. This is a
different RBAC shape than Bank/Cash Account itself.

### 2.8 AP/AR "reconciliation" endpoints — re-read directly, confirmed NOT bank reconciliation

`ArReportsService.getArReconciliation()` (`ar-reports.service.ts:623-664`):
compares `subLedgerTotalOutstandingMinor` (Σ invoices − Σ receipts − Σ
credit notes) against `glArControlAccountBalanceMinor`, computed by the
private helper `glAssetBalance()` (`:912-937`):

```sql
SELECT COALESCE(SUM(jl.debit_minor),0) AS raw_debit,
       COALESCE(SUM(jl.credit_minor),0) AS raw_credit
FROM journal_lines jl
INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE jl.account_id = :accountId AND je.tenant_id = :tenantId
  AND je.legal_entity_id = :legalEntityId AND je.status = 'POSTED'
  AND je.transaction_date <= :asOf
```

This is a **sub-ledger-total vs. GL-control-account-balance** check — it
never references `bank_cash_accounts`, never references an external bank
statement, and the word "reconciled" here means only `differenceMinor === 0`
between those two GL-side figures. `ApReportsService`'s equivalent
(`ap-reports.service.ts:581-626`) is the exact mirror. **Confirmed: neither
endpoint has any relationship to bank reconciliation.** `glAssetBalance()`'s
exact query shape is, however, the correct model for Banking-1c's future
"book balance" of a Bank/Cash Account's own GL account — noted for that
later work item, not built here.

### 2.9 POS / UPI / card / payment-provider / settlement — repo-wide grep, fresh

```
grep -rniE "\bPOS\b|\bUPI\b|payment.?gateway|payment.?provider|merchant settlement|
  bank settlement|settlement batch|\bacquirer\b" services/sphere-finance
```

Two hits, both inside Banking-1a's own forward-looking schema comment
(`schema.ts:1766-1768`, referencing the already-approved future boundary).
**Zero functional code, zero other schema, zero other doc.**

```
grep -rniE "\bdeposit\b|\bwithdrawal\b|\btransfer\b" services/sphere-finance/src --include=*.ts
```

Four hits, all "transfer reference" as a free-text label inside an existing
`reference` field's comment (payments/receipts) — **no `DEPOSIT`,
`WITHDRAWAL`, or `TRANSFER` transaction _type_ exists anywhere today.**

```
grep -rn "counterparty" services/sphere-finance/src
```

**Zero hits.** No existing document anywhere in this repository references
two rows of the same entity type on one row (e.g., "from" and "to"). This is
flagged explicitly in §19 below — Banking-1b's `TRANSFER` type is a
genuinely new shape with no precedent to mirror, not an oversight.

### 2.10 Idempotency — repo-wide grep, fresh

```
grep -rniE "idempoten" services/sphere-finance/src --include=*.ts
```

Three hits, all describing `deactivate()`/`reactivate()`'s two-way-toggle
idempotency (master data only). **No idempotency-key mechanism exists
anywhere in this codebase for document `create`/`post` actions.** This is an
existing, system-wide characteristic — not a gap Banking-1b introduces or is
expected to solve uniquely (§17).

### 2.11 `docs/roadmap.md` — checked for anything more specific than already known

Line 167: _"Banking & Cash — [ ] Bank accounts, [ ] Bank transactions, [ ]
Bank reconciliation, [ ] UPI/card/bank payment reconciliation where
applicable, [ ] Cash management, [ ] Cash receipts, [ ] Cash payments, [ ]
Bank transfers, [ ] Cash position."_ This matches, term-for-term, the
Banking-1a/1b/1c split already established — nothing here changes the
sequencing or reveals a requirement not already captured. No roadmap edit is
proposed.

---

## 3. Exact Problem Being Solved

Today, the only way money moves through this Finance suite is via an
AP/AR document (`SupplierPayment`, `CustomerReceipt`) or a hand-authored
`JournalEntry`. Neither fits several real bank/cash events cleanly:

- **Transfers between two of an organization's own Bank/Cash Accounts**
  (e.g., moving float from a CASH till into a BANK account) — not a
  supplier payment, not a customer receipt, not naturally a single-account
  journal entry either (it is inherently a _bank/cash-domain_ event, not a
  generic ledger adjustment a non-Finance-specialist should have to
  construct by hand).
- **Bank fees and interest** — appear on a bank statement with no
  corresponding AP bill or AR invoice ever having been raised; today the
  only way to book one is a raw `JournalEntry`, with no domain-specific
  validation (no requirement that one leg be a genuine Bank/Cash Account).
- **Cash deposits/withdrawals** not tied to a specific supplier or
  customer (e.g., an owner's capital contribution into the business bank
  account, or a cash withdrawal for petty-cash float) — same gap.

Without Banking-1b, an organization's actual bank-account activity is only
_partially_ visible in this system (only the portion that happens to flow
through AP/AR), which makes real bank reconciliation (Banking-1c)
structurally impossible — there is no book-side record of the majority of
line items a real bank statement contains.

---

## 4. Exact In-Scope Capabilities

1. A new document type, **Bank Transaction**, with types `TRANSFER`,
   `DEPOSIT`, `WITHDRAWAL`, `FEE`, `INTEREST`.
2. Standard `DRAFT → POSTED` lifecycle: create (DRAFT), edit (DRAFT-only),
   delete (DRAFT-only), post (DRAFT→POSTED, atomic with its own journal
   entry, immutable thereafter).
3. Each Bank Transaction's primary leg references a Banking-1a
   `bank_cash_accounts` row directly (the first real FK consumer of that
   table).
4. `TRANSFER` additionally references a second, distinct
   `bank_cash_accounts` row (the counterparty leg).
5. `FEE`/`INTEREST`/`DEPOSIT`/`WITHDRAWAL` additionally reference one
   offsetting `chart_of_accounts` row.
6. Posting writes a balanced 2-line journal entry through the same
   replicated Journal Engine discipline every other sub-ledger uses, drawing
   from the same `journal_number_counters` sequence, inside its own
   accounting-period lock.
7. Its own document-numbering sequence (`BTX-NNNNNN`), its own RLS policy,
   its own zero-exception immutability trigger once `POSTED`, its own audit
   trail, its own RBAC (document-shape: `finance.poster` writes, all three
   roles read).
8. Full CRUD + post API, DTOs, and a dedicated e2e/unit test suite,
   mirroring the established pattern exactly.

---

## 5. Explicit Exclusions

Not built in Banking-1b (each with where it actually belongs):

- **Bank Statement Line / statement import (CSV/OFX/API) / any file
  upload** — Banking-1c (§8.3 of the approved proposal); no ingestion
  capability exists anywhere in this repository to build on yet.
- **Bank Reconciliation / matching engine / reconciliation session** —
  Banking-1c.
- **Cash Position report** — Banking-1c (a lightweight aggregate over
  Bank/Cash Accounts' GL balances, meaningless in a useful way until
  reconciliation exists to give it credibility).
- **Bank/Cash Account Statement (running-balance report)** — deferred; see
  §19 item 2 (a genuine open decision, not a settled exclusion).
- **UPI / card / POS / payment-provider / merchant-settlement
  integration of any kind** — explicitly out of scope of the entire Banking
  work-item family per the CTO's original instruction; the seam for this
  lives entirely in Banking-1c's `bank_statement_lines.source` enum
  (already designed, unused), not in Banking-1b.
- **Any change to `supplier_payments`, `customer_receipts`, AP/AR
  settlement logic, or their `bankCashAccountId` validation** — the
  already-flagged open decision (Banking-1a proposal §19 item 5) is not
  re-opened or decided here.
- **Multi-currency / FX.** A Bank Transaction's currency is fixed to its
  legal entity's single functional currency, identical to every other
  document in this schema today.
- **"Unidentified transaction" / suspense-account workflow.** Per the
  already-approved proposal's §11.5, this is judged closer to the future
  POS/payment-provider settlement problem than to core Banking-1b — deferred
  until real settlement data exists to shape it.
- **A `RECONCILED` status on the Bank Transaction itself.** Reconciliation
  state belongs entirely to Banking-1c's statement-line side
  (`matchedBankTransactionId`), not as a third lifecycle state bolted onto
  Bank Transaction — inventing one here would be exactly the kind of
  unjustified lifecycle-mirroring the CTO's prompt warned against (Phase 3,
  item 13).

---

## 6. Data Model

```
Legal Entity
   │
   ├── Bank/Cash Account (Banking-1a, existing)
   │      glAccountId → exactly one chart_of_accounts row
   │
   └── Bank Transaction (NEW, Banking-1b)
          bankCashAccountId        → bank_cash_accounts.id   (primary leg, always)
          counterpartyBankCashAccountId → bank_cash_accounts.id  (TRANSFER only)
          glAccountId              → chart_of_accounts.id    (DEPOSIT/WITHDRAWAL/FEE/INTEREST only)
          journalEntryId           → journal_entries.id      (set once, at posting)
          periodId                 → accounting_periods.id   (set once, at posting)
```

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

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),

    /// Our own "BTX-000123" — null while DRAFT, assigned only at posting
    /// time via bank_transaction_number_counters, identical shape to
    /// every other document's internalReference.
    internalReference: varchar("internal_reference", { length: 20 }),
    status: bankTransactionStatusEnum("status").notNull().default("DRAFT"),
    type: bankTransactionTypeEnum("type").notNull(),
    transactionDate: date("transaction_date").notNull(),

    /// The primary leg — every Bank Transaction has exactly one. FK to
    /// bank_cash_accounts.id (NOT chart_of_accounts directly) — the
    /// first real consumer of Banking-1a's master entity. Re-validated
    /// ACTIVE at create/edit/post time, identical posture to every other
    /// FK-validated reference column in this schema.
    bankCashAccountId: uuid("bank_cash_account_id")
      .notNull()
      .references(() => bankCashAccounts.id),

    /// Required for TRANSFER only (DB CHECK, §6.1); null for every other
    /// type. Must differ from bankCashAccountId and must resolve to a
    /// DISTINCT bank_cash_accounts row in the same legal entity.
    counterpartyBankCashAccountId: uuid(
      "counterparty_bank_cash_account_id",
    ).references(() => bankCashAccounts.id),

    /// Required for DEPOSIT/WITHDRAWAL/FEE/INTEREST (DB CHECK, §6.1);
    /// null for TRANSFER (which needs no offsetting external account —
    /// both legs are bank/cash accounts). Type-validated per §6.2.
    glAccountId: uuid("gl_account_id").references(() => chartOfAccounts.id),

    /// Resolved from the legal entity's functional currency at creation
    /// — never client-supplied. No FX.
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),

    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),

    /// Free-text external reference (bank reference number, cheque
    /// number) — same posture as every other document's `reference`
    /// column; no format validation.
    reference: varchar("reference", { length: 100 }),
    memo: text("memo"),

    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
    ),
    periodId: uuid("period_id").references(() => accountingPeriods.id),

    createdBy: uuid("created_by"),
    postedBy: uuid("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("bank_transactions_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "bank_transactions_transfer_counterparty_shape",
      sql`(${t.type} = 'TRANSFER' AND ${t.counterpartyBankCashAccountId} IS NOT NULL AND ${t.glAccountId} IS NULL)
       OR (${t.type} != 'TRANSFER' AND ${t.counterpartyBankCashAccountId} IS NULL AND ${t.glAccountId} IS NOT NULL)`,
    ),
    check(
      "bank_transactions_transfer_distinct_accounts",
      sql`${t.counterpartyBankCashAccountId} IS NULL OR ${t.counterpartyBankCashAccountId} != ${t.bankCashAccountId}`,
    ),
    index("bank_transactions_tenant_entity_idx").on(
      t.tenantId,
      t.legalEntityId,
    ),
    index("bank_transactions_bank_cash_account_idx").on(t.bankCashAccountId),
  ],
);
```

No line-item table — a Bank Transaction is always exactly a 2-line journal
entry (§8), so there is no `bank_transaction_lines` child table, unlike
`supplier_bills`/`customer_invoices` (which need a variable-length line
array). This mirrors `supplier_payments`/`customer_receipts` themselves,
which also have no "lines" table for their own always-2-line journal.

### 6.1 The `CHECK` constraints, explained

The two shape constraints above are the DB-level enforcement of "don't
conflate concepts merely because they move money" (Phase 3, item 1): a
`TRANSFER` is defined as _exactly_ two Bank/Cash Account legs and nothing
else; every other type is defined as _exactly_ one Bank/Cash Account leg
plus one external GL leg. This is a genuinely new constraint shape for this
codebase — no existing table has an app-defined "which columns must be
null depending on this row's own enum value" `CHECK` — flagged as evidence-
grounded but novel (§19).

### 6.2 `glAccountId` type validation, by transaction type

- `FEE` → `glAccountId` must be an active `EXPENSE` account (bank charges).
- `INTEREST` → `glAccountId` must be an active `REVENUE` account (interest
  earned). _(Interest **paid**, e.g. on an overdraft, would need an EXPENSE
  leg — flagged as an open decision, §19 item 3, rather than silently
  assumed.)_
- `DEPOSIT`/`WITHDRAWAL` → `glAccountId` must simply be **active**, in the
  caller's own tenant/legal entity — **no type restriction.** A deposit's
  source, or a withdrawal's destination, can legitimately be `EQUITY`
  (capital contribution/owner's draw), `LIABILITY` (loan proceeds
  deposited), another `ASSET` (proceeds of an asset sale), or in principle
  `REVENUE`/`EXPENSE` in an edge case — unlike `FEE`/`INTEREST`, which are
  narrowly defined as P&L events, `DEPOSIT`/`WITHDRAWAL` are defined only
  by "money enters/leaves a Bank/Cash Account from/to some other GL
  account," with no narrower business meaning to validate against.

`bankCashAccountId` (and, for `TRANSFER`, `counterpartyBankCashAccountId`)
must resolve to an `isActive = true` row in `bank_cash_accounts`, in the
caller's own `(tenantId, legalEntityId)` — the identical validation shape
Banking-1a already established for its own `glAccountId` field, just
pointed at the new table instead of `chart_of_accounts`.

---

## 7. Transaction Lifecycle

`DRAFT → POSTED`, the identical two-state shape every other posted document
in this codebase uses (§2.6) — **not a new lifecycle invented for Banking**,
directly answering Phase 3 item 13. `DRAFT`: create, edit any field, delete.
`POSTED`: immutable (zero-exception trigger, §12), no further transition
(no `VOID`/reverse in this work item — not evidenced as needed, and
`JournalEntriesService.reverse()` remains available at the raw journal-entry
level for a correction if one is ever needed, same as it already is for
every other document type today).

---

## 8. GL Integration

**No second accounting engine** (§2.2). Every Bank Transaction post writes
one journal entry with exactly two balanced lines, inside its own
`withTenant` transaction, using the same `journal_number_counters` sequence:

```
TRANSFER   (A → B):  DEBIT  B.glAccountId   / CREDIT A.glAccountId
DEPOSIT:              DEBIT  bankCashAccountId.glAccountId  / CREDIT glAccountId
WITHDRAWAL:           DEBIT  glAccountId                    / CREDIT bankCashAccountId.glAccountId
FEE:                  DEBIT  glAccountId (EXPENSE)          / CREDIT bankCashAccountId.glAccountId
INTEREST:             DEBIT  bankCashAccountId.glAccountId  / CREDIT glAccountId (REVENUE)
```

Where "`X.glAccountId`" means: resolve the Bank/Cash Account's own
`glAccountId` (a single extra `SELECT` against `bank_cash_accounts`, inside
the same transaction, under no special lock — Bank/Cash Accounts are never
mutated by a Bank Transaction post, so no row lock on `bank_cash_accounts`
is needed, unlike the multi-bill locking `SupplierPaymentsService.post()`
performs against `supplier_bills`, §17).

This directly answers Phase 3 items 2/3/6: the Bank Transaction _is_ the
source of truth for its own journal entry (it creates it, exactly as
`supplier_payments`/`customer_receipts` create theirs); it is categorically
distinct from a **bank statement line** (an external-truth record,
Banking-1c, not created here); distinct from a raw **GL transaction**
(`journal_entries`/`journal_lines` themselves, which every document —
including this one — writes into, never a separate concept); and distinct
from an **AP/AR settlement** (`supplier_payments`/`customer_receipts`
remain their own, untouched document types that _also_ happen to post
against a `bankCashAccountId`-referenced GL account, but are not, and never
become, Bank Transactions — they are siblings under the same GL account,
not a parent/child relationship).

---

## 9. Accounting-Period Semantics

Identical predicate to every existing poster (§2.4): posting a Bank
Transaction requires an `accounting_periods` row covering
`transactionDate`, locked `FOR UPDATE` inside the posting transaction, with
`status = 'OPEN'` — else `UnprocessableEntityException`. No new
future-dating restriction is introduced; Banking-1b inherits the existing
system-wide behavior (an `OPEN` period covering a future date already
permits posting today, for every document type) rather than inventing a
Banking-specific rule with no evidence requiring one.

---

## 10. Bank/Cash Account Relationship

`bankCashAccountId` (and, for `TRANSFER`, `counterpartyBankCashAccountId`)
is a **direct FK to `bank_cash_accounts.id`** — not to `chart_of_accounts`,
unlike `supplier_payments`/`customer_receipts`. This is the concrete,
evidence-grounded answer to Phase 3 item 5's "should Banking-1b become the
first real consumer of the bank-account master entity" question: **yes, for
its own new table**, because Banking-1b is being designed _after_
Banking-1a exists, with no historical-data-compatibility constraint to
respect (unlike AP/AR, which already have millions of potential historical
rows referencing `chart_of_accounts` directly, and whose own migration is
explicitly deferred per §19 item 5). This is not a retrofit of AP/AR; it is
simply the correct, natural design for a brand-new table.

`legalEntityId` is validated identically everywhere: the referenced
`bank_cash_accounts` row(s) must belong to the caller's own
`(tenantId, legalEntityId)` — no cross-legal-entity Bank/Cash Account may
ever be referenced, mirroring every other cross-entity-reference check in
this codebase.

`currencyCode` is resolved from the legal entity's functional currency at
creation (identical to Banking-1a's own `resolveCurrency`), not read from
the referenced Bank/Cash Account's `currencyCode` field directly — though
today these are always equal (Banking-1a's own `currencyCode` is itself
resolved the same way), so this is a distinction without a practical
difference until multi-currency ever exists.

**Active/inactive state**: `bankCashAccountId`/`counterpartyBankCashAccountId`
must reference an `isActive = true` `bank_cash_accounts` row at
create/edit/post time (mirroring the "active at write time only" posture
Banking-1a itself uses for its own `glAccountId`). Once a Bank Transaction
is `POSTED`, it remains fully readable even if its referenced Bank/Cash
Account is later deactivated — the identical "historical read never
re-validates" correction Banking-1a already established, applied
consistently one layer up.

---

## 11. RLS / RBAC

**RLS**: `bank_transactions` gets the byte-identical `tenant_isolation`
policy every Finance table uses (`012_bank_transactions_rls.sql`, next
available number — §15). `legal_entity_id` isolation remains an explicit
service-layer predicate on every query, not RLS-covered, matching every
prior table without exception.

**RBAC**: Bank Transaction is a **document**, not master data (§2.7) — it
follows the third RBAC row, the identical shape `SupplierPaymentsController`/
`CustomerReceiptsController` already use:

```
POST   /bank-transactions              finance.poster
GET    /bank-transactions              finance.viewer, finance.poster, finance.admin
GET    /bank-transactions/:id          finance.viewer, finance.poster, finance.admin
PATCH  /bank-transactions/:id          finance.poster
DELETE /bank-transactions/:id          finance.poster
POST   /bank-transactions/:id/post     finance.poster
```

This is a **different** RBAC shape than `bank-cash-accounts` itself
(`finance.admin`-only writes) — deliberately: creating/editing the Bank/Cash
Account _master record_ is an admin action (mirrors settings/suppliers/
customers), while _posting a transaction against_ one is an operational
poster action (mirrors posting a bill/invoice/payment/receipt). No new role
is required — the existing three-role catalog already expresses this split
cleanly.

---

## 12. Audit / Immutability

**Audit**: every mutation (`CREATE`/`UPDATE`/`DELETE`/`POST`) writes an
`audit_logs` row in the same transaction, `entityType: "bank_transaction"` —
identical convention, no deviation. Posting additionally writes a second
audit row for the created `journal_entry` (`action: "CREATE"`,
`entityType: "journal_entry"`), mirroring `SupplierPaymentsService.post()`'s
own two-row-plus-per-child-row audit shape exactly (§2.2 — though Bank
Transaction has no child rows analogous to bill settlement, so it is a
2-row audit write per post: one for the transaction, one for the journal
entry, not N+2).

**Immutability**: a new **zero-exception** trigger
(`019_bank_transactions_immutability_trigger.sql`, next available number —
§15), modeled directly on `007_supplier_payments_immutability_trigger.sql`:
once `status = 'POSTED'`, no column may be updated and the row may not be
deleted. No narrow exception is proposed — no future writer to a `POSTED`
Bank Transaction is evidenced anywhere in this proposal or in Banking-1c's
existing design sketch (Banking-1c's matching state lives entirely on the
_statement-line_ side, per §5's exclusion — a matched Bank Transaction's own
row is never written to by the matching process).

---

## 13. API Surface

```
bank-transactions/
├── bank-transactions.controller.ts
├── bank-transactions.module.ts
├── bank-transactions.service.ts
└── dto/
    ├── create-bank-transaction.dto.ts (+ .spec.ts)
    └── update-bank-transaction.dto.ts (+ .spec.ts)
```

Registered as a **new top-level sibling** in `AppModule`, alongside
`BankCashAccountsModule` — not nested inside it, and not inside AP/AR — for
the identical reasoning Banking-1a's own module placement already
established: Banking is its own domain. All routes under the existing
`/v1/finance` prefix; no new API-Gateway manifest entry needed (single-
manifest-per-service convention, unchanged).

Routes, per §11:

```
POST   /bank-transactions
GET    /bank-transactions?bankCashAccountId=&type=&status=&dateFrom=&dateTo=
GET    /bank-transactions/:id
PATCH  /bank-transactions/:id
DELETE /bank-transactions/:id
POST   /bank-transactions/:id/post
```

(Query filters on `GET` list are additive convenience filters, not a
reporting endpoint — see §19 item 2 for whether a dedicated
running-balance statement endpoint should also exist.)

---

## 14. DTOs

Mirrors `CreateSupplierPaymentDto`'s exact validator shape (§2, re-read
directly):

```ts
const BANK_TRANSACTION_TYPES = [
  "TRANSFER",
  "DEPOSIT",
  "WITHDRAWAL",
  "FEE",
  "INTEREST",
] as const;

export class CreateBankTransactionDto {
  @IsIn(BANK_TRANSACTION_TYPES)
  type!: (typeof BANK_TRANSACTION_TYPES)[number];

  @IsDateString()
  transactionDate!: string;

  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsUUID()
  bankCashAccountId!: string;

  // Required iff type === "TRANSFER"; validated by a custom
  // @ValidateIf(o => o.type === "TRANSFER") pair with glAccountId's own
  // @ValidateIf(o => o.type !== "TRANSFER") — mirrors the shape of the
  // DB CHECK constraint (§6.1) at the DTO layer, so a malformed payload
  // is rejected with a clear 400 before it ever reaches the DB
  // constraint.
  @ValidateIf((o) => o.type === "TRANSFER")
  @IsUUID()
  counterpartyBankCashAccountId?: string;

  @ValidateIf((o) => o.type !== "TRANSFER")
  @IsUUID()
  glAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;
}
```

`currencyCode`/`status`/`internalReference`/`journalEntryId`/`periodId` are
absent — all server-resolved, identical convention to every existing
create DTO. `UpdateBankTransactionDto` mirrors `UpdateSupplierPaymentDto`'s
shape (all fields optional, same `@ValidateIf` pairing for the
type-dependent fields, `type` itself likely **not** editable post-creation —
flagged as §19 item 4, since changing `type` after creation would require
re-validating the entire counterparty/glAccountId shape and no existing
document type allows changing its own fundamental "kind" mid-DRAFT either).

---

## 15. Migration Strategy

Fully additive, identical posture to Banking-1a (§2.11 of the approved
proposal, and Banking-1a's own delivery):

- Migration: next available number, `0013` (confirmed: `drizzle/migrations/`
  currently ends at `0012_sweet_maddog.sql`).
- RLS file: `012_bank_transactions_rls.sql` (confirmed: `drizzle/rls/`
  currently ends at `011_bank_cash_accounts_rls.sql`).
- Immutability constraint file: `019_bank_transactions_immutability_
trigger.sql` (confirmed: `drizzle/constraints/` currently ends at
  `018_supplier_debit_note_allocations_immutability_trigger.sql`).
- New table: `bank_transaction_number_counters` (structurally identical to
  every other document-numbering counter, §2.5).
- **Zero `ALTER` of any existing table** — `bank_cash_accounts`,
  `supplier_payments`, `customer_receipts`, `journal_entries`,
  `journal_lines`, `chart_of_accounts`, `accounting_periods` are all
  referenced only via new FKs from the new `bank_transactions` table; none
  is modified.
- No backfill — there is no historical data to migrate into a brand-new
  document type.

---

## 16. Test Strategy

Mirrors the established rigor exactly (Banking-1a's own 46-test e2e suite +
independent PostgreSQL verification, §16 of the approved proposal):

**DTO unit tests** (create + update): valid payload per type, the
`@ValidateIf` type-dependent-field pairing (a `TRANSFER` payload with
`glAccountId` set instead of `counterpartyBankCashAccountId` must be
rejected; a `FEE` payload with `counterpartyBankCashAccountId` set instead
of `glAccountId` must be rejected), amount positivity, UUID validation,
maxlength validation.

**E2e suite** (`bank-transactions.e2e-spec.ts`): RBAC (document shape —
poster writes, all three roles read); full lifecycle (create/edit/delete
while DRAFT, post, immutability after POSTED — attempted `PATCH`/`DELETE`
on a `POSTED` row must 409/403 at the app layer, backed by the DB trigger);
per-type GL-account validation (§6.2 — `FEE` rejects a non-EXPENSE account,
`INTEREST` rejects a non-REVENUE account, `DEPOSIT`/`WITHDRAWAL` accept any
active type, all four reject a cross-tenant/cross-entity/inactive account);
`TRANSFER`-specific validation (rejects same account as both legs, rejects
a `counterpartyBankCashAccountId` in a different legal entity, verifies the
correct DEBIT/CREDIT polarity on both legs); posted-journal-entry
correctness for every type (verify the exact 2-line journal, correct
account, correct debit/credit side, balanced); accounting-period
interaction (no covering period → reject, CLOSED period → reject); numbering
(`BTX-NNNNNN` assigned only at post, sequential, race-safe — a concurrent-
post race test mirroring Banking-1a's own concurrent-create race test);
cross-tenant/cross-legal-entity isolation; audit trail (2-row audit on post:
transaction + journal entry).

**Independent PostgreSQL verification**, matching Banking-1a's own
raw-`psql` rigor: table/enum/`CHECK`-constraint existence, RLS
enabled+forced, `tenant_isolation` policy present, immutability trigger
rejects a raw `UPDATE`/`DELETE` on a `POSTED` row directly (not only via the
app layer), the balance-invariant trigger still holds for Bank
Transaction-originated journal entries exactly as for every other document
type.

**No AR/AP report-suite extension is expected** — Banking does not touch
AR/AP sub-ledger totals (§2.8), matching the same conclusion the approved
Banking-1a proposal already reached for Banking-1a itself.

---

## 17. Concurrency / Idempotency Considerations

**Locking is simpler than AP/AR posting, not harder.** `SupplierPaymentsService
.post()` must lock every allocated `supplier_bills` row in a fixed ascending-
id order to prevent a deadlock between two concurrent payments touching an
overlapping bill set (§2, `supplier-payments.service.ts:396-416`). Bank
Transaction posting has **no analogous multi-row mutation** — it reads
(does not lock or mutate) the referenced `bank_cash_accounts` row(s) purely
to resolve their `glAccountId`, and the only row genuinely locked
`FOR UPDATE` is the covering `accounting_periods` row, identical to every
other poster. Two concurrent Bank Transaction posts referencing the same
Bank/Cash Account do not contend with each other at all (no shared mutable
state on `bank_cash_accounts` itself is touched by a transaction post).

**Numbering race**: closed by the identical atomic `INSERT ... ON CONFLICT
DO UPDATE ... RETURNING` pattern every counter table already uses — no new
race-handling logic required.

**No idempotency-key mechanism** exists anywhere in this codebase for
document `create`/`post` actions (§2.10) — a double-submitted `POST
/bank-transactions/:id/post` request is exposed to the identical
double-post risk every existing document type already carries (mitigated
only by the `status !== 'DRAFT'` check raising `409` on the second attempt,
same as everywhere else). This is an existing, system-wide characteristic;
Banking-1b neither introduces a new risk nor is expected to uniquely solve
a gap no other document type has solved either.

---

## 18. Risks and Limitations

- **The `TRANSFER` counterparty shape is genuinely novel** (§2.9, §6.1) —
  no precedent in this codebase for a document referencing two rows of the
  same entity, or for an app-defined "which columns are null depends on
  this row's enum value" `CHECK` constraint. Flagged explicitly rather than
  silently implemented as if it were a mechanical extension of an existing
  pattern.
- **`glAccountId` type policy for `INTEREST`** assumes interest _earned_
  (REVENUE) only; interest _paid_ (e.g., overdraft interest, an EXPENSE)
  is not modeled — flagged as §19 item 3.
- **`DEPOSIT`/`WITHDRAWAL`'s unrestricted `glAccountId` type** is a
  deliberately permissive design choice with no directly analogous existing
  precedent (every other type-validated GL reference in this schema
  restricts to one or two specific types) — flagged as §19 item 5 for
  explicit sign-off rather than assumed correct by inference.
- **No Bank/Cash Account Statement report** ships with Banking-1b under
  the recommendation in §19 item 2 — a user can create and post Bank
  Transactions but has no dedicated running-balance view of a single
  account until either that decision is revisited or Banking-1c ships.
- **AP/AR's `bankCashAccountId` still cannot resolve to a `bank_cash_
accounts` row that itself has no matching GL account** — this is
  unchanged from Banking-1a and is not addressed by Banking-1b either (the
  deferred §19 item 5 of the _original_ proposal); Bank Transactions and
  AP/AR payments/receipts against the same physical bank account remain
  visible together only via the read-side join already established, with
  no schema link between `bank_transactions` and
  `supplier_payments`/`customer_receipts` directly.
- **No correction/void workflow.** A `POSTED` Bank Transaction with a
  data-entry error can only be corrected via a manual reversing
  `JournalEntry` today (the same limitation every zero-exception-trigger
  document type in this codebase already has) — not a Banking-1b-specific
  gap, but worth stating plainly since Banking has no analogous "debit/
  credit note" concept the way AP/AR do.

---

## 19. CTO Decisions Required

1. **The `TRANSFER` counterparty shape (§6, §18).** Recommended:
   single `bank_transactions` row with `bankCashAccountId` (the "from" leg
   by convention) and `counterpartyBankCashAccountId` (the "to" leg),
   enforced by the two `CHECK` constraints in §6.1. Alternative: two linked
   rows (a genuinely new "linked pair" concept with no precedent at all,
   more complex, no clear benefit identified). *Recommendation: single row
   - CHECK constraints, as designed above.*
2. **Whether a Bank/Cash Account Statement (running-balance) endpoint
   ships alongside Banking-1b, or is deferred to Banking-1c.** The
   original Banking-1a proposal (§14, §19 item 6) left this explicitly
   open. _Recommendation: defer — it is a pure read-layer addition that
   can be added at any point once Bank Transactions exist, without
   reshaping anything in this proposal; shipping it now would widen
   Banking-1b's surface without being required to close the core
   create→post→(eventually)reconcile lifecycle._
3. **`INTEREST` type restriction — REVENUE-only, or allow EXPENSE
   (interest paid) too.** _Recommendation: REVENUE-only for Banking-1b's
   first cut (the common case — interest earned on a balance); if interest
   *paid* needs modeling, it can use the `FEE` type today (an EXPENSE-side
   bank charge) as a reasonable stand-in, or a dedicated `INTEREST_PAID`
   type can be added additively in a later pass once real usage justifies
   it — not a blocking decision now._
4. **Whether `type` is editable on a `DRAFT` Bank Transaction via
   `PATCH`.** _Recommendation: no — `type` is immutable from creation
   (mirrors how no existing document type allows changing its own
   fundamental "kind"/document-type mid-DRAFT); to change type, delete and
   recreate the DRAFT, which is cheap since nothing has posted yet._
5. **`DEPOSIT`/`WITHDRAWAL`'s `glAccountId` type restriction — fully
   unrestricted (as designed, §6.2), or narrowed to a specific allow-list
   (e.g., `ASSET`+`LIABILITY`+`EQUITY` only, excluding `REVENUE`/`EXPENSE`
   which would arguably always be better modeled as `FEE`/`INTEREST` or an
   AP/AR document instead).** _Recommendation: narrow to
   `ASSET`+`LIABILITY`+`EQUITY` — closer to the actual business meaning of
   "money enters/leaves the business from/to a balance-sheet source," and
   steers a genuine P&L-side deposit/withdrawal toward the more precise
   `FEE`/`INTEREST` types (or, if it is genuinely revenue/expense
   unrelated to banking, toward a proper AP/AR document) rather than
   leaving `DEPOSIT`/`WITHDRAWAL` as a catch-all for anything._
6. **Confirm Bank Transaction as the correct, complete scope of
   Banking-1b** — the core sequencing recommendation this entire document
   rests on, and confirmation that `TRANSFER`/`DEPOSIT`/`WITHDRAWAL`/`FEE`/
   `INTEREST` is the complete and correct type list (no additional type
   identified anywhere in the repository evidence gathered for this
   discovery pass).

---

## 20. Acceptance Criteria

- New migration (`0013`, additive only) creates `bank_transaction_type`
  enum, `bank_transaction_status` enum, `bank_transactions` table, and
  `bank_transaction_number_counters` table exactly as designed in §6, or as
  amended by the CTO decisions in §19.
- Full document lifecycle (create/list/get/edit/delete/post) via a new
  `BankTransactionsController`/`Service`/`Module`, file-structured
  identically to `SupplierPaymentsModule` (§13).
- `bankCashAccountId`/`counterpartyBankCashAccountId` validated against
  `bank_cash_accounts` (active, own tenant/legal entity); `glAccountId`
  validated against `chart_of_accounts` per the type-specific rule in §6.2
  (as amended by §19 item 5), at create/edit/post time.
- `currencyCode` resolved from the legal entity's functional currency,
  never client-supplied.
- Posting writes exactly one balanced, `POSTED` journal entry per §8,
  drawing from the same `journal_number_counters` sequence used by every
  other document, inside the Bank Transaction's own `withTenant`
  transaction — no call into `JournalEntriesService`.
- `BTX-NNNNNN` internal reference assigned exactly once, at posting, via
  the new `bank_transaction_number_counters` table.
- RLS `tenant_isolation` policy applied (`012_bank_transactions_rls.sql`);
  `legal_entity_id` isolation enforced as an explicit service-layer
  predicate on every query.
- RBAC per §11's table (document shape, not master-data shape);
  `route-role-matrix.spec.ts` updated and green.
- Audit rows (`CREATE`/`UPDATE`/`DELETE`/`POST` on the transaction,
  `CREATE` on the resulting journal entry) written inside the same
  transaction as every mutation.
- Zero-exception immutability trigger (`019_bank_transactions_
immutability_trigger.sql`) once `POSTED`.
- **Zero changes to any file outside**: the new module, its migration,
  RLS file, immutability constraint file, and the route-role-matrix —
  confirmed via an exact `git diff` scope review at delivery time. In
  particular: zero changes to `bank_cash_accounts`,
  `supplier_payments`, `customer_receipts`, `journal_entries`,
  `journal_lines`, `chart_of_accounts`, `accounting_periods`, or any file
  under AP/AR/Financial Statements/General Ledger.
- Full unit (DTO) + e2e test coverage (§16); typecheck/lint/build clean;
  the complete pre-existing unit + e2e suites re-run with zero
  regressions; e2e suite run twice for stability.
- Independent PostgreSQL verification (schema/enum/`CHECK`/RLS/trigger
  presence, raw-SQL cross-tenant/cross-entity isolation checks,
  immutability-trigger enforcement at the DB level, balance-invariant
  trigger still holding), matching Banking-1a's own rigor.

---

## 21. Implementation Sequence (procedural, once approved — not started)

1. Resolve the six open CTO decisions in §19.
2. Migration `0013`: `bank_transaction_type`/`bank_transaction_status`
   enums, `bank_transactions` table (with its two `CHECK` constraints),
   `bank_transaction_number_counters` table — as amended by §19.
3. RLS file `012_bank_transactions_rls.sql`.
4. Immutability constraint file
   `019_bank_transactions_immutability_trigger.sql`.
5. `BankTransactionsModule` (controller/service/module/DTOs), registered
   as a new top-level sibling module in `AppModule` (§13).
6. `route-role-matrix.spec.ts` update (§11).
7. Unit (DTO) tests + new `bank-transactions.e2e-spec.ts` (§16).
8. Full verification suite: typecheck, lint, build, complete unit suite,
   complete e2e suite run twice, independent PostgreSQL verification —
   identical rigor and sequence to Banking-1a's own delivery.
9. Exact `git diff` scope review confirming zero out-of-scope files
   touched (including the two standing hardening exceptions, left
   untouched), commit, create and verify a delivery bundle. **Do not push
   without explicit instruction**, per standing process.

---

## STOP

Discovery and proposal complete. No source code, schema, migration, RLS
file, constraint file, or test has been created or modified. No commit has
been made. Awaiting CTO review, correction, or approval before any
implementation begins.
