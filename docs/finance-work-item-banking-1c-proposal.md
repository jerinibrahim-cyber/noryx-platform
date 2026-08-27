# Finance Work Item — Banking-1c: Bank Statement Import & Bank Reconciliation

Status: **DISCOVERY / PROPOSAL — awaiting CTO approval. Nothing in this
document has been implemented.**

Baseline this proposal was written against: `HEAD` = `origin/main` =
`6993993865352983fff2063d2d209a5f6916c9d0` (Banking-1b, merged/pushed).
Verified via `git fetch origin && git rev-parse HEAD origin/main` before
writing a single line of this document.

**Amendment note**: this revision incorporates the CTO's Banking-1c
amendment pass. The single most important correction: **BOOK BALANCE is
the actual General Ledger balance of `bank_cash_accounts.glAccountId`**
(computed via `GeneralLedgerService.getBalance`'s existing semantics),
**not** a sum of `bank_transactions` movements. `bank_transactions`
remains the MVP **matching candidate universe** — a separate concept
from book balance, defined precisely in §17. Reconciliation completion
now requires both matching completeness (every line MATCHED or
IGNORED) and balance equality (statement closing balance = GL book
balance) — see §9/§17. Decision 13 is rewritten accordingly (§19). The
architecture (three tables, CSV MVP, deterministic matching, manual
confirmation, reconciliation-never-posts-GL, the future POS seam) is
unchanged and remains fundamentally approved.

---

## 1. Executive Summary

Banking-1c is the first genuine **external-data-ingestion** capability in
NoryX Finance: importing a bank statement (initially CSV), representing
its lines as first-class records, matching those lines against NoryX's
own accounting data, and closing a reconciliation once the statement's
declared closing balance agrees with the Bank/Cash Account's actual
General Ledger balance.

The central design finding of this discovery phase is that Banking-1c is
**not** "Banking-1b plus a matcher." It is a new domain — an external,
untrusted, append-only feed reconciled against internal, trusted,
already-posted accounting records — and it surfaces a real architectural
wrinkle that Banking-1b alone does not: **the GL account behind a
Bank/Cash Account is not exclusively written to by `bank_transactions`**.
Supplier Payments and Customer Receipts post directly to a
`chart_of_accounts` row that may be the very same account a Bank/Cash
Account points at (§4, §17). This is evidence-grounded (not assumed), and
this revision draws the resulting distinction precisely: **BOOK BALANCE**
is always the true GL balance of that account (§17) — AP/AR/manual-
journal activity is automatically _included_ in it, because it already
exists in `journal_lines`. What remains scoped to `bank_transactions` for
MVP is only the **matching candidate universe** — which internal records
the deterministic matcher can pair a statement line against — because no
generic "which document produced this journal entry" provenance resolver
exists in this codebase (§2.9). Balance correctness and matching
completeness are therefore two separate, independently-tracked
properties (§9, Decision 13), never conflated.

The proposal recommends three new tables (`bank_statement_imports`,
`bank_statement_lines`, `bank_reconciliation_matches`), zero changes to
any existing table, a strict separation between the reconciliation layer
(matching/linking only) and the two layers that already own accounting
mutation (Banking Ledger = `bank_transactions`, GL = `journal_entries`/
`journal_lines`), CSV as the sole MVP import format, and a deterministic,
rule-based automatic matching engine (renamed from "EXACT" — a ±N-day
date tolerance is not an exact match, §8) with manual confirmation and
manual-only support for one-to-many/many-to-one and partial matches.

---

## 2. Current Repository Evidence

### 2.1 `bank_cash_accounts` (Banking-1a) — exact schema

`services/sphere-finance/src/db/schema.ts:1748-1826`:

- `bankCashAccountKindEnum` (1748) — `BANK` | `CASH`.
- `bankCashAccounts` (1753): `id`, `tenantId`, `legalEntityId`, `code`
  (unique per tenant+entity, 1810), `name`, `kind`, `glAccountId` (real
  FK -> `chartOfAccounts.id`, 1779-1781, **unique** —
  `bank_cash_accounts_gl_account_unique`, 1820 — at most one Bank/Cash
  Account per GL account), `currencyCode` (resolved server-side, never
  client-supplied), `bankName`, `maskedAccountNumber` (both free text,
  unvalidated), `isActive`, `createdBy`, `createdAt`, `updatedAt`.
- Master data: no `status`, no `journalEntryId`/`periodId`, no
  immutability trigger (schema.ts:1725-1730 doc comment is explicit
  about this).
- RLS: `drizzle/rls/011_bank_cash_accounts_rls.sql` — `tenant_id`-only;
  `legalEntityId` isolation is an explicit service-layer predicate
  (`BankCashAccountsService`), never RLS.

### 2.2 `bank_transactions` (Banking-1b) — exact schema

`services/sphere-finance/src/db/schema.ts:1882-2008`:

- `bankTransactionNumberCounters` (1882) — dedicated `BTX-NNNNNN`
  counter, separate from every other document's own counter.
- `bankTransactionTypeEnum` (1895) — `TRANSFER` | `DEPOSIT` |
  `WITHDRAWAL` | `FEE` | `INTEREST`.
- `bankTransactionStatusEnum` (1903) — `DRAFT` | `POSTED`.
- `bankTransactions` (1908): `id`, `tenantId`, `legalEntityId`,
  `internalReference` (null until posted), `status`, `type`,
  `transactionDate`, `bankCashAccountId` (real FK ->
  `bankCashAccounts.id`), `counterpartyBankCashAccountId` (TRANSFER
  only), `glAccountId` (real FK -> `chartOfAccounts.id`, every other
  type only), `currencyCode`, `amountMinor` (always positive — CHECK
  `bank_transactions_amount_positive`), `reference` (free text,
  unvalidated), `memo`, `journalEntryId`, `periodId`, `createdBy`,
  `postedBy`, `postedAt`, `createdAt`, `updatedAt`.
- Two CHECK constraints (1985-1997):
  `bank_transactions_transfer_counterparty_shape` (TRANSFER has exactly
  the counterparty leg and no GL leg; every other type has exactly one
  GL leg and no counterparty leg) and
  `bank_transactions_transfer_distinct_accounts`.
- Immutability: `drizzle/constraints/019_bank_transactions_immutability_trigger.sql`
  — zero-exception, rejects any UPDATE/DELETE once `status = POSTED`.
- RLS: `drizzle/rls/012_bank_transactions_rls.sql` — `tenant_id`-only,
  same convention as every other table.

### 2.3 Bank transaction types and statuses

Five types (C above); two statuses, `DRAFT` -> `POSTED`, one-way (no
`REVERSED`/`VOIDED` state exists on this table — confirmed by the enum
itself, `schema.ts:1903-1906`).

### 2.4 How bank transactions reference bank/cash accounts

Directly, by real FK to `bank_cash_accounts.id` — Banking-1b's own doc
comment (`schema.ts:1846-1849`) states this is the _first_ real FK
consumer of that master table. This is structurally different from how
Supplier Payments/Customer Receipts reference a "bank account" — see
§2.9, this is critical.

### 2.5 How bank transactions post to GL

`BankTransactionsService.post()` (`src/bank-transactions/bank-transactions.service.ts:389-600`)
replicates the Journal Engine's posting discipline directly — lock,
re-validate every leg's account is still ACTIVE (including the linked GL
account, `revalidateBankCashAccountForPostingOrThrow`, lines 645-674),
resolve+lock the covering OPEN period, allocate `BTX-NNNNNN` and
`JE-NNNNNN` atomically, insert a DRAFT journal entry then its two lines
then flip both to POSTED, 2-row audit. It never calls
`JournalEntriesService`. GL polarity is exact and documented at lines
420-467.

### 2.6 Does a bank transaction represent the INTERNAL accounting-side transaction?

Yes, unambiguously — `bank_transactions` is NoryX's own record of money
movement through a Bank/Cash Account, entirely independent of, and with
no awareness of, what a real external bank statement will eventually
say happened. It is the "internal candidate" side of any future
matching problem, not the external side.

### 2.7 Fields available for matching against an external statement

`bankCashAccountId` (which account), `transactionDate` (NoryX's own
accounting date — not necessarily the bank's clearing date, see §2.8),
`amountMinor` (unsigned; direction is implied by `type`), `currencyCode`
(trivial — always the legal entity's single functional currency, no FX
exists anywhere in this schema), `reference` (free text, unvalidated,
may or may not hold the bank's own reference), `memo` (free text).

### 2.8 Fields missing for reliable matching

No **value date** distinct from `transactionDate` (a bank's clearing
date frequently differs from the date NoryX recorded the transaction).
No **external/bank transaction ID** column — nothing captures a bank's
own reference deterministically; `reference` is user-typed at
create/edit time, not sourced from a feed. No **direction-normalized**
field — direction must be derived from `type` (DEPOSIT/INTEREST =
inflow; WITHDRAWAL/FEE = outflow; TRANSFER = outflow on
`bankCashAccountId`, inflow on `counterpartyBankCashAccountId`). None of
these are proposed as new columns on `bank_transactions` itself (§6) —
they belong on the new external-side table instead.

### 2.9 The AP/AR bypass — critical, evidence-grounded finding

`supplierPayments.bankCashAccountId` (`schema.ts:724-726`) and
`customerReceipts`' own equivalent column (`schema.ts:1199-1203`) are
**plain `chart_of_accounts` references**, not FKs to
`bank_cash_accounts`. The schema's own doc comment is explicit
(`schema.ts:1732-1739`): _"The `bankCashAccountId` columns already on
supplier_payments and customer_receipts are untouched by this table and
remain plain chart_of_accounts references... A Bank/Cash Account is
resolved for an existing payment/receipt purely by joining
`bank_cash_accounts.glAccountId = supplier_payments.bankCashAccountId`."_

Consequence: a Supplier Payment or Customer Receipt can (and in normal
operation, routinely will) post a journal line against the **exact same
GL account** a Bank/Cash Account is linked to — entirely bypassing
`bank_transactions`. `journal_lines` (`schema.ts:280-318`) has no
polymorphic source-document pointer (no `sourceType`/`sourceId`); the
only way to trace a `journal_entries` row back to its originator is via
that originator's own forward `journalEntryId` column, and at least six
document tables each have one (`grep -n "journalEntryId: uuid"
src/db/schema.ts` → lines 288 (journal_lines→journal_entries itself),
547, 734, 1017, 1212, 1393, 1591, 1963 — bills, payments, invoices,
receipts, credit notes, debit notes, bank transactions). A **seventh**
source exists too: manual Journal Entries created directly through the
2c Journal Engine can debit/credit any GL account, including a bank's.

This means: **a real bank statement will contain lines with no
corresponding `bank_transactions` row** whenever the underlying activity
was recorded as a Supplier Payment, a Customer Receipt, or a manual
Journal Entry instead. This is not a hypothetical edge case — it is the
normal, expected shape of AP/AR disbursement and collection today.
Critically, this activity is **still fully present in `journal_lines`**
against the Bank/Cash Account's GL account, so it is automatically
reflected in that account's true GL balance (§2.13) even though
Banking-1c's MVP matcher cannot pair a statement line against it
individually. See §17 (balance semantics) and Decision 13 for the
precise, corrected treatment.

### 2.13 `GeneralLedgerService.getBalance` — the existing account-balance

### calculation this proposal reuses as BOOK BALANCE's architectural reference

`GeneralLedgerService.getBalance(tenantId, legalEntityId, accountId,
query)` (`src/general-ledger/general-ledger.service.ts:268-355`,
exposed at `GET /accounts/:id/balance`,
`general-ledger.controller.ts:69`) computes an **any-account** balance
purely from `journal_lines` — `rawTotalsWithinRange`/`rawTotalsBefore`
sum every line for that `accountId` up to an as-of date, sign-adjusted
by the account's type (`signFor`, line 283), with no awareness of, or
restriction to, which document originated any given line. This is
already how every GL balance in this codebase is computed — it makes no
distinction between a line that came from `bank_transactions`,
`supplier_payments`, `customer_receipts`, or a manual Journal Entry. It
is the correct, existing, single balance engine for a Bank/Cash
Account's GL account, and this proposal reuses it verbatim rather than
inventing a second one (§17).

### 2.10 What already exists for statements/reconciliation/import — repo-wide search

Searched `services/sphere-finance/src`, `services/sphere-finance/drizzle`,
`docs` for: bank statement, statement import, statement line, bank
reconciliation, matched/unmatched/match, import, CSV, OFX, QIF, MT940,
CAMT, BAI, bank feed, transaction matching, external transaction/
reference, idempotency, duplicate detection, file hash, import batch,
background job, multipart, file upload, S3/blob storage.

Meaningful hits, every one of them **AP/AR subledger-vs-GL
reconciliation, not bank reconciliation** (see §3 for the precise
distinction) or the customer/supplier account **statement** (a running
invoice/payment ledger, not a bank statement):

- `ap-reports.service.ts:39-50` — `StatementLine` interface: `type:
"BILL" | "PAYMENT" | "DEBIT_NOTE"`. This is a **Supplier Statement**
  (running balance of a supplier's activity), unrelated to a bank
  statement.
- `ar-reports.service.ts:39-50` — the symmetric `StatementLine` for
  Customer Statements.
- `ap-reports.service.ts:581-626` / `ar-reports.service.ts:624-663` —
  `getApReconciliation`/`getArReconciliation` (§3).
- `route-role-matrix.spec.ts:386` — `GET ap/reconciliation` route.
- `app.module.ts:56` — Banking-1b's own doc comment already flags
  "Banking-1c/statement import/reconciliation are not implemented here."

Zero hits, anywhere, for: bank statement, statement import/line
(bank-side), bank reconciliation, matched/unmatched (bank-side),
external transaction ID, CSV/OFX/QIF/MT940/CAMT/BAI parsing, file
upload/multipart handling, background job/queue, duplicate-import
detection, file hash. **Banking-1c is genuinely new territory — nothing
to mechanically extend.**

### 2.11 Import/ingestion infrastructure — platform-wide

Checked outside `sphere-finance` too. `packages/event-bus-client`
exists (in-memory + Azure Service Bus adapters — `package.json`
description references "System Architecture v1 §5, §6") but
`grep -rln "event-bus-client" services/*/src` returns **nothing** —
no service, including `sphere-finance`, imports it today. No queue/
worker/cron infrastructure exists anywhere (`grep -rniE "bullmq|queue|
background job"` across `services`/`packages` returns only doc
comments in `event-bus-client` itself, describing dead-letter-queue
semantics for the _unused_ bus). No blob/object-storage package is
installed anywhere (`s3`, `azure blob`, `file storage` — zero hits).
`sphere-finance/package.json` depends on `@nestjs/platform-express`
(bundles Express; supports `FileInterceptor`-style multipart handling)
but declares no `multer`/`@types/multer`, and no upload endpoint exists
in the codebase today. **Conclusion: there is no existing generic
import/ingestion framework to plug into, in this service or platform-
wide. Banking-1c must introduce its own minimal, synchronous, in-
service import path (§5) — it must NOT invent a platform-wide async
import/job framework, since no repository evidence supports one.**

### 2.12 `docs/roadmap.md` alignment

`docs/roadmap.md:80` lists "Banking / Reconciliation (PLANNED)";
line 167 lists "[ ] Bank reconciliation, [ ] UPI/card/bank payment
reconciliation where applicable" as unchecked (unimplemented) roadmap
items; line 185 explicitly reserves "AI-assisted reconciliation" as
future, unimplemented scope. Banking-1c as scoped here is squarely the
next roadmap item, and deliberately does not reach into the AI-assisted
or UPI/card-integration items also listed there.

---

## 3. Existing AP/AR Reconciliation — Explicitly Not The Same Concept

`ApReportsService.getApReconciliation` (`ap-reports.service.ts:581-626`)
computes exactly two numbers and compares them:

1. **AP sub-ledger total outstanding** — `totalBilledMinor -
totalPaidMinor`, derived entirely from `supplier_bills`/
   `supplier_payments` (lines 596-600).
2. **GL AP control account balance** — the balance of the single GL
   account configured in `ap_settings.apControlAccountId`, computed
   from `journal_lines` (line 602-608, `glLiabilityBalance`).

`differenceMinor = subLedgerTotalOutstandingMinor -
glApControlAccountBalanceMinor`; `reconciled: differenceMinor === 0`
(line 620). `ArReportsService.getArReconciliation`
(`ar-reports.service.ts:624-663`) is the exact symmetric computation for
AR against the AR control account.

**Neither endpoint involves**: a bank statement, an external bank
transaction, an imported statement line, matching of any kind, or a
Bank/Cash Account. Both are a pure **SUBLEDGER BALANCE ↔ GL CONTROL
ACCOUNT BALANCE** comparison — two numbers computed from data NoryX
already has, compared for equality. This is internal-consistency
checking (did every posted bill/payment/invoice/receipt correctly land
in the control account), not bank reconciliation (does NoryX's record
of a bank account match what the bank itself says happened).

Banking-1c's reconciliation equation (§17) is structurally different: it
compares an **externally-sourced** number (the statement's declared
balance) against NoryX's own book balance, and — unlike AP/AR
reconciliation, which is read-only and can never itself be "wrong" in a
way a user fixes through the report — Banking-1c's reconciliation
process is expected to _change state_ (statement lines get matched,
possibly new bank transactions get drafted) as a result of running it.

---

## 4. Bank Transaction ↔ Bank Statement Matching — Available Dimensions

**Internal side** (§2.7/§2.8): account, date (accounting date, not
necessarily value date), amount, direction (derived from `type`),
currency (trivial), free-text reference/memo. **Missing on the internal
side for matching purposes**: nothing needs to be added to
`bank_transactions` — the fields above are sufficient once the
_external_ side normalizes date/amount/direction consistently (§6).

**External side** — does not exist yet; this proposal defines it as
`bank_statement_lines` (§6): bank account (which import/account it
belongs to), the bank's own transaction date, an optional value date
(when the format provides one), a normalized `direction` (DEBIT/CREDIT,
explicit rather than a signed amount — mirroring Banking-1b's own
`type`-driven-polarity convention rather than introducing a new signed-
amount idiom), amount, currency, an optional external/bank reference,
and the bank's raw description text (kept verbatim, never parsed for
meaning — no NLP/similarity infra exists in this repo, §8).

**The AP/AR bypass (§2.9) directly limits what "available" means — for
matching, not for balance**: the external side's lines will include
activity that has no `bank_transactions` counterpart at all, so this
proposal's recommended **matching candidate universe** (§8, Decision 13)
explicitly does not attempt to pair a statement line against that
activity individually in MVP. This has no bearing on **book balance**
(§17), which is always the account's true GL balance and therefore
already includes that activity's effect — matching completeness and
balance correctness are deliberately independent properties (§9).

---

## 5. Import Architecture

No existing import/ingestion framework exists anywhere in the repository
or platform (§2.11) — confirmed, not assumed. Banking-1c must build its
own minimal path:

- A single `multipart/form-data` upload endpoint
  (`POST /bank-statement-imports`), synchronous within the HTTP request
  — no queue/job exists to defer work to, and none should be invented
  for MVP given zero evidence any service in this platform currently
  relies on `event-bus-client` for anything (§2.11).
- An explicit file-size / row-count cap enforced at the controller (e.g.
  a few MB / tens of thousands of lines) to keep synchronous processing
  bounded — background/async import is out of scope (§20) until real
  usage shows synchronous processing is insufficient.
- `@types/multer` needs to be added as a dev dependency (not currently
  declared, `sphere-finance/package.json`) — a one-line, low-risk
  addition, noted here for implementation-readiness, not proposed as an
  architectural decision.
- No blob/object storage exists (§2.11) — this proposal recommends
  **not** persisting the raw uploaded file at all. Parse it, persist the
  structured `bank_statement_lines` rows plus a `fileHash` for
  idempotency (§12), discard the raw bytes. Revisit only if a future
  requirement (e.g. regulatory retention of source documents) surfaces
  evidence this is insufficient — no such evidence exists today.

---

## 6. Domain Model & Schema Proposal

Three new tables. **Zero changes to any existing table** — `schema.ts`
today has no columns reserved or hinted for this (§2.1/§2.2 confirm the
existing tables are complete as designed for Banking-1a/1b's own scope).

```ts
// Illustrative — NOT implemented. Mirrors this schema.ts file's existing
// conventions (real FKs within Finance's own tables, no cross-service FK
// to tenants/legal_entities, tenant_id-only RLS, explicit legalEntityId
// service-layer predicate).

export const bankStatementSourceFormatEnum = pgEnum(
  "bank_statement_source_format",
  ["CSV_GENERIC"], // OFX/CAMT053/MT940/QIF/BAI2 — future adapters, §7/§18
);

export const bankStatementImportStatusEnum = pgEnum(
  "bank_statement_import_status",
  ["PENDING", "VALIDATED", "FAILED"],
);
// Import/parsing lifecycle ONLY — did the file read and validate
// cleanly. PENDING = uploaded, not yet parsed; VALIDATED = parsed
// successfully, its lines exist; FAILED = parsing/validation error, no
// lines were created. Deliberately does NOT include a COMPLETED value —
// "completed" is a RECONCILIATION concept (reconciliationStatus below),
// a genuinely separate axis. Reusing the same word for two different
// lifecycles on the same row was the exact ambiguity flagged in CTO
// review and corrected here: import parsing and reconciliation
// completion are independent state machines that happen to live on the
// same header row, not one combined enum. A VALIDATED import can sit
// with reconciliationStatus = OPEN indefinitely before a user completes
// its reconciliation.

export const bankReconciliationStatusEnum = pgEnum(
  "bank_reconciliation_status",
  ["OPEN", "COMPLETED"],
);
// The ONLY place "COMPLETED" is used in this schema. See §9 for the
// precise, two-part definition of what must be true for reconciliation
// completion (matching completeness AND balance equality) — never
// driven by import parse status.

export const bankStatementImports = pgTable(
  "bank_statement_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    bankCashAccountId: uuid("bank_cash_account_id")
      .notNull()
      .references(() => bankCashAccounts.id),
    sourceFormat: bankStatementSourceFormatEnum("source_format").notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(), // sha256 hex
    statementDateFrom: date("statement_date_from").notNull(),
    statementDateTo: date("statement_date_to").notNull(),
    // Both nullable at import/parse time — CSV_GENERIC has no balance
    // fields, so a valid import may carry neither. openingBalanceMinor MAY
    // remain permanently null (best-effort validation only, see §5 note
    // below). closingBalanceMinor MAY be supplied/edited by the user after
    // import (a plain, DRAFT-lifecycle-style field edit, not a parse
    // concern) — but §5/§9/§15 all enforce, at the SERVICE layer (not a DB
    // NOT NULL constraint, since it is legitimately null between import
    // and user confirmation), that reconciliation completion is rejected
    // whenever closingBalanceMinor IS NULL. This column is never treated
    // as optional for the purposes of completing a reconciliation — only
    // for the purposes of accepting an import.
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" }),
    closingBalanceMinor: bigint("closing_balance_minor", { mode: "number" }),
    status: bankStatementImportStatusEnum("status")
      .notNull()
      .default("PENDING"),
    reconciliationStatus: bankReconciliationStatusEnum("reconciliation_status")
      .notNull()
      .default("OPEN"),
    importedBy: uuid("imported_by"),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedBy: uuid("completed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bank_statement_imports_account_file_hash_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.bankCashAccountId,
      t.fileHash,
    ), // §12
    index("bank_statement_imports_tenant_entity_idx").on(
      t.tenantId,
      t.legalEntityId,
    ),
  ],
);

export const bankStatementLineDirectionEnum = pgEnum(
  "bank_statement_line_direction",
  ["DEBIT", "CREDIT"], // from the bank's own perspective
);
export const bankStatementLineMatchStatusEnum = pgEnum(
  "bank_statement_line_match_status",
  ["UNMATCHED", "PARTIALLY_MATCHED", "MATCHED", "IGNORED"],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(), // denormalized — RLS requirement, same reasoning as journal_lines.tenantId (schema.ts:284-286)
    legalEntityId: uuid("legal_entity_id").notNull(),
    statementImportId: uuid("statement_import_id")
      .notNull()
      .references(() => bankStatementImports.id),
    bankCashAccountId: uuid("bank_cash_account_id") // denormalized from the parent import
      .notNull()
      .references(() => bankCashAccounts.id),
    lineDate: date("line_date").notNull(),
    valueDate: date("value_date"), // nullable — not every format provides one
    direction: bankStatementLineDirectionEnum("direction").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), // always positive
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    externalReference: varchar("external_reference", { length: 100 }),
    rawDescription: text("raw_description"),
    lineFingerprint: varchar("line_fingerprint", { length: 64 }).notNull(), // §12
    matchStatus: bankStatementLineMatchStatusEnum("match_status")
      .notNull()
      .default("UNMATCHED"), // denormalized cache — single source of truth is bank_reconciliation_matches (§9)
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("bank_statement_lines_amount_positive", sql`${t.amountMinor} > 0`),
    index("bank_statement_lines_import_idx").on(t.statementImportId),
    index("bank_statement_lines_account_idx").on(t.bankCashAccountId),
  ],
);

export const bankReconciliationMatchTypeEnum = pgEnum(
  "bank_reconciliation_match_type",
  ["DETERMINISTIC_MATCH", "MANUAL"],
  // Renamed from "AUTO_EXACT" per CTO review — the rule allows a
  // configurable date-tolerance window (§8), so "exact" was technically
  // misleading. "DETERMINISTIC_MATCH" names what is actually true of the
  // tier: reproducible from the same inputs, never a guess. No
  // AUTO_FUZZY value exists — no fuzzy/AI matching in MVP (§8).
);
export const bankReconciliationMatchStatusEnum = pgEnum(
  "bank_reconciliation_match_status",
  ["ACTIVE", "UNDONE"],
);

export const bankReconciliationMatches = pgTable(
  "bank_reconciliation_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .references(() => bankStatementLines.id),
    bankTransactionId: uuid("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id), // deliberately NOT journal_entries/journal_lines — §8/§10
    // Real, meaningful partial-matching support (CTO review — not merely
    // schema-available-but-unused): may be less than either side's own
    // amountMinor, but the SERVICE layer rejects any insert that would
    // push the sum of ACTIVE matches against either the statement line OR
    // the bank transaction above that side's own amountMinor (over-
    // allocation is a hard reject, §8/§9).
    matchedAmountMinor: bigint("matched_amount_minor", {
      mode: "number",
    }).notNull(),
    matchType: bankReconciliationMatchTypeEnum("match_type").notNull(),
    status: bankReconciliationMatchStatusEnum("status")
      .notNull()
      .default("ACTIVE"),
    matchedBy: uuid("matched_by"),
    matchedAt: timestamp("matched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    undoneBy: uuid("undone_by"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "bank_reconciliation_matches_amount_positive",
      sql`${t.matchedAmountMinor} > 0`,
    ),
    index("bank_reconciliation_matches_line_idx").on(t.statementLineId),
    index("bank_reconciliation_matches_bank_txn_idx").on(t.bankTransactionId),
  ],
);
```

Why a junction table (not a FK on either side): it is the only shape
that structurally supports one-to-many, many-to-one, _and_ the TRANSFER
double-leg case cleanly (§8) without special-casing.

**No `bank_transaction_lines`-style child table, no new columns on
`bank_transactions`/`bank_cash_accounts`.** Reconciliation reads
Banking-1b/1a's existing tables; it does not migrate them.

---

## 7. Import Architecture (Formats)

No bank statement format is mentioned anywhere in the repository or
docs today (§2.10) — this is greenfield. Recommendation:

**MVP**: a single, explicitly-documented **generic CSV contract**
(`date, description, reference, debit, credit` — two separate debit/
credit columns rather than a signed-amount column, since that is the
most common real-world bank CSV export shape and avoids a sign-
convention ambiguity). `sourceFormat = CSV_GENERIC`.

**Explicitly future, not MVP**: OFX, QIF, MT940, CAMT.053, BAI2, direct
bank-API/Open Banking feeds, payment-provider settlement exports
(Razorpay/Stripe/etc.). The `sourceFormat` enum is the seam — adding a
format later is a new parser implementation plus one enum value, zero
schema change to any of the three new tables. No evidence in `docs/`
specifies India/GCC-specific requirements for any of these formats, so
none is assumed.

**Statement closing balance requirement (§6, §9, §15)**: CSV_GENERIC has
no balance fields, so `openingBalanceMinor`/`closingBalanceMinor` may
both be null immediately after import — this does **not** block
accepting or validating the import itself (a file with no declared
balances still parses to `VALIDATED` with its lines created normally).
It **does** block _completing_ the reconciliation: `closingBalanceMinor`
must be explicitly supplied or confirmed by the user (a plain field edit
on the import header, available any time the import's
`reconciliationStatus = OPEN`) before `POST
/bank-statement-imports/:id/complete` can succeed (§9/§15). Opening
balance may remain permanently null — it is never required for
completion, only used for the optional cross-check below.

**Best-effort internal-consistency check, non-blocking**: when
`openingBalanceMinor` is present, the parser/service SHOULD validate
`openingBalanceMinor + Σ(credits) − Σ(debits) = closingBalanceMinor` and
surface a warning (not a rejection) if they disagree — this catches a
malformed or partially-truncated CSV early, but a missing
`openingBalanceMinor` must never prevent import, and this check is
entirely independent of, and must not be confused with, the
STATEMENT-vs-GL balance equation that actually gates reconciliation
completion (§9/§17).

---

## 8. Matching Architecture

**A terminology distinction this section depends on throughout (§17,
Decision 13): "matching candidate universe" and "book balance" are not
the same concept.** Book balance (§17) is always the Bank/Cash Account's
true GL balance — every journal line against that account, from whatever
document posted it. The **matching candidate universe** defined here is
narrower: it is only the set of internal records the deterministic
matcher is able to _pair a statement line against, individually_. Making
that universe narrower than "everything in the GL balance" does not make
the GL balance itself narrower — it only means some GL activity will
show as unmatched in the reconciliation UI even though it is already
correctly reflected in the balance (§9).

**Matching candidate universe (MVP, recommended): `bank_transactions`
only**, `status = POSTED`, scoped to the statement's `bankCashAccountId`
(and, for a TRANSFER, its `counterpartyBankCashAccountId` as a second,
independent matching context — see below). This is a deliberate scope
boundary, not an oversight — see §2.9/Decision 13 for why: pairing a
statement line against a Supplier Payment, Customer Receipt, or manual
Journal Entry would require a generic "which document produced this
journal entry" provenance resolver that does not exist anywhere in this
codebase today (§2.9), and building one is explicitly out of scope for
this work item (§20). The **consequence is a matching-completeness gap,
not a balance gap** — book balance is unaffected (§17).

**TRANSFER's double-leg matching**: a single TRANSFER `bank_transaction`
debits `counterpartyBankCashAccountId`'s GL account and credits
`bankCashAccountId`'s GL account (`bank-transactions.service.ts:420-437`).
From each bank's own statement, this appears as **two separate lines**
— a DEBIT on account A's statement, a CREDIT on account B's statement
(or nothing on either, if one side is a CASH-kind account with no real
bank feed). The junction-table design (§6) already supports this: the
_same_ `bankTransactionId` can appear in two `bank_reconciliation_matches`
rows, one per statement/account. No special-casing needed at the schema
level — only the matching-suggestion query needs to consider both of a
TRANSFER's accounts, not just `bankCashAccountId`.

**Matching tiers** (terminology corrected per CTO review — a
±N-day date-tolerance window is not literally an "exact" match, so the
tier and its `matchType` value are both named `DETERMINISTIC_MATCH`,
not `EXACT`):

| Tier                                     | Rule                                                                                                                                                                                                                                                                                                   | Confidence           | Deterministic                               | Auditable                                                   | False-positive risk                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DETERMINISTIC_MATCH` (auto-suggested)   | same account, same amount, matching direction (derived from `type`), `transactionDate` within a configurable tolerance window (default ±3 days) of the line's `lineDate`; a present `externalReference` matching the transaction's own `reference` strengthens (but is never required for) a candidate | High                 | Yes                                         | Yes — every suggestion is reproducible from the same inputs | Low, _except_ when more than one internal candidate ties (e.g. two identical-amount FEE transactions the same week)                                                    |
| Ambiguous `DETERMINISTIC_MATCH`          | more than one candidate satisfies the rule for one line                                                                                                                                                                                                                                                | —                    | Yes (the ambiguity itself is deterministic) | Yes                                                         | N/A — never auto-picks a winner; surfaced for manual disambiguation                                                                                                    |
| `MANUAL`                                 | user explicitly selects one or more statement lines and one or more bank transactions                                                                                                                                                                                                                  | N/A (human judgment) | N/A                                         | Yes — `matchedBy`/`matchedAt` always recorded               | User-controlled                                                                                                                                                        |
| Fuzzy (reference/description similarity) | **not implemented in MVP, no `matchType` value exists for it**                                                                                                                                                                                                                                         | —                    | No                                          | Degraded                                                    | High — no text-similarity infrastructure exists in this repository to build on (§2.10), and it is the single highest false-positive technique of everything considered |

**One-to-many / many-to-one**: supported structurally by the junction
table. **Automatic `DETERMINISTIC_MATCH` suggestions remain strictly
1:1** by construction (the tier only ever proposes a single line against
a single transaction, at full amount) — MANUAL matching is where a user
may select multiple lines against one transaction, or vice versa, e.g. a
bank statement showing three separate card-settlement credits that
NoryX recorded as a single DEPOSIT. **No automatic N:1/1:N suggestion in
MVP** — over-engineering an automatic bundling heuristic without
evidence of the real bundling patterns NoryX's actual banks produce
would be guessing; manual multi-select covers the real need safely.

**Partial matching — explicit, real MVP behavior (CTO review: the prior
draft was internally inconsistent — "supports partial matches" in the
schema note against "MVP only needs full-amount matching" in prose; this
is now resolved in favor of genuine support, since 1:N/N:1
reconciliation is explicitly part of the intended architecture)**:

- `matchedAmountMinor` is load-bearing, not merely schema-available. The
  service computes, for a statement line, `Σ(ACTIVE matches against it)`
  and compares that sum to the line's own `amountMinor`:
  `= 0` → `UNMATCHED`; `0 < sum < amountMinor` → `PARTIALLY_MATCHED`;
  `sum = amountMinor` → `MATCHED`. The identical computation applies on
  the bank-transaction side, derived (not persisted, §9) from the same
  `bank_reconciliation_matches` rows.
- **Over-allocation is a hard reject**: any match creation that would
  push either side's active-match sum above that side's own
  `amountMinor` is rejected by the service before the row is inserted —
  never silently capped, never allowed to create a negative remainder.
- MANUAL matching supports 1:1, 1:N, and N:1, all with real partial
  allocation where the user chooses to split an amount across matches.
  **Automatic `DETERMINISTIC_MATCH` suggestions remain strictly 1:1 at
  full amount** — no automatic partial-allocation heuristic is proposed
  (that would be a guess about how to split an amount, which is exactly
  the kind of ambiguity this tier is designed to never resolve on its
  own).

---

## 9. Reconciliation Semantics

"Reconciled" is used precisely, per the instruction not to use it
loosely — and, per CTO review, **matching completeness and balance
reconciliation are two separate concepts that must never be conflated
into a single check.**

**Statement line status** (computation defined in full in §8): a line is
`MATCHED` when the sum of its `ACTIVE`
`bank_reconciliation_matches.matchedAmountMinor` rows equals its own
`amountMinor`; `PARTIALLY_MATCHED` when that sum is nonzero but less;
`UNMATCHED` when zero; `IGNORED` is a user override for a line the user
has explicitly determined needs no NoryX-side counterpart (see §10) — an
explicit, recorded action, never a default and never inferred.

A **bank transaction** is not tracked with its own `matchStatus`
column — whether it has been claimed, and how fully, is always derivable
by querying `bank_reconciliation_matches` for its id (mirrors
`GeneralLedgerService`'s own "derive, don't persist" convention for
running balances, `general-ledger.service.ts:239` — no denormalized
running/matched state on `bank_transactions` itself, since Banking-1b
owns that table and Banking-1c must not add columns to it, §6).

**Reconciliation is scoped to one `bank_statement_import` at a time** —
not a rolling/continuous session, and not a separate
`bank_reconciliation_sessions` entity. The import header itself carries
`reconciliationStatus` (§6, Decision 9). This is the simplest model that
matches how bank reconciliation is actually performed in practice
(against a specific statement period) and avoids introducing a fourth
new table with no clear evidence it earns its complexity. §12 states the
explicit rule for multiple, possibly overlapping, imports coexisting.

**Reconciliation completion — two independent conditions, BOTH required
(the most important correction in this amendment)**:

**A. MATCHING COMPLETENESS** — every one of the import's statement lines
is either `MATCHED` or `IGNORED` (an explicit user action with a reason,
§10). This says nothing about whether the numbers actually agree — it
only says every line has been looked at and disposed of.

**B. BALANCE RECONCILIATION** — `statementClosingBalanceMinor` (must be
`NOT NULL`, §7/§15) equals the Bank/Cash Account's GL book balance as of
the statement's closing date (§17): `differenceMinor =
statementClosingBalanceMinor - glBookBalanceMinor = 0`. This is computed
from the account's real `journal_lines`, via the same semantics as
`GeneralLedgerService.getBalance` (§2.13/§17) — **never** from summing
`bank_transactions`.

**A reconciliation cannot be considered financially balanced merely
because every statement line happens to match a `bank_transactions`
row** — condition A alone proves nothing about condition B, because the
matching candidate universe (§8) is narrower than the GL balance's true
composition (§2.9/§17). Conversely, condition B alone (the numbers
happening to agree) does not excuse leaving lines unmatched/undisposed —
a user must still account for every line. **`reconciliationStatus` may
only become `COMPLETED` when both A and B hold simultaneously.**
Completing records `completedBy`/`completedAt` as a historical snapshot
of that joint fact (§10 of the CTO review, §15) and locks the import's
lines and matches immutable (§15).

---

## 10. Posting / Adjustment Semantics — Layer Ownership

This is the proposal's core safety boundary, stated explicitly per the
instructions:

- **BANKING LEDGER** (`bank_transactions`, Banking-1b) is the only place
  a Bank Transaction is created or posted. Unchanged by Banking-1c.
- **GL** (`journal_entries`/`journal_lines`) is mutated only through
  `BankTransactionsService.post()` (or the other five existing document
  services' own `post()` methods, entirely outside Banking-1c's
  concern). Banking-1c code never calls `JournalEntriesService`, never
  inserts into `journal_entries`/`journal_lines` directly, and never
  replicates the posting discipline a second time.
- **RECONCILIATION LAYER** (the three new tables) owns matching/linking
  state only. It has zero authority to create a journal entry, and zero
  authority to post a bank transaction on its own.

**What happens when a statement line has no internal counterpart** (a
bank fee, interest, an unidentified debit/credit): the answer is **B**
from the options the discovery instructions posed — allow creation of an
accounting transaction from the unmatched line — but implemented as a
thin convenience, not a new posting path: `POST
/bank-statement-imports/:id/lines/:lineId/create-bank-transaction`
pre-fills `type`/`amountMinor`/`transactionDate`/`bankCashAccountId`
from the line (the user still picks `type` — FEE/INTEREST/DEPOSIT/
WITHDRAWAL are already exactly Banking-1b's own primitives for this) and
calls `BankTransactionsService.create()` verbatim — the result is an
ordinary DRAFT bank transaction requiring the user's own separate,
explicit `POST /bank-transactions/:id/post` call, with the exact same
RBAC, period validation, and audit trail Banking-1b already has. **No
reconciliation adjustment entity is introduced** (option C, rejected) —
inventing a second, parallel posting mechanism would duplicate Banking-
1b's own posting discipline in a second place, which is precisely the
pattern every prior work item in this codebase (Banking-1b included)
has deliberately avoided by never calling `JournalEntriesService` a
second, different way.

**"Unmatched" must never be read as "unmatched = missing accounting
transaction" — this is an explicit, CTO-flagged risk.** Because the
matching candidate universe is `bank_transactions` only (§8), a line can
be `UNMATCHED` in Banking-1c for either of two structurally different
reasons: (1) genuinely no accounting activity exists yet for it (a real
bank fee NoryX never recorded), or (2) the economic event was already
recorded — correctly — as a Supplier Payment, a Customer Receipt, or a
manual Journal Entry (§2.9), and simply has no `bank_transactions` row
for the matcher to pair against. Banking-1c's MVP matching engine cannot
distinguish these two cases (that would require the same generic
provenance resolver §8/Decision 13 explicitly defers). The
create-from-line convenience therefore **remains available** for every
unmatched line (per §6 item 6's option A), but it is never a blind
"unmatched implies missing" shortcut: the service/UI surface **must**
present it as an explicit, informed user decision, carrying a visible
warning to the effect of _"no matching Bank Transaction was found for
this line — if this activity was already recorded as a Supplier
Payment, Customer Receipt, or manual Journal Entry, creating a new Bank
Transaction here would duplicate it. Confirm this line has no existing
accounting record before proceeding."_ No automatic cross-subledger
duplicate detection is built to resolve this in MVP (that is exactly the
generic-provenance problem Decision 13 defers) — the warning is the
complete MVP mitigation, and the user's action remains explicit and
auditable (`matchedBy`/`createdBy` on whatever they create).

---

## 11. Period / As-Of Semantics

Matching and unmatching are pure linking operations — they never touch
`journal_entries`/`journal_lines`/`bank_transactions`, so **a CLOSED
accounting period never blocks matching** a statement line against an
already-POSTED bank transaction whose `transactionDate` falls in a
closed period. This is a deliberate, evidence-grounded distinction from
posting itself: `resolveAndLockOpenPeriod`
(`bank-transactions.service.ts:800-830`) already enforces the OPEN-
period rule at `post()` time, unchanged by Banking-1c. The only place
period status matters within Banking-1c is the "create bank transaction
from unmatched line" convenience (§10) — its subsequent `post()` call
inherits the existing, unmodified 422-on-closed-period behavior for
free. No accounting_periods reopen mechanism exists anywhere in this
codebase (`accounting-periods.service.ts:13` — "create, list, close
only; no reopen"), and Banking-1c introduces none either — a
`COMPLETED` reconciliation, like a `CLOSED` period, is one-way (§15).

---

## 12. Idempotency / Duplicate Imports

No idempotency mechanism exists anywhere in the repository to extend
(§2.10) — this is a new pattern, kept deliberately simple:

- **File-level**: `bank_statement_imports_account_file_hash_unique`
  (§6) on `(tenantId, legalEntityId, bankCashAccountId, sha256(file))`
  — a byte-identical re-upload for the same account is rejected outright
  (409) before parsing. Same "friendly check + DB constraint" pattern
  already used for `bank_cash_accounts_gl_account_unique`
  (`schema.ts:1815-1821`).
- **Line-level**: `lineFingerprint` = a hash of `(bankCashAccountId,
lineDate, direction, amountMinor, externalReference-or-rawDescription)`,
  stored per line, checked at parse time against every existing line for
  the same account across _different_ imports. A match is surfaced as a
  **warning** ("possible duplicate of a line already imported on
  {date}"), never a silent drop or a hard rejection — two genuinely
  distinct transactions can legitimately share every one of those
  fields on the same day (e.g. two identical bank fees), so a hard
  constraint would produce false rejections.

No provider/external-transaction-ID-based dedupe is proposed for MVP,
since CSV_GENERIC (§7) has no such field to rely on — this becomes
available once an OFX/CAMT.053-style format (which typically does carry
a stable bank transaction ID) is added as a future adapter.

**Overlapping statement imports — explicit rule (CTO review)**: multiple
`bank_statement_imports` rows may exist for the same `bankCashAccountId`
with overlapping `statementDateFrom`/`statementDateTo` ranges. This is
allowed, not an error condition:

- Two byte-identical files for the same account are rejected by the
  file-hash unique constraint (above) — this is the only _hard_ dedupe.
- Two _different_ files whose date ranges overlap (e.g. a monthly
  statement re-exported mid-cycle, or two overlapping export windows
  from the same bank) are both accepted; their line-fingerprint overlap
  surfaces as the same non-blocking duplicate-line warning described
  above, never an automatic rejection.
- Multiple imports for the same account may exist concurrently in any
  mix of `PENDING`/`VALIDATED`/`FAILED` import status and
  `OPEN`/`COMPLETED` reconciliation status — there is no constraint
  limiting an account to one "current" import.
- **Completing one import never automatically invalidates, locks, or
  otherwise affects another** — `reconciliationStatus` is a property of
  the individual import row, not of the account.
- **No canonical-period claim is made across imports.** Banking-1c does
  not assert that any one completed import represents the single
  authoritative record for a given date range — each completed
  reconciliation is simply a historical fact about that specific
  import (§10 of the CTO review, §15). If two overlapping imports are
  both completed, both stand as independent historical records; nothing
  in this proposal reconciles imports against each other. This is a
  direct consequence of choosing (§9, Decision 9) "one import = one
  reconciliation unit" over a `bank_reconciliation_sessions`
  entity — no new table is introduced to solve this, since the
  overlap is expected to be rare in practice and, when it occurs, is
  a data-entry/process question for the user, not something the schema
  needs to prevent.

---

## 13. Security / Tenancy / RLS / RBAC

**RLS**: all three new tables get the identical `tenant_isolation`
policy (`ENABLE`+`FORCE ROW LEVEL SECURITY`) as every one of the 12
existing RLS files (`drizzle/rls/001`-`012`) — `tenant_id`-only.
`legalEntityId` isolation stays an explicit service-layer predicate on
every query, the same deliberate, repeatedly-confirmed convention every
other Finance service uses (never RLS-covered) — no reason exists to
deviate here.

**RBAC**: no new role. Roles are free-form strings checked by
`RolesGuard` (`packages/auth-core/src/guards/roles.guard.ts`) against
whatever the JWT carries — there is no central fixed-role registry to
extend, and only three roles (`finance.viewer`/`finance.poster`/
`finance.admin`) are used anywhere in this codebase today
(repo-wide grep). Recommendation: treat a bank statement import as a
**document** (it has a lifecycle: PENDING → VALIDATED/FAILED, and
separately OPEN → COMPLETED for reconciliation) — `finance.poster` for
every mutating action (upload, match, undo, create-bank-transaction-
from-line, complete), `finance.viewer`/`finance.poster`/`finance.admin`
for every read (list imports, list lines, list matches, reconciliation
summary). This exactly mirrors Banking-1b's own document-shape RBAC
split (`route-role-matrix.spec.ts:592-613`), not Banking-1a's master-
data admin-only-write shape — a bank statement import is not master
data.

---

## 14. Auditability

Extending the existing `entityType` convention (15 distinct strings
already in use across the codebase — `accounting_period`, `ap_settings`,
`ar_settings`, `bank_cash_account`, `bank_transaction`,
`chart_of_accounts`, `customer`, `customer_credit_note`,
`customer_invoice`, `customer_receipt`, `journal_entry`, `supplier`,
`supplier_bill`, `supplier_debit_note`, `supplier_payment`):

- `bank_statement_import` — CREATE at upload, UPDATE at each import
  status transition (`PENDING` → `VALIDATED`/`FAILED`) and, separately,
  at each reconciliation status transition (`OPEN` → `COMPLETED`) —
  these are two distinct fields on the same row with two distinct
  lifecycles (§9/§20), both audited on this one `entityType`.
- `bank_reconciliation_match` — CREATE on match, UPDATE on undo (status
  ACTIVE -> UNDONE — an UPDATE, not a DELETE, so the audit trail and the
  row itself both preserve the fact a match once existed).

**Deliberately no per-line audit row** for `bank_statement_lines` — a
single import can carry thousands of lines, and one audit row per line
would be a genuine audit-log volume problem with no precedent elsewhere
in this codebase (every existing document's audit trail is 1-3 rows per
document, not O(n) in a child collection). Recommendation: one CREATE
audit row on the _import_ summarizing line count and any parse
warnings/duplicates (the `bank_statement_import` CREATE row's
`afterState` carries this), not one row per line.

---

## 15. Immutability

- `bank_reconciliation_matches`: **not** zero-exception in the way every
  other posted-document table is. While the parent import's
  `reconciliationStatus = OPEN`, a match may be soft-undone (`status`
  ACTIVE -> UNDONE, an UPDATE) — this is a deliberate, narrow deviation
  from the codebase's dominant zero-exception posture, justified because
  undoing a link is not an accounting mutation (nothing in
  `journal_entries`/`bank_transactions` changes), unlike every table
  that currently has a zero-exception trigger. Once the parent import's
  `reconciliationStatus = COMPLETED`, both `bank_reconciliation_matches`
  and `bank_statement_lines` become genuinely immutable (a new,
  zero-exception trigger on each, matching the codebase's dominant
  convention at that point).
- `bank_statement_imports`: deletable only while `status IN (PENDING,
FAILED)` and `reconciliationStatus = OPEN` with zero `ACTIVE` matches
  — i.e., before anything meaningful has happened, mirroring the
  DRAFT-only-delete convention every document in this codebase already
  follows.
- **Completion is a historical, immutable snapshot, not a live
  computation** (CTO review): `completedBy`/`completedAt` (already on
  `bank_statement_imports`, §6) record precisely that _"at this moment,
  every statement line was `MATCHED` or `IGNORED`, and
  `statementClosingBalanceMinor` equaled the GL book balance"_ (§9's
  two-condition rule). Once recorded, this fact is never recomputed or
  re-validated against later-changing data — it is a fact about a
  specific point in time, exactly like a `CLOSED` accounting period's
  `closedAt`/`closedBy` (`schema.ts:136-137`) or a `POSTED` document's
  `postedAt`/`postedBy`.
- **No reopen**, ever, once `reconciliationStatus = COMPLETED` — the
  same one-way posture `accounting_periods` already establishes
  (§11) and every `DRAFT -> POSTED` document in this schema follows.
  Reopening a completed reconciliation to "fix" a match would let
  reconciliation mutate state retroactively, which is exactly the kind
  of accounting loophole the instructions warn against — the correct
  fix for a mistaken match discovered after completion is a brand-new
  import/reconciliation cycle, not reopening the old one.
- **No accidental path exists, or is proposed, by which reconciliation
  can mutate a POSTED `bank_transactions` row** — `bank_transactions`'
  own zero-exception trigger (`019_bank_transactions_immutability_trigger.sql`)
  already rejects any UPDATE/DELETE once POSTED, and nothing in this
  proposal writes to that table at all except via the unchanged
  `BankTransactionsService.create()` call path (§10).

---

## 16. Reporting / UI Data Requirements

Minimum API surface for a usable reconciliation screen (§19), corrected
per CTO review to explicitly separate **balance difference** from
**unmatched items** — never collapsed into one number:

**Balance block** (§17):

- `statementClosingBalanceMinor` — persisted on the import header,
  `NOT NULL`-required only for completion (§7/§9/§15), null otherwise.
- `glBookBalanceMinor` — **derived at read time**, never persisted,
  computed via the same semantics as `GeneralLedgerService.getBalance`
  (§2.13) against `bankCashAccounts.glAccountId`, as of
  `statementDateTo`.
- `differenceMinor = statementClosingBalanceMinor - glBookBalanceMinor`
  — derived, `null` whenever `statementClosingBalanceMinor` is null
  (never coerced to a misleading 0).

**Matching-completeness block** (§9, computed by counting
`bank_statement_lines` rows for the import, grouped by `matchStatus` —
all derived, nothing new persisted):

- `totalStatementLines`
- `matchedStatementLines`
- `partiallyMatchedStatementLines`
- `unmatchedStatementLines`
- `ignoredStatementLines`
- `unmatchedBankTransactionCount` — any `POSTED` bank transaction in the
  matching candidate universe (§8) with zero `ACTIVE` matches summing to
  its full `amountMinor`; also derived from
  `bank_reconciliation_matches`, never persisted (§9).

**These two blocks are reported separately, always** — a UI showing
`differenceMinor = 0` alongside `unmatchedStatementLines = 3` is a
perfectly valid, expected state (the numbers agree overall, but three
lines still need explicit disposition before completion, §9) and must
never be collapsed into a single "reconciled: true/false" flag the way
AP/AR reconciliation's simpler read-only report does
(`ap-reports.service.ts:610-620`) — Banking-1c's own completion gate
(§9) is the only place the two blocks are combined into a single
allow/reject decision, and even there both conditions are evaluated and
reportable independently.

- Suggested `DETERMINISTIC_MATCH`-tier matches — **computed at read
  time, never persisted until a user confirms them** (avoids a
  stale-suggestion cache-invalidation problem entirely; this is a
  genuinely new recommendation this proposal introduces, not mirrored
  from any existing pattern, because no comparable "suggest, don't
  persist until confirmed" flow exists elsewhere in this codebase to
  copy — the closest existing analogue, ambiguous
  `DETERMINISTIC_MATCH` candidates, is handled the same way).
- Reconciliation status (`OPEN`/`COMPLETED`, persisted on the import
  header — this one genuinely needs to persist, since "was this
  reconciliation ever completed" is a historical fact, not re-derivable
  from other data once matches could later be added/removed for other
  reasons, §15).

---

## 17. Bank Balance Semantics — The Reconciliation Equation

**BLOCKER correction from CTO review, now the authoritative definition
of this proposal.** The previous draft defined BOOK BALANCE as a sum of
`bank_transactions` movements. **That is not an account balance — it is
only the net movement Banking-1b happens to represent.** An account's
authoritative book balance can only be the actual General Ledger balance
of the GL account `bank_cash_accounts.glAccountId` links to, computed
the same way every other account balance in this codebase already is
(§2.13). This section replaces the prior equation entirely.

**Do not assume `statement balance = GL balance`** — that remains true,
but the reason a difference can exist is _outstanding items_ (below),
not a structural gap in how BOOK BALANCE itself is computed. The
corrected relationship:

```
STATEMENT CLOSING BALANCE (declared by the bank, on
  bank_statement_imports.closingBalanceMinor — REQUIRED for
  completion, §7/§9/§15)

GL BOOK BALANCE (authoritative — §2.13)
  = GeneralLedgerService.getBalance-equivalent balance of
    bank_cash_accounts.glAccountId, as of statementDateTo
  = the sum of EVERY journal_lines row against that GL account,
    sign-adjusted by account type — regardless of which document
    (bank_transactions, supplier_payments, customer_receipts, a
    manual Journal Entry, or any other future poster) created it.

DIFFERENCE = STATEMENT CLOSING BALANCE - GL BOOK BALANCE
```

**GL BOOK BALANCE already includes AP/AR/manual-journal activity
automatically** — it is not added as a correction term the way the
prior draft implied; it was always part of the true GL balance, because
that activity has always been posted into `journal_lines` against this
same account (§2.9). There is no separate "BOOK BALANCE" concept
narrower than the GL balance in this corrected model.

**Worked example, as raised in CTO review**: if the GL balance of a
Bank/Cash Account's linked account is ₹1,000,000, and the
`bank_transactions` recorded against that account only represent
₹950,000 of net movement, the remaining ₹50,000 may be entirely
legitimate — Supplier Payments, Customer Receipts, or manual Journal
Entries that also touched this GL account (§2.9). **The reconciliation
engine must still regard ₹1,000,000, not ₹950,000, as the book balance**
for the purposes of `DIFFERENCE`. The ₹50,000 is not a discrepancy to
explain away in the balance equation — it simply means some of the
activity making up that ₹1,000,000 cannot be individually _matched_ by
Banking-1c's MVP matcher (§8), which is a **matching-completeness**
observation, not a **balance** one (§9).

**Matching candidate universe vs. book balance — restated once more,
explicitly, because conflating them was the core error corrected in
this amendment**:

1. **BOOK BALANCE** = the actual GL balance (above) — always complete,
   always authoritative, always computed the same way every other
   account balance in this codebase is.
2. **MATCHING CANDIDATE UNIVERSE** (§8) = `bank_transactions` only, for
   MVP — a narrower set used only to decide what the deterministic
   matcher can pair a statement line against.
   These are not the same thing, and Banking-1c never treats them as
   interchangeable in any computation (§9, Decision 13).

**Outstanding items**: even with BOOK BALANCE corrected to the true GL
balance, `DIFFERENCE` can still be nonzero for the ordinary reason bank
reconciliation exists at all — timing. A bank transaction NoryX has
already posted may not yet have cleared the bank (present in the GL,
absent from the statement), or a statement line may not yet have a
NoryX-side counterpart recorded at all (present on the statement, not
yet in the GL). Both are legitimate, expected sources of a nonzero
`DIFFERENCE` until resolved, and both are why reconciliation completion
(§9) requires `DIFFERENCE = 0` at completion time, not merely "close
enough" or "explained by known gaps."

---

## 18. POS / UPI / Card Future Seam

`bank_cash_accounts`' own `kind` doc comment (`schema.ts:1764-1770`)
already anticipates this explicitly: _"a payment-provider settlement
account being modeled as a BANK-kind row later, with no schema
change."_ `docs/roadmap.md:167` lists "UPI/card/bank payment
reconciliation where applicable" as a planned, unimplemented roadmap
item; line 185 reserves AI-assisted reconciliation as future scope.

Banking-1c's schema (§6) already accommodates this seam without any
change: a future payment-provider settlement feed (Razorpay/Stripe/UPI
switch/etc.) is just another `sourceFormat` value on
`bank_statement_imports` (e.g. `RAZORPAY_SETTLEMENT`) feeding the exact
same `bank_statement_lines`/`bank_reconciliation_matches` pipeline,
against a `bank_cash_accounts` row of `kind = BANK` representing the
settlement account. **Nothing in this proposal implements any such
integration** — it only confirms the schema does not need to change
later to add one.

---

## 19. CTO Decisions

### 1. Statement import format for MVP

- **Options**: (a) generic CSV only; (b) CSV + OFX; (c) wait for a real
  bank sample before committing to any format.
- **Recommendation**: (a). No format evidence exists in this repo
  (§2.10/§7); a single well-documented CSV contract is the smallest
  MVP that proves the architecture, with `sourceFormat` as a
  zero-schema-change seam for more later.
- **Consequence**: real bank CSV exports vary in column order/naming;
  MVP requires users to conform to (or transform into) the documented
  contract, or a mapping step is deferred to a later iteration.

### 2. Statement / statement-line schema

- **Options**: (a) three tables as proposed (§6); (b) fold lines into
  the import header as a JSON array; (c) a single flat table with no
  import header.
- **Recommendation**: (a). JSON-array storage (b) forfeits per-line
  querying/RLS/indexing and per-line match state; a flat table (c)
  loses the natural "one file, one status, one balance-pair" grouping
  every reconciliation screen needs.
- **Consequence**: standard relational schema, consistent with every
  other table in this codebase.

### 3. Matching model

- **Options**: (a) junction table (`bank_reconciliation_matches`, §6);
  (b) a nullable `matchedBankTransactionId` FK directly on
  `bank_statement_lines`.
- **Recommendation**: (a). (b) cannot represent one-to-many/many-to-one
  or the TRANSFER double-leg case (§8) at all.
- **Consequence**: one extra table and join, in exchange for correctness
  on cases that will occur in real usage.

### 4. Automatic vs. manual matching

- **Options**: (a) `DETERMINISTIC_MATCH`-tier automatic suggestion +
  manual confirm, `MANUAL` for everything else (as proposed, §8); (b)
  fully manual only; (c) auto-confirm deterministic matches without
  user review.
- **Recommendation**: (a). (b) forfeits the clear, low-risk win
  deterministic matching provides; (c) removes the human-confirmation
  step that keeps every other write in this codebase deliberate and
  auditable.
- **Consequence**: (a) requires a confirm-match UI action even for
  "obvious" matches — accepted as the safer default.

### 5. One-to-many / many-to-one support

- **Options**: (a) manual-only (as proposed, §8); (b) also automate
  N:1/1:N suggestion.
- **Recommendation**: (a). No repository evidence of real bundling
  patterns exists to design an automated heuristic against; guessing
  now risks a wrong heuristic that is hard to un-teach users later.
- **Consequence**: bundled transactions require a manual multi-select
  action.

### 6. Unmatched transaction handling

- **Options**: (a) create-a-bank-transaction convenience calling the
  existing `BankTransactionsService.create()`/`post()` (as proposed,
  §10); (b) a dedicated reconciliation-adjustment entity that posts its
  own journal entries; (c) match-only, no creation capability at all.
- **Recommendation**: (a). (b) duplicates Banking-1b's posting
  discipline in a second place — a pattern this codebase has
  deliberately avoided everywhere else. (c) leaves every bank fee/
  interest line permanently unmatchable, defeating the point of
  reconciliation.
- **Consequence**: none beyond what Banking-1b already enforces — the
  created transaction is an ordinary DRAFT requiring its own explicit
  POST.

### 7. Reconciliation adjustment ownership

- **Options**: (a) Banking Ledger only ever mutates GL, reconciliation
  never does (as proposed, §10); (b) allow reconciliation to post
  directly for speed.
- **Recommendation**: (a), for the reasons in §10 and Decision 6.
- **Consequence**: an extra click (create, then separately post) for
  every unmatched-line-originated transaction — accepted as the correct
  tradeoff for keeping one single, well-tested posting path.

### 8. Duplicate/idempotency strategy

- **Options**: (a) file-hash unique constraint + line-fingerprint
  warning (as proposed, §12); (b) file-hash only; (c) a stricter
  line-level hard-reject.
- **Recommendation**: (a). (b) alone misses overlapping-date-range
  re-imports of a _different_ file covering the same period; (c) risks
  false rejections of legitimately identical same-day transactions.
- **Consequence**: users occasionally see (and must dismiss) a
  "possible duplicate" warning that is a false positive.

### 9. Reconciliation lifecycle/status

- **Options**: (a) reconciliation status lives on the import header,
  one import = one reconciliation unit (as proposed, §9); (b) a
  separate `bank_reconciliation_sessions` table spanning multiple
  imports/date ranges.
- **Recommendation**: (a). No evidence supports a need to reconcile
  across multiple statement files as one unit for MVP; (b) is a fourth
  new table with no clear present justification.
- **Consequence**: a reconciliation is always tied to exactly one
  uploaded statement — the standard real-world unit of bank
  reconciliation anyway.

### 10. Period/closed-period behavior

- **Options**: (a) matching/unmatching is period-independent (as
  proposed, §11), only create+post inherits existing period rules;
  (b) block matching entirely against closed-period transactions.
- **Recommendation**: (a). Matching mutates nothing accounting-relevant,
  so there is no reason to block it; (b) would make old, already-
  reconciled periods permanently unreconcilable if a late statement
  correction arrives.
- **Consequence**: none beyond the existing, unchanged 422-on-closed-
  period behavior at `post()` time.

### 11. Whether reconciliation completion is persisted

- **Options**: (a) yes, `reconciliationStatus` on the import header (as
  proposed); (b) derive "complete" on every read from whether all lines
  are matched/ignored and `differenceMinor = 0`.
- **Recommendation**: (a). "Was this reconciliation ever formally
  completed/signed-off" is a genuine historical fact (who, when) that
  cannot be re-derived once other data changes later — e.g. if a bank
  transaction referenced by a completed reconciliation is later
  discovered to need correction via a brand-new bank transaction, the
  live "all matched" computation could flip even though the
  reconciliation was legitimately completed at the time.
- **Consequence**: one more piece of persisted state, consistent with
  how every other lifecycle status in this codebase (bill/payment/
  invoice/receipt status, accounting period status) is persisted, not
  derived.

### 12. Future POS/payment-provider extensibility

- **Options**: (a) confirm the `sourceFormat` seam is sufficient, build
  nothing further now (as proposed, §18); (b) design and stub the
  Razorpay/UPI adapter now.
- **Recommendation**: (a). §20 explicitly excludes payment-provider
  integrations from this work item; building even a stub without a real
  target integration risks guessing at a shape that will not fit later.
- **Consequence**: none — this is a confirm-the-seam-exists finding, not
  a build.

### 13. [Evidence-driven, not requested by the discovery prompt — REWRITTEN per CTO amendment] — the AP/AR-bypass, correctly scoped as a matching-completeness limitation, not a balance gap

- **Decision**: whether Banking-1c MVP's _matching candidate universe_
  should be scoped to `bank_transactions` only, or should also consider
  `journal_lines` posted against a Bank/Cash Account's GL account by
  Supplier Payments/Customer Receipts/manual Journal Entries (§2.9).
  **This decision is now explicitly separated from book balance, which
  is not a scoping question at all** (§17) — GL is unconditionally
  authoritative for book balance regardless of which option below is
  chosen.
- **Corrected architecture (per CTO review)**:
  - **GL is authoritative for BOOK BALANCE** (§17/§2.13) — computed from
    every `journal_lines` row against `bank_cash_accounts.glAccountId`,
    the same way every other account balance in this codebase already
    is. This is not scoped to `bank_transactions` and never was meant
    to be; the prior draft's "book balance = bank_transactions sum" was
    the error this amendment corrects.
  - **`bank_transactions` remain the MVP matching candidate
    universe** — the set of internal records the deterministic matcher
    can pair a statement line against, individually (§8).
  - Because BOOK BALANCE is always the true GL balance, **AP/AR/manual-
    journal activity is included in the book balance automatically** —
    it was always part of `journal_lines`, so nothing needs to be added
    to include it. It may still be **unmatchable** by the MVP matching
    engine, because no generic journal-entry provenance resolver exists
    to trace a `journal_lines` row back to whichever of the 6+ document
    tables (§2.9) produced it.
- **The load-bearing distinction**:
  ```
  BALANCE COMPLETENESS = YES  — GL book balance is always complete,
                                 by construction (§17).
  MATCHING COMPLETENESS = LIMITED IN MVP — some GL-balance-affecting
                                 activity cannot be individually paired
                                 with a statement line (§8/§10).
  ```
- **Options for the matching-candidate-universe question** (book balance
  is not in question, per above): (a) `bank_transactions` only, MVP
  scope, matching-completeness limitation stated explicitly (as
  proposed throughout §8/§9/§10); (b) also match against the broader
  `journal_lines` universe, requiring a new generic "resolve which
  document produced this journal entry" capability that does not exist
  today (§2.9).
- **Recommendation**: (a). Option (b) is materially more complex (touches
  AP/AR read paths this work item should not need to modify, requires
  building a provenance-lookup capability from scratch across 6+ tables
  with no existing precedent), and there is no usage evidence yet for
  how large this matching-completeness gap actually is in practice. Ship
  (a), measure the real gap once users reconcile real statements, and
  revisit as a scoped follow-up only if it proves material. **Do not
  attempt to solve generic journal-entry provenance in Banking-1c** — if
  real usage later proves users need to match statement lines directly
  against AP payments, AR receipts, or manual journals, that motivates a
  future, separately-scoped provenance/source-tracking layer; it is not
  built here, and Banking-1c does not modify AP, AR, the Journal Engine,
  or any existing GL posting path to prepare for it.
- **Architectural consequence**: Banking-1c MVP's `DIFFERENCE` (§17) is
  always computed against the complete, correct GL book balance — it is
  never wrong because of this decision. What is limited is how many of
  the statement lines contributing to that correct balance can be
  individually matched — some legitimate, already-posted activity may
  remain visibly `UNMATCHED` in the reconciliation UI even when
  `DIFFERENCE = 0` overall (§9). This must be communicated to users of
  the reconciliation screen (a UI-level disclosure, not a code change) —
  noted here as an implementation requirement for whichever phase builds
  the UI, not something this proposal resolves.

---

## 20. Implementation Boundary

**IN SCOPE** (subject to CTO approval and a subsequent, separate
implementation-authorization turn — nothing here is authorized to be
built yet):

- `bank_statement_imports`, `bank_statement_lines`,
  `bank_reconciliation_matches` tables, RLS, immutability triggers.
- CSV (`CSV_GENERIC`) synchronous import, parse, validate.
- File-hash + line-fingerprint duplicate detection (§12), including the
  explicit overlapping-imports rule (§12).
- `DETERMINISTIC_MATCH`-tier automatic match suggestion (read-time only,
  strictly 1:1, full-amount) + manual confirm; manual matching for
  everything else, including N:1/1:N and real partial allocation with
  over-allocation rejection (§8).
- Undo (while OPEN), complete (locks immutable) — completion gated on
  BOTH matching completeness and balance equality (§9).
- Create-bank-transaction-from-unmatched-line convenience, calling
  existing, unmodified `BankTransactionsService` methods, with the
  explicit possible-AP/AR/manual-journal-duplication warning (§10).
- Reconciliation summary reporting the balance block
  (`statementClosingBalanceMinor`/`glBookBalanceMinor`/`differenceMinor`)
  and the matching-completeness block separately, never collapsed into
  one number (§16). **Book balance is the account's true, complete GL
  balance (§17) — it is `bank_transactions` only the _matching candidate
  universe_ that is MVP-scoped (§8, Decision 13).**
- RBAC reusing `finance.viewer`/`poster`/`admin`; RLS reusing the
  existing `tenant_isolation` pattern.

**OUT OF SCOPE** — excluded explicitly, no repository evidence supports
any of these now:

- Bank API integrations, Open Banking, UPI integration, card gateway
  integration, POS integration, any payment-provider integration
  (§18 — seam confirmed, nothing built).
- OFX/QIF/MT940/CAMT.053/BAI2 parsers (§7 — enum seam only).
- Multi-currency (no FX exists anywhere in this schema today).
- Cash-flow statement.
- Any new GL engine or change to `JournalEntriesService`.
- Any change to Banking-1b's posting semantics, schema, or service code
  (`bank_transactions`/`BankTransactionsService` are read-only
  dependencies of Banking-1c).
- Any change to `bank_cash_accounts`/`BankCashAccountsService`
  (Banking-1a).
- Automated fuzzy/reference/description-similarity matching (§8).
- Automated N:1/1:N match suggestion (§8, Decision 5).
- A separate reconciliation-adjustment posting entity (§10, Decision 6).
- Background/async import jobs or any new queue/worker infrastructure
  (§2.11, §5).
- Raw file/blob storage/retention (§5).
- A reopen mechanism for a completed reconciliation (§15).
- Broadening the **matching candidate universe** beyond
  `bank_transactions` — i.e. a generic journal-entry provenance/source-
  tracking layer that would let statement lines match directly against
  Supplier Payments, Customer Receipts, or manual Journal Entries (§8,
  §17, Decision 13) — explicitly deferred, not silently expanded. (Book
  balance itself is never scoped to `bank_transactions` — see §17 — so
  there is nothing to "broaden" there; this bullet concerns matching
  only.)

---

## 21. Test Strategy, Migration/Backward Compatibility, Risks, Acceptance Criteria, Implementation Sequence

**Test strategy** (mirrors Banking-1a/1b's own discipline exactly, real
Postgres, no mocking of accounting behavior), organized by amendment
area per CTO review:

_Book balance_:

- GL book balance is derived from the linked
  `bankCashAccount.glAccountId`, using the same computation as
  `GeneralLedgerService.getBalance` (§2.13/§17).
- Postings from Supplier Payments, Customer Receipts, and manual Journal
  Entries against that GL account are reflected in the reported book
  balance (seed all three against one Bank/Cash Account's GL account in
  an e2e fixture and assert the reported balance includes them).
- `bank_transactions` are never treated as the authoritative balance —
  an explicit test asserts book balance differs from a naive
  `bank_transactions`-only sum whenever AP/AR/manual-journal activity
  exists against the account, and that the _GL_ figure, not the
  `bank_transactions` figure, is what the reconciliation summary
  reports.

_Reconciliation_:

- `statementClosingBalanceMinor == glBookBalanceMinor` (`differenceMinor
= 0`) is required for completion; a nonzero difference is rejected.
- Unmatched statement lines prevent completion.
- `IGNORED` is reachable only through an explicit user action (never a
  default/inferred state), and an ignored line counts toward matching
  completeness.
- Completion requires BOTH balance equality AND matching completeness —
  dedicated tests for each condition failing independently (balanced but
  incomplete; complete but unbalanced) and for both together succeeding.

_Partial matching_:

- 1:1, 1:N, N:1 manual matches.
- Partial allocation (a match summing to less than either side's
  `amountMinor` produces `PARTIALLY_MATCHED`).
- Exact full allocation produces `MATCHED`.
- Over-allocation (a match that would push either side's active-match
  sum above its own `amountMinor`) is rejected.

_Import_:

- A missing `closingBalanceMinor` prevents completion but does not
  prevent import/validation.
- Duplicate file rejection (file-hash unique constraint, 409).
- Duplicate line warning (non-blocking).
- Overlapping imports for the same account are both accepted, and
  completing one does not affect the other (§12).

_Create-from-line_:

- Creates a DRAFT only.
- Does not create a journal entry at creation time.
- Requires a separate, explicit Banking-1b `POST` to post.
- The explicit warning about possible existing AP/AR/manual GL activity
  is present in the response/flow (§10).

_Post-completion_:

- Match/line mutation (UPDATE/DELETE) is rejected once
  `reconciliationStatus = COMPLETED`, including at the raw-SQL/DB-
  trigger level, bypassing the service layer entirely — the same
  independent-verification discipline `test/bank-transactions.e2e-spec.ts`
  already established for Banking-1b.
- Reopen is rejected (no such endpoint/capability exists at all).

_Also unchanged from the prior draft_: RBAC matrix addition
(`route-role-matrix.spec.ts`, new controller); DTO unit specs;
`DETERMINISTIC_MATCH`-tier suggestion correctness including the
ambiguous-tie case; audit trail; tenant/legal-entity isolation; and
period-independence of matching vs. period-dependence of create+post
(§11).

**Migration/backward compatibility**: purely additive — 3 new tables,
1 new migration, 1 new RLS file (`013_...`), 1-2 new immutability
trigger files (`020_...`, `021_...`). Zero `ALTER` of any existing
table. Banking-1a/1b behavior is completely unchanged; this is
confirmed architecturally (§6/§10/§20), not just asserted.

**Risks**: the matching-completeness gap for AP/AR-bypass activity
(§8/§17, Decision 13 — book balance itself is unaffected and always
correct; only some already-posted activity remains individually
unmatchable in MVP, a UI-communicated limitation, not a financial
correctness one); CSV format fragility across real bank exports
(mitigated by one documented MVP contract + an explicit future-adapter
seam); ambiguous-match user burden (mitigated by always surfacing tied
candidates rather than guessing); synchronous-upload timeout risk on
large statements (mitigated by an enforced size/row cap, with async
import explicitly deferred, §5); audit-log volume (mitigated by
import-level, not per-line, auditing, §14); users leaving
`closingBalanceMinor` unset indefinitely, blocking completion
(mitigated by surfacing it as a required, explicit field on the
completion action itself, §7/§9/§15).

**Future extensibility**: `sourceFormat` seam for additional statement
formats; `bank_cash_accounts.kind = BANK` seam for future payment-
provider settlement accounts (§18); AI-assisted reconciliation
explicitly reserved, unimplemented roadmap scope this proposal's
deterministic matching engine is a sound foundation for, not a
prerequisite blocker.

**Acceptance criteria** (illustrative, for whichever future turn
receives implementation authorization — restated per CTO amendment to
incorporate the corrected book-balance/matching-completeness/lifecycle
semantics; supersedes the prior draft's list in full):

1. Importing a valid CSV file against a specific Bank/Cash Account
   creates exactly one `bank_statement_imports` header row and N
   `bank_statement_lines` rows (or a `FAILED` import status with a
   per-line error list, and zero lines persisted, on a malformed file).
2. Re-uploading a byte-identical file for the same tenant/legal
   entity/account is rejected (409, file-hash unique constraint)
   without creating a duplicate import.
3. Lines that look like duplicates of a previously-imported statement
   but originate from a different file produce a non-blocking warning
   on the new import, never a silent drop of the line.
4. A `bank_statement_lines` row's `matchStatus` can be `UNMATCHED`,
   `PARTIALLY_MATCHED`, `MATCHED`, or `IGNORED`, and the value
   reflects the real state of its active `bank_reconciliation_matches`
   rows.
5. Matching can never allocate more than either side's available
   (unmatched) amount — an attempted match that would push either the
   statement line's or the bank transaction's active-match sum above
   its own `amountMinor` is rejected as over-allocation.
6. Automatic `DETERMINISTIC_MATCH`-tier suggestions are never
   auto-confirmed; every suggestion requires an explicit user
   confirm action before a `bank_reconciliation_matches` row is
   created.
7. When two or more internal candidates satisfy the deterministic
   tier's rule for the same statement line, the ambiguity is surfaced
   to the user rather than a winner being guessed.
8. Manual matching supports 1:1, 1:N, and N:1 line-to-transaction
   pairings; the automatic `DETERMINISTIC_MATCH` tier remains strictly
   1:1, full-amount only.
9. Book balance is computed as the GL balance of the Bank/Cash
   Account's linked `chart_of_accounts` account (`glAccountId`), using
   `GeneralLedgerService.getBalance`'s existing account-balance
   semantics (§2.13/§17) — never a sum of `bank_transactions`
   movements.
10. Supplier Payments, Customer Receipts, and manual Journal Entries
    that post against that same GL account are reflected in the
    reported book balance even though they are not part of the
    `bank_transactions`-only matching candidate universe in MVP
    (§4/§8/§17).
11. Completing a reconciliation requires ALL of: (a)
    `statementClosingBalanceMinor IS NOT NULL`; (b) every
    `bank_statement_lines` row for that import is `MATCHED` or
    `IGNORED`; and (c) `statementClosingBalanceMinor` equals the GL
    book balance (`differenceMinor = 0`). No subset of these three is
    sufficient.
12. A nonzero difference between `statementClosingBalanceMinor` and
    the GL book balance prevents completion, even if every line is
    `MATCHED`/`IGNORED`.
13. A missing (`NULL`) `statementClosingBalanceMinor` prevents
    completion, even if every line is `MATCHED`/`IGNORED` and the
    balance would otherwise reconcile.
14. Creating a bank transaction from an unmatched statement line
    produces an ordinary DRAFT bank transaction only; it is never
    itself POSTED, and no journal entry exists until the user
    separately calls the existing `POST /bank-transactions/:id/post`
    (§10).
15. Completing a reconciliation records `completedBy`/`completedAt` on
    the import.
16. Once `reconciliationStatus = COMPLETED`, raw UPDATE/DELETE against
    the relevant `bank_statement_lines`/`bank_reconciliation_matches`
    rows is rejected at the DB-trigger level, bypassing the app
    entirely — verified independently, the same discipline
    `test/bank-transactions.e2e-spec.ts` already established for
    Banking-1b.
17. All three new tables enforce `tenant_isolation` RLS, verified via
    raw SQL with `app.current_tenant_id` scoping, the same way
    Banking-1a/1b's own e2e suites already verify it.
18. Legal entity isolation remains enforced as an explicit
    service-layer predicate (not RLS), consistent with the existing
    convention (§2, §13).

**Implementation sequence** (for a future, separately-authorized
implementation turn — not authorized by this document): schema +
migration + RLS + immutability triggers → DTOs + DTO unit specs → CSV
parse/validate service → matching-suggestion + confirm/undo service →
create-from-line convenience → complete-reconciliation service →
controller/module/AppModule wiring + route-role-matrix → e2e suite →
full verification sequence (typecheck/lint/build/unit/e2e twice/
independent PostgreSQL verification) → diff review → commit → bundle —
the identical sequence Banking-1a and Banking-1b both already followed.

---

## STOP

This document is a proposal only. Per the discovery-gate instructions:
no schema/migration/RLS/trigger file was created or modified; no source
file under `src/` was created or modified; no test file was created or
modified; `route-role-matrix.spec.ts` was not modified; no existing
service was modified; `docs/roadmap.md` was not modified; nothing was
committed; nothing was pushed. Verified via `git status` immediately
below this document's completion — only this proposal document is
new, and the two pre-existing standing hardening exceptions
(`docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md`,
`docs/hardening/`) remain in their prior, unrelated state.

Returning this proposal for CTO review. **Awaiting explicit approval
before any Banking-1c implementation begins.**
