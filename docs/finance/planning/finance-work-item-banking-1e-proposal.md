# Finance Work Item — Banking-1e: Payment Gateway / Card / UPI Settlement Reconciliation

**Status: IMPLEMENTED — Banking-1e was implemented on `main` in commit `f7fd9ad`.** This is a full rewrite of the prior
Banking-1e proposal, per CTO architecture-gate review: the prior version
was too implementation-centric ("add another CSV parser") and
insufficiently rigorous about settlement accounting semantics. This
revision performs a fresh contradiction audit against the actual
repository and models Payment Activity, Payment Provider Settlement, and
Bank Activity as three explicit, distinct universes, per the CTO's
explicit instruction.

Banking-1a, Banking-1b, Banking-1c, Banking-1d, and Banking-1e are **IMPLEMENTED**
on `main`. This document is retained as the architecture/design record for
Banking-1e; implementation is complete and no approval is pending.

**Amendment (this turn, CTO Architecture Gate follow-up)**: this document
is amended in place, not rewritten. Two sections are corrected: §7
(Clearing Account Semantics — now an explicit `purpose` classification,
superseding the prior "naming/FK-discoverability only" answer) and §17
(POS Future Seam — now names the stable identifier and FK direction for
the future provider-transaction→settlement link). Consequential updates
follow into §12, §25, §29 Rule 7, §30, and §32 — each cross-referenced
below. A pre-existing "5 new tables" miscount in §25 was also found and
corrected during this pass (§25). Every other section is unchanged from
the prior turn's rewrite.

---

## 0. Baseline Verification

Verified independently in this turn, not taken from any prior session's
summary:

```
$ git rev-parse HEAD
f7fd9adbf28709492a05bbc4c895cc63736e4784
$ git rev-parse origin/main
f7fd9adbf28709492a05bbc4c895cc63736e4784
$ git log --oneline -7
f7fd9ad Banking-1e: Payment Provider Settlement Import & Reconciliation
9fd9198 docs(finance): mark Banking-1c proposal as implemented
c6ed76f fix(finance): complete bank account statement GL movements
91a9770 Banking-1d: Cash Position, Bank/Cash Account Statement, Unreconciled Transactions
0914de3 Banking-1c: Bank Statement Import & Reconciliation
6993993 feat(finance): Banking-1b — Bank Transactions
f750406 feat(finance): Banking-1a — Bank/Cash Account Master
```

`HEAD = origin/main`, clean. `c6ed76f` (the Bank/Cash Account Statement
GL-completeness fix from a prior turn's CTO correction) and `9fd9198`
(updating `finance-work-item-banking-1c-proposal.md`'s status language to
reflect that Banking-1c is implemented) are both already on `origin/main`
— neither was produced by this turn, both are read as-is. This proposal
was checked against this exact commit, not an assumption carried forward.

**Implementation status, confirmed by direct inspection of
`services/sphere-finance/src/db/schema.ts` and the corresponding service
files:**

| Item                                                            | Status          | Tables / key files                                                                                  |
| --------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| Banking-1a — Bank/Cash Accounts                                 | Implemented     | `bank_cash_accounts`                                                                                |
| Banking-1b — Bank Transactions                                  | Implemented     | `bank_transactions`, `bank_transaction_number_counters`                                             |
| Banking-1c — Statement Import & Reconciliation                  | Implemented     | `bank_statement_imports`, `bank_statement_lines`, `bank_reconciliation_matches`                     |
| Banking-1d — Bank/Cash Reporting                                | Implemented     | `bank-reports.service.ts` (Cash Position, Statement, Unreconciled Transactions)                     |
| Banking-1e — Payment Gateway/Card/UPI Settlement Reconciliation | **Implemented** | `payment_provider_settlement_imports`, `payment_provider_settlements`, `payment_settlement_matches` |

**A discrepancy noted, not corrected (out of this turn's scope, which is
this document only):** commit `9fd9198`'s message states Banking-1c's
implementation verification as "Unit suite: 464/464 ... Full e2e suite:
708/708 ... Route-role matrix: 108/108." Fresh verification in this
session's own prior turn (after Banking-1d and its GL-completeness
correction) measured 484/484 unit, 720/720 e2e (×2), 106 routes/21
controllers. These are different points in the codebase's history (1c
alone vs. 1c+1d+correction), so the discrepancy is expected and not a
defect — noted here only for the record, since this document must not
silently repeat an unverified number.

---

## 1. Executive Summary

`docs/roadmap.md:167`'s Banking & Cash checklist has exactly one item with
no existing coverage: **"UPI/card/bank payment reconciliation where
applicable."** Banking-1a/1b/1c/1d cover every other item, including
"cash management/receipts/payments" (already satisfied generically by
`bank_cash_accounts.kind = "CASH"`, verified by direct grep showing zero
`kind`-based branching anywhere in `bank-transactions.service.ts` or
`bank-reports.service.ts` — §2.3).

The prior Banking-1e draft reduced this to "teach `bank_statement_imports`
a new CSV format." That is an ingestion detail, not a domain model, and it
fails the CTO's own worked example: a bank statement line is a single
signed amount on a single date — it cannot, by itself, express
**gross − fee ± adjustments = net**, prove that arithmetic is internally
consistent, or carry a provider's own settlement identifier for
idempotency. Folding settlement data into `bank_statement_lines` would
either lose that structure or silently duplicate it inconsistently across
however many lines a format decided to split it into.

This revision instead introduces **Payment Provider Settlement** as its
own first-class domain, modeled the same shape Banking-1c already
established for bank statements (import header → normalized records →
matches), explicitly distinct from — and related to, not merged with —
both the Banking Ledger (`bank_transactions`) and the bank statement
(`bank_statement_lines`). Three genuinely different universes are kept
explicit throughout this document:

1. **PAYMENT ACTIVITY** — the customer/counterparty-facing event (a card
   swipe, a UPI collect). Already handled, today, by AR's Customer
   Receipts / AP's Supplier Payments against a Clearing Account (§4).
   Banking-1e does not touch this layer's code.
2. **PAYMENT PROVIDER SETTLEMENT** — the provider's own batch report:
   gross collected, fee, adjustments, net, a provider settlement
   identifier. **This is Banking-1e's actual new domain** (§8, §17).
3. **BANK ACTIVITY** — the net settlement amount landing in the real bank
   account. Already handled, today, by Banking-1b's TRANSFER/FEE bank
   transactions and Banking-1c's existing statement reconciliation.
   Banking-1e does not modify either.

GL remains exclusively authoritative throughout (§6, §13). Reconciliation
— both Banking-1c's existing kind and this proposal's new kind — remains
strictly observational: matching and linking only, never a second posting
engine (§6, Rule 6 of §29).

---

## 2. Current Architecture Baseline

**2.1 `bank_cash_accounts` (Banking-1a)** — `services/sphere-finance/src/db/schema.ts:1754-1823`.
One row per Bank/Cash Account: `kind` (`"BANK" | "CASH"`,
`schema.ts:1749-1752`), exactly one linked `glAccountId`
(`chart_of_accounts`, ASSET-typed, UNIQUE per account — one GL account
backs at most one Bank/Cash Account), `currencyCode` (the legal entity's
single functional currency, no FX anywhere in this schema). The `kind`
column's own doc comment (`schema.ts:1765-1770`) already anticipates this
exact proposal: _"the proposal's POS/UPI/card future-integration boundary
anticipates a payment-provider settlement account being modeled as a
BANK-kind row later, with no schema change."_

**2.2 `bank_transactions` (Banking-1b)** — `schema.ts:1909-2013`. Five
types (`TRANSFER`, `DEPOSIT`, `WITHDRAWAL`, `FEE`, `INTEREST`). A
DRAFT→POSTED document lifecycle, posting replicated (not delegated
through `JournalEntriesService`) inside `BankTransactionsService.post()`,
same discipline every sub-ledger in this codebase already uses.
`assertOffsetAccountTypeAllowed` requires FEE's `glAccountId` to be
EXPENSE-typed and TRANSFER to reference two distinct `bank_cash_accounts`
rows with no external GL leg. Confirmed by direct grep: zero
`bank_cash_accounts.kind`-based branching anywhere in this file — every
transaction type behaves identically regardless of `kind`.

**2.3 "Cash management/receipts/payments" are already implemented, not a
Banking-1e gap.** `bank-reports.service.ts` (Banking-1d) never branches on
`kind` either — Cash Position, the Bank/Cash Account Statement, and
Unreconciled Transactions already report a `CASH`-kind account exactly
like a `BANK`-kind one. A DEPOSIT/WITHDRAWAL against a `CASH`-kind account
**is** "cash receipts"/"cash payments"; Banking-1a's CRUD + Banking-1d's
reports **is** "cash management." No code is proposed here for these
roadmap sub-items — they are closed by evidence.

**2.4 `bank_statement_imports` / `bank_statement_lines` /
`bank_reconciliation_matches` (Banking-1c)** —
`schema.ts:2039-2262`, `services/sphere-finance/src/bank-reconciliation/bank-reconciliation.service.ts`.
The pattern this proposal reuses:

- **Import status** (`bankStatementImportStatusEnum`: `PENDING` /
  `VALIDATED` / `FAILED`) is parsing-lifecycle-only — deliberately no
  `COMPLETED` value, because reconciliation completion is a _separate_
  concept living on `reconciliationStatus` (`bankReconciliationStatusEnum`:
  `OPEN` / `COMPLETED`), on the same header row. Conflating these two was
  the exact defect corrected in Banking-1c's own amendment (`schema.ts:2043-2050`,
  quoted verbatim) — Part 18's explicit warning not to repeat this refers
  to this history.
- **Reconciliation completion** (`bank-reconciliation.service.ts:927-1001`,
  method `complete()`) requires BOTH, independently: (A) matching
  completeness — every line `MATCHED` or `IGNORED` — and (B) balance
  reconciliation — `closingBalanceMinor` (declared by the bank, NOT NULL)
  equals the account's GL book balance (`differenceMinor = 0`). Neither
  condition alone is sufficient. This exact two-condition shape is reused
  in this proposal (§9, §18).
- **Book balance is always the true GL balance**
  (`bank-reconciliation.service.ts`'s own `glBookBalance`,
  `SUM(debit)-SUM(credit)` over POSTED `journal_lines`/`journal_entries`
  against `bankCashAccounts.glAccountId`) — **never** a sum of
  `bank_transactions` movements. Duplicated locally per this codebase's
  established cross-module-coupling convention (also duplicated in
  `bank-reports.service.ts`, `ar-reports.service.ts`'s `glAssetBalance`,
  `ap-reports.service.ts`'s `glLiabilityBalance`).
- **Matching-candidate universe is `bank_transactions`-only for MVP**
  (Decision 13 of the Banking-1c proposal, verified accurate against the
  implementation in a prior turn's audit) — deliberately narrower than
  book balance, because no generic "which document produced this journal
  entry" provenance resolver exists in this codebase. Partial matching
  (`matchedAmountMinor`, load-bearing, not schema-only), 1:1/1:N/N:1
  manual matching, and `DETERMINISTIC_MATCH`/`MANUAL` match types are all
  real, implemented behavior (`bank_reconciliation_matches`,
  `schema.ts:2206-2262`).
- **File-level idempotency**: `bank_statement_imports_account_file_hash_unique`
  UNIQUE on `(tenantId, legalEntityId, bankCashAccountId, fileHash)` —
  a byte-identical re-upload is rejected before parsing.
- **create-from-line**: `POST
/bank-statement-imports/:id/lines/:lineId/create-bank-transaction`
  pre-fills a DRAFT `bank_transactions` row from an unmatched line; the
  user still issues a separate, explicit `POST
/bank-transactions/:id/post`. No reconciliation adjustment entity
  exists — this remains the only "create accounting from reconciliation"
  path, and it never auto-posts.

**2.5 `bank-reports.service.ts` (Banking-1d)** — Cash Position (per-account
GL book balance, entity-wide), the Bank/Cash Account Statement (a
chronological union of `BANK_TRANSACTION` / `SUPPLIER_PAYMENT` /
`CUSTOMER_RECEIPT` rows, plus — as of `c6ed76f` — a `JOURNAL_ENTRY` row
type surfacing any POSTED journal entry affecting the account's GL balance
that none of the other three sources represents, restoring
`opening + Σ(displayed movements) = closing GL balance` as a real
invariant), and Unreconciled Transactions (leg-scoped remaining amount).
**Every balance this module reports is GL-derived; none is derived from
`bank_transactions` or any sub-ledger table.** This is the exact discipline
Banking-1e's own Clearing Account reporting must preserve (§13) — Part 13
of the CTO's review explicitly asks that Banking-1e not recreate the
GL-completeness defect `c6ed76f` just fixed.

**2.6 AR/AP** — `customer_receipts` / `supplier_payments` each carry a
`bankCashAccountId` column that is a bare `chart_of_accounts` FK (**not**
a `bank_cash_accounts.id` FK — a documented, historical AP-1c/AR-1c gap,
untouched by every Banking sub-item to date, untouched here too).
`paymentMethodEnum` (`schema.ts:682-688`) has values `BANK_TRANSFER`,
`CHEQUE`, `CASH`, `CARD`, `OTHER` — free-text classification labels with
zero downstream behavior (confirmed by grep: no service branches on this
value). No `UPI` value exists. AR/AP's own reconciliation reports
(`getArReconciliation`/`getApReconciliation`,
`ar-reports.service.ts:624`/`ap-reports.service.ts:581`) compare the
AR/AP sub-ledger's outstanding total against the AR/AP **control**
account's GL balance — a different reconciliation concept entirely (AR/AP
control-account reconciliation, not bank reconciliation, not settlement
reconciliation). This document uses "reconciliation" only ever qualified
by which of these it means (§5).

**2.7 General Ledger / Journal Engine** — `journal_entries`/`journal_lines`,
DRAFT→POSTED, zero-exception immutability once POSTED (a DB trigger, not
just application code), enforced identically for every posting sub-ledger.
No sub-ledger calls `JournalEntriesService`; each replicates the identical
posting discipline directly against `journal_entries`/`journal_lines`/its
own number-counter table, inside one transaction. This proposal introduces
no new caller of this discipline in MVP (§6) beyond the existing
`BankTransactionsService.post()` a user may optionally invoke via a new,
bounded convenience (§19).

**2.8 Repository-wide search for payment-provider terms** (Part 7) —
`grep -rniE` for UPI/Razorpay/Cashfree/PayU/PhonePe/Paytm/Stripe/
acquiring/merchant settlement/payout/interchange/MDR/chargeback across
`*.ts`/`*.md`/`*.sql`:

| Category                   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing implementation    | **None.** Zero hits in any `.ts` file under `src/` outside two incidental word matches (`journal-entries.service.ts`: "read before **acquiring** this lock"; `general-ledger.service.ts`: an unrelated "**settlement**"-adjacent word in a comment about SQL grouping) — neither is payment-related.                                                                                                                                                                                                                                                                            |
| Existing architecture seam | `bank_cash_accounts.kind` doc comment (§2.1); `bankStatementSourceFormatEnum`'s comment reserving `OFX/CAMT053/MT940/QIF/BAI2 — future adapters`; `paymentMethodEnum`'s `CARD` value (label only, §2.6).                                                                                                                                                                                                                                                                                                                                                                        |
| Documentation only         | `docs/finance-work-item-banking-cash-management-proposal.md` §15 (the original POS/UPI/Card Future Integration Boundary — the earliest source of this seam); `docs/finance-work-item-banking-1c-proposal.md` §18; `docs/finance-work-item-banking-1d-proposal.md`; `docs/finance-journal-engine-proposal.md:370` ("bank/UPI/card reconciliation" listed among out-of-scope roadmap items); `docs/hardening/finance-functional-rebaseline-proposal.md:101` (same item, explicitly "⚪ Not established by current source material ... Requires new CTO-originated requirements"). |
| Future roadmap reference   | `docs/roadmap.md:167` — the single checklist line this proposal addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| No existing support        | Any actual gateway/PSP API integration, webhook capture, POS transaction capture, chargeback/dispute case management.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 3. Problem Definition

Repository evidence (§2.8) confirms: nothing in this codebase today can
express what a payment gateway/UPI-switch/card-acquirer settlement report
actually contains — gross collected, a fee deducted at source, optional
other adjustments, and a net amount transferred to the bank, identified
by the provider's own settlement/batch reference. `bank_statement_lines`
(one signed amount, one date) cannot hold this without losing structure;
`bank_transactions` (a Banking Ledger document, not an external-data
ingestion point) cannot either. Without a dedicated model, a tenant using
a payment gateway has no way to prove — auditable, structured,
idempotent — that what the provider says it collected, minus what it
kept, equals what actually reached the bank.

---

## 4. Why Settlement Reconciliation Is Different From Bank Reconciliation

Bank reconciliation (Banking-1c) answers: _"does every line on my bank
statement correspond to something NoryX already recorded, and does the
statement's declared closing balance equal my GL balance?"_ Its external
input (a bank statement) and internal candidate universe
(`bank_transactions`) are both single-amount, single-direction records —
matching is fundamentally 1:1-shaped (with 1:N/N:1 as a manual escape
hatch).

Settlement reconciliation answers a structurally different question:
_"does gross − fee ± adjustments actually equal what the provider
transferred, and does that net figure actually equal what the bank
statement shows?"_ This is not one matching relationship — it is an
**arithmetic identity** (gross/fee/adjustment/net, all belonging to one
settlement record) **composed with** a **matching** relationship
(settlement record ↔ bank statement line). Reusing Banking-1c's model
unmodified would require inventing new columns on `bank_statement_lines`
every time a new settlement component needed representing, or splitting
one settlement into ad hoc multiple statement lines with no arithmetic
guarantee tying them together. Both are worse than a small, dedicated
domain (§8, §17) that owns exactly this structure and hands off to
Banking-1c's existing matching machinery at the one point where they
actually relate — the bank statement line (§10).

---

## 5. Domain Boundaries — Terminology

"Reconciliation" is used precisely throughout this document, always
qualified:

- **Bank reconciliation** — Banking-1c's existing concept: bank statement
  line ↔ `bank_transactions`.
- **Settlement reconciliation** (new, this proposal) — provider
  settlement record ↔ bank statement line (§10), plus a balance-level
  check against the Clearing Account's GL balance (§13) — never a
  matching relationship on its own.
- **AR/GL reconciliation** / **AP/GL reconciliation** — the existing,
  unrelated `getArReconciliation`/`getApReconciliation` control-account
  checks (§2.6). Banking-1e does not touch these.
- **Payment/provider activity reconciliation** — matching an individual
  card/UPI transaction to its own settlement line item. **Explicitly not
  built in this proposal's MVP** (§9, §15) — no transaction-level provider
  feed is ingested.

---

## 6. Accounting Model

**Three postings, none of them new, none of them owned by Banking-1e:**

```
1. Collection (PAYMENT ACTIVITY → GL) — owned by AR (or AP, symmetrically
   for outbound card/UPI disbursement), existing, unmodified:
       Dr  Gateway Clearing Account (an ordinary bank_cash_accounts
           glAccountId, chosen by configuration — §7)
           Cr  Revenue / AR Control (existing CustomerReceipt.post())

2. Settlement transfer (BANK ACTIVITY → GL) — owned by Banking-1b,
   existing, unmodified, via a bounded new convenience that only ever
   creates a DRAFT (§19):
       Dr  Bank (real account)
           Cr  Gateway Clearing Account         (TRANSFER, net amount)

3. Fee recognition — owned by Banking-1b, existing, unmodified:
       Dr  Gateway Fee Expense
           Cr  Gateway Clearing Account          (FEE, fee amount)
```

A fully-settled batch nets the Clearing Account to zero: gross in
(posting 1) exactly equals net out (posting 2) plus fee out (posting 3).
This is standard clearing-account accounting, achieved entirely with
primitives that already exist and are already tested — **Banking-1e adds
no new posting logic and creates zero journal entries or bank
transactions on its own.**

**Explicit answers to the CTO's posting-ownership questions (Part 5):**

| Question                                                                   | Answer                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does Banking-1e create the accounting entry?                               | **No.**                                                                                                                                                                                                |
| Does Banking-1c create it?                                                 | **No** — Banking-1c never posts GL either; only `bank_transactions.post()`, called by the user, does.                                                                                                  |
| Does Banking-1b create it?                                                 | **Yes** — via the user's own explicit `POST /bank-transactions/:id/post`, optionally pre-filled (still DRAFT-only) by a new Banking-1e convenience (§19).                                              |
| Does POS eventually create it?                                             | Not in this proposal — a future POS work item would still go through AR/AP's Customer Receipt/Supplier Payment posting exactly as today (§15).                                                         |
| Does the payment-provider integration create it?                           | No payment-provider _integration_ (an outbound API/webhook consumer) exists or is proposed anywhere in this document (§2.8, §14).                                                                      |
| Is settlement reconciliation allowed to post GL?                           | **No.**                                                                                                                                                                                                |
| Is it strictly observational/matching?                                     | **Yes**, exactly like Banking-1c.                                                                                                                                                                      |
| What posting discipline applies if a future item does auto-create entries? | The existing one — DRAFT-then-explicit-`post()`, zero-exception immutability once POSTED, replicated (not delegated) posting logic inside the sub-ledger's own service. No new discipline is proposed. |

**Adjustment-driven postings (a third leg beyond TRANSFER+FEE, e.g. a
withholding-tax receivable or a chargeback reversing revenue) are
deliberately NOT auto-created**, because the correct GL treatment depends
on _what_ the adjustment is, and guessing would be exactly the kind of
invented behavior this review warned against. MVP surfaces
`adjustmentAmountMinor` as data (§9, §17) and leaves its accounting
treatment, if any beyond the net cash effect, to the user's own manual
Journal Entry or bank transaction — unchanged, existing tools.

---

## 7. Clearing Account Semantics

**CTO amendment (this turn) — superseding this section's prior
"naming/FK-discoverability only" resolution.** The CTO gate review
correctly identified that relying on a free-text name convention plus an
FK's mere existence is not a _machine-readable_ semantic — no query,
constraint, or downstream integration can reliably answer "is this
account a Clearing Account?" without first knowing whether any
`payment_provider_settlement_imports` row happens to reference it, and
nothing stops a real bank account from _also_ being named confusingly or
a Clearing Account from never being referenced by an import yet. This
section is rewritten in place, not appended to.

**Can a payment gateway clearing account safely be represented using the
existing `bank_cash_accounts` model? Yes.** `bank_cash_accounts` →
`chart_of_accounts` (`glAccountId`, exactly one, UNIQUE) →
`journal_lines`/`journal_entries` remains the _only_ mechanism this
codebase has for "an account whose balance is GL-derived and can be a
Banking Ledger participant," and a Gateway Clearing Account needs exactly
that: a place for `bank_transactions` (TRANSFER/FEE) to post against, a
place AR/AP can point `bankCashAccountId` at, and GL authority for its
balance. `kind = "BANK"` remains semantically correct for a Clearing
Account (it has a real settlement feed to reconcile against — §8-§10 —
which is `kind`'s own stated BANK/CASH criterion, `schema.ts:1765-1767`).
**What changes is how the account's _purpose_ is recorded — no longer by
convention, but as an explicit column.**

**Investigation performed before proposing this** (per the CTO's
instruction to inspect the schema and its consumers first): `kind` is
consumed in exactly three places in the entire codebase —
`bank-cash-accounts.service.ts` (create/update, straight passthrough, no
branching), `bank-reports.service.ts`'s Cash Position row (`kind:
account.kind`, display metadata, no branching), and DTO validation
(`BANK_CASH_ACCOUNT_KINDS`, enum-membership check only). A full grep
confirms **zero conditional logic anywhere branches on `kind`** — no
service treats a `BANK`-kind and `CASH`-kind account differently. This
means a second, orthogonal classification column can be added with no
risk of interacting with existing behavior, and every full-row `.select()`
call (e.g. `bank-cash-accounts.service.ts`'s list/detail reads, which
select all columns, not a fixed projection) would return the new column
automatically, with zero code change, the moment it exists.

**Resolution — an explicit `purpose` classification, additive to
`bank_cash_accounts`.** This is the least-disruptive schema-bearing
option consistent with Banking-1a's own conventions (an enum column with
a safe default, exactly the shape `kind` itself already is):

```
bank_cash_account_purpose  (new pgEnum)
  "OPERATING"  -- default; a real bank/cash account (HDFC Current
                  Account, a till) usable as ordinary operating cash.
  "CLEARING"   -- a payment-provider settlement clearing/pooling account
                  (Razorpay Clearing, Visa Clearing, UPI Clearing) —
                  funds transiently held by a third party pending
                  settlement, not spendable operating cash.

bank_cash_accounts.purpose  bank_cash_account_purpose NOT NULL
                             DEFAULT 'OPERATING'
```

This is **orthogonal to `kind`**, not a replacement for it: `kind`
answers "BANK or CASH" (does an external settlement feed exist to
reconcile against at all); `purpose` answers "OPERATING or CLEARING"
(is this account's balance genuinely available cash, or a third party's
transient holding). A Clearing Account is `kind = "BANK", purpose =
"CLEARING"` — both axes are needed; neither alone is sufficient, which is
precisely why collapsing this into a single `kind` value (`CLEARING`)
was considered and rejected — it would force a false choice between
"CASH" and "CLEARING" for what is unambiguously a BANK-kind account, and
would lose the ability to add further purposes later (e.g. a future
escrow or tax-remittance purpose) without another enum-value migration.

Answering each of the CTO's five required points directly:

- **How a real bank account differs from a payment-provider clearing
  account**: `purpose = "OPERATING"` vs `purpose = "CLEARING"`, a
  first-class, queryable, constraint-backed column — not a naming
  convention. A real bank account's "external record to reconcile
  against" is a literal bank statement (Banking-1c); a Clearing
  Account's is the provider's settlement report (this proposal, §8-§10)
  — the same underlying `kind = "BANK"` GL mechanism, a different
  external source of truth, now also a different declared purpose.
- **How reports distinguish them**: Banking-1e's own reports (§20 —
  Clearing Account Reconciliation, the settlement↔bank matching view) are
  scoped to one `bankCashAccountId` per call and would validate/require
  `purpose = 'CLEARING'` on that account explicitly, rejecting an
  `OPERATING` account rather than silently running settlement
  reconciliation against it — a direct field check, never an inference
  from an import FK's existence. Banking-1a's existing `GET
/bank-cash-accounts`/`GET /bank-cash-accounts/:id` already return the
  full row (full-row `.select()`, confirmed above) and therefore surface
  `purpose` immediately, with no code change, once the column exists.
  **Banking-1d's Cash Position/Statement do not surface `purpose`** —
  their `CashPositionRow`/statement DTOs are explicit-field projections
  (`kind: account.kind`, `bank-reports.service.ts:201`), so adding
  `purpose` there is a real, if small, code change to a file Rule 2
  (§29) forbids touching in this proposal. This is an honestly-flagged
  residual gap, not a silent one — see the new Open CTO Decision 13
  (§30) and §12's amendment note below, not resolved by this document.
- **How future POS/payment-provider integrations can discover the
  distinction programmatically**: by reading `purpose` off the existing
  `GET /bank-cash-accounts` response (or the row supplied to any
  service-layer call) — a direct field check, not an inference from
  whether any settlement-import row happens to reference the account
  yet (which is false for a brand-new Clearing Account before its first
  import).
- **Why ordinary BANK/CASH semantics must not accidentally classify
  clearing balances as bank cash**: `kind = "BANK"` alone means "has an
  external settlement feed" — it says nothing about whether the balance
  is _available_ operating cash. Without `purpose`, any report or
  future integration that sums `kind = "BANK"` balances as "cash on
  hand" would silently include unsettled provider float, overstating
  real liquidity. `purpose` is the first-class discriminator that
  prevents this conflation; any future consumer must check `purpose`,
  not infer availability from `kind`.
- **Migration/backward-compatibility implications**: purely additive —
  `ALTER TABLE bank_cash_accounts ADD COLUMN purpose ... NOT NULL
DEFAULT 'OPERATING'` is a metadata-only operation for a non-volatile
  default (PostgreSQL 11+; this repository targets PG 16 per prior
  verification), no table rewrite, no lock escalation beyond the brief
  `ACCESS EXCLUSIVE` any `ADD COLUMN` takes. Every existing
  `bank_cash_accounts` row is automatically and correctly classified
  `OPERATING` (accurate — no Clearing Account exists in this system
  today, since Banking-1e doesn't exist yet). No existing unique
  constraint, the `kind` enum's existing two values, or any consumer
  identified above requires a change. `CreateBankCashAccountDto`/
  `UpdateBankCashAccountDto` would need a new optional `purpose` field
  (defaulting server-side to `OPERATING` when omitted) — a small,
  well-understood, Banking-1a-scoped follow-on, itself not implemented
  or authorized by this document.

**Not proposed**: a `clearingProviderCode`/provider-label column on
`bank_cash_accounts` itself. Which provider a `CLEARING`-purpose account
serves remains discoverable through the existing, structural
`payment_provider_settlement_imports.bankCashAccountId` FK (§17) —
`purpose` answers _what kind of account this is_; _which provider_ is
already answered by which import rows reference it, without adding a
second, redundant place to record the same fact. This keeps the
`bank_cash_accounts` change to the single minimal column the "least
disruptive" instruction asked for.

This directly and now machine-readably distinguishes REAL BANK ACCOUNT
from PAYMENT CLEARING ACCOUNT (per the CTO's HDFC/Razorpay/Visa/UPI
example), superseding this proposal's prior "naming convention" answer.

---

## 8. Provider Settlement Model — Normalization, Not a CSV Format

**Answering Part 8 directly: `PAYMENT_GATEWAY_SETTLEMENT_CSV`-style
naming is the prior draft's central mistake — it named an ingestion
format as if it were the domain.** The corrected model separates them:

```
   Settlement Domain (normalized, this proposal's new tables — §17)
        |
        +-- Provider Adapter (a parser, selected by
        |     payment_provider_settlement_imports.providerFormat)
        |     MVP: ONE generic adapter (§14) — no vendor-specific
        |     adapter exists or is built here, because no real
        |     settlement export file from a named provider exists
        |     anywhere in this repository to build a faithful one
        |     against (same reasoning Banking-1c used to reject
        |     fuzzy matching without real evidence).
        |
        +-- normalized payment_provider_settlements records
        |     (gross / fee / adjustment / net / settlementId / date —
        |     identical shape regardless of which adapter produced them)
        |
        +-- Settlement Reconciliation (§10) — operates only on the
              normalized records, never on a source format.
```

A future Razorpay-specific, Cashfree-specific, or UPI-switch-specific
adapter is an **additional parser targeting the same normalized schema**
— an enum value plus a parser function, exactly the shape Banking-1c's
own `sourceFormat` seam already established (`bankStatementSourceFormatEnum`,
`schema.ts:2034-2037`). No adapter is implemented in this proposal beyond
the one generic MVP contract (§14) — this document is the architecture/design
record for the implemented Banking-1e capability; the implementation is
recorded in commit `f7fd9ad`.

---

## 9. Fee / Tax / Adjustment / Chargeback Classification

| Component                                 | MVP / Future / Out of scope                                                                                                              | Reasoning                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gross amount                              | **MVP** (required)                                                                                                                       | The settlement's basis; without it, fee/net cannot be proven consistent.                                                                                                               |
| Gateway fee                               | **MVP** (required, single figure)                                                                                                        | Directly drives the FEE bank transaction (§6); the one component with an unambiguous, single GL treatment (Expense).                                                                   |
| Tax on gateway fee                        | **Future** — folded into `adjustmentAmountMinor` for MVP                                                                                 | Itemizing requires jurisdiction-specific tax treatment this proposal has no evidence to model correctly; folding it avoids losing the cash effect while not guessing its GL treatment. |
| Other fees                                | **Future** — folded into `adjustmentAmountMinor`                                                                                         | Same reasoning.                                                                                                                                                                        |
| Adjustments (general)                     | **MVP**, as one net signed figure, not itemized                                                                                          | Preserves the arithmetic identity (§6) without inventing a taxonomy of adjustment reasons no real settlement file evidence justifies yet.                                              |
| Refunds                                   | **Out of scope** for settlement-record modeling in MVP; a refund's cash effect within a batch is captured inside `adjustmentAmountMinor` | A refund is itself a new PAYMENT ACTIVITY event; full refund lifecycle (linking back to the original sale) is a future, evidence-driven item, not guessed here.                        |
| Chargebacks                               | **Out of scope** in MVP beyond the same net-cash-effect folding                                                                          | A chargeback is a distinct economic event, often long after the original settlement, needing its own case-management lifecycle this proposal does not build.                           |
| Withholding / TDS                         | **Future** — folded into `adjustmentAmountMinor`                                                                                         | Same reasoning as tax on fee — jurisdiction-specific, no evidence to model precisely yet.                                                                                              |
| Net settlement                            | **MVP** (required, arithmetic-validated)                                                                                                 | The figure Banking-1e actually reconciles against the bank statement (§10).                                                                                                            |
| Settlement date                           | **MVP** (required)                                                                                                                       | Drives ordering, period scoping, and the balance-reconciliation window (§13).                                                                                                          |
| Transaction date (per underlying payment) | **Out of scope** in MVP                                                                                                                  | Payment-activity-level granularity (§5, §15) — this proposal ingests settlement _batches_, not individual transactions.                                                                |
| Bank value date                           | Not new — reuses `bank_statement_lines.valueDate`, unmodified                                                                            | Belongs to the bank side (Banking-1c), untouched.                                                                                                                                      |

**For every deferred component, deferral does not compromise
reconciliation correctness**: `adjustmentAmountMinor` is a real, summed,
auditable figure in every case above — nothing is silently dropped. What
is deferred is _itemizing why_ the adjustment exists, which is a
presentation/analysis refinement, not a correctness requirement for
proving gross − fee + adjustment = net (§17's CHECK constraint enforces
that identity regardless of itemization).

---

## 10. Reconciliation Model — What Banking-1e Reconciles in MVP

Per Part 6, MVP explicitly reconciles **B ↔ C** (provider settlement ↔
bank statement), reports (does not _match_) **B ↔ D** (settlement total
vs. Clearing Account GL balance, §13), and explicitly does **not**
reconcile **A** (payment/provider activity — individual transactions) in
MVP:

```
   A. PAYMENT ACTIVITY            — not reconciled by Banking-1e (§5, §15)
              |
              v  (already posts to Clearing Account GL today, §6)
   D. CLEARING ACCOUNT GL BALANCE — reported, not matched (§13)
              ^
              |  (balance-level check, differenceMinor, §13)
   B. PROVIDER SETTLEMENT         <==== MATCHED ====>  C. BANK STATEMENT LINE
      (payment_provider_settlements,                   (Banking-1c's existing
       this proposal, §17)                              bank_statement_lines,
                                                          unmodified)
```

The B↔C match reuses Banking-1c's own matching shape exactly: a junction
table (`payment_settlement_matches`, §17) with `matchedAmountMinor`
(partial-matching-capable), `DETERMINISTIC_MATCH`/`MANUAL` match types,
and 1:1/1:N/N:1 support (a settlement's net amount may span multiple bank
lines if a provider batches differently than the bank credits; multiple
settlements may correspond to one aggregate bank credit — both cases
Banking-1c's own proposal already names for the analogous card-settlement
scenario). **No new matching algorithm is proposed — the existing engine
is reused unmodified, applied to a new pair of tables.**

---

## 11. Banking-1c Integration — Ownership Boundary

| Owns                       | Banking-1c (unmodified)                                                                                          | Banking-1e (new)                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External-data ingestion    | Bank statement file → `bank_statement_lines`                                                                     | Provider settlement file → `payment_provider_settlements`                                                                                                                                                                                       |
| Matching engine            | `bank_statement_lines` ↔ `bank_transactions`                                                                     | `payment_provider_settlements` ↔ `bank_statement_lines` (reuses Banking-1c's own lines as its "bank side" — §10)                                                                                                                                |
| Book balance               | Bank/Cash Account GL balance (`glBookBalance`, duplicated locally)                                               | Not recomputed — the Clearing Account IS a `bank_cash_accounts` row, so it already has one; Banking-1e's own reconciliation report duplicates the identical query (§13), never calls into Banking-1c's file.                                    |
| Reconciliation completion  | `bank_statement_imports.reconciliationStatus` (OPEN/COMPLETED), matching completeness + balance equality         | `payment_provider_settlement_imports.reconciliationStatus` (OPEN/COMPLETED), identical two-condition shape (§18) — a **separate** header row, **separate** lifecycle; never conflated with Banking-1c's own.                                    |
| create-from-unmatched-line | `POST .../lines/:lineId/create-bank-transaction` (creates one DRAFT bank transaction from a bank statement line) | A new, analogous `POST .../create-settlement-transactions` (creates TWO DRAFT bank transactions — TRANSFER + FEE — from a settlement record, §19). Distinct endpoint, distinct source table; does not modify Banking-1c's existing convenience. |

**Zero changes to any Banking-1c file.** The only cross-boundary touch is
a foreign key: `payment_settlement_matches.bankStatementLineId` references
`bank_statement_lines.id` — an additive relationship pointing _into_ an
existing table, not a modification of it (no new column on
`bank_statement_lines`, no new index requirement beyond what a foreign key
naturally uses via its existing primary key).

---

## 12. Banking-1d Integration

**Zero changes to `bank-reports.service.ts`.** Cash Position, the
Bank/Cash Account Statement, and Unreconciled Transactions already
report any `bank_cash_accounts` row — including a Clearing Account —
correctly and completely, because none of them queries
`bank_transactions`/`supplier_payments`/`customer_receipts` as an
authority; all three derive balance from `journal_lines`/`journal_entries`
(§2.5, and as reinforced by `c6ed76f`'s GL-completeness correction).
`payment_provider_settlements` is never queried by any Banking-1d file.

**Direct answer to Part 13's question — "if a clearing-account GL balance
is used for settlement reconciliation, where does that balance come
from?"**: Banking-1e's own new Clearing Account Reconciliation report
(§16) computes the Clearing Account's GL balance via its **own**
locally-duplicated `glBookBalance`-shaped query — the identical
cross-module-coupling convention `bank-reports.service.ts` itself already
uses (rather than importing `BankReportsService`), so Banking-1e never
becomes a caller of Banking-1d and never risks importing a stale or
differently-scoped balance. **The General Ledger remains the single
balance authority everywhere in this proposal — no second authority is
created**, and no report in this proposal can be mistaken for one (§16's
explicit five-figure table makes this non-negotiable).

**CTO amendment (this turn) — an explicit, honestly-flagged consequence
of Rule 2.** §7's new `purpose` column (`OPERATING`/`CLEARING`) is a
Banking-1a schema change, not a Banking-1d one, so Rule 2's "zero changes
to `bank-reports.service.ts`" still holds exactly as before — nothing in
this section changes. The consequence is that **Cash Position and the
Bank/Cash Account Statement will continue to present a Clearing Account's
GL balance with no `purpose` field**, because their DTOs
(`CashPositionRow` et al.) are explicit-field projections, not full-row
passthroughs (`kind: account.kind`, `bank-reports.service.ts:201` —
confirmed by direct read; adding `purpose` there is a genuine, if small,
code change). This is not a defect this proposal silently accepts: it is
recorded as **Open CTO Decision 13** (§30) — whether a narrow,
output-shape-only follow-on to `bank-reports.service.ts` (adding
`purpose` to the two existing row DTOs, with **no change to balance
derivation**) ships alongside Banking-1e's own implementation or is
deferred. Either answer preserves Rule 2's substance — GL derivation
logic is untouched either way — and neither is decided or implemented by
this document.

---

## 13. AP/AR Interaction

Per Part 14's options, provider settlement reconciliation is
**(C) partially linked now, with deeper linkage deferred**:

- **Linked, by configuration only, zero code dependency**: AR/AP already
  choose which `chart_of_accounts` row `bankCashAccountId` points at for
  a CARD/UPI-method Customer Receipt/Supplier Payment (§2.6, an existing,
  unrestricted field). Pointing it at a Clearing Account's `glAccountId`
  is a setup decision, not a Banking-1e capability.
- **Not linked, structurally**: Banking-1e never queries, joins against,
  or references `customer_receipts`/`supplier_payments` anywhere in its
  design. No AR/AP file is modified.
- **Deferred**: matching a settlement record's gross figure against the
  _specific_ underlying Customer Receipts that compose it. This requires
  exactly the generic provenance resolver Banking-1c's own Decision 13
  explicitly declined to build (matching `journal_lines` back to whichever
  of 6+ document tables produced them) — reopening that decision is out
  of scope here too, for the identical reasoning.

**No double-counting is possible, structurally, not merely by
convention**: a given payment's cash effect touches the Clearing
Account's GL exactly twice — once in (the Customer Receipt, posting 1 of
§6) and once out, net of fee (postings 2-3 of §6). Banking-1e's settlement
records and matches post nothing and reference no GL account directly —
they carry no path by which a cash effect could be recorded a second
time.

---

## 14. Import / Provider Adapter Architecture — MVP Contract

One new source-format seam, mirroring `bankStatementSourceFormatEnum`'s
own extensibility exactly:

```ts
export const paymentProviderSettlementFormatEnum = pgEnum(
  "payment_provider_settlement_format",
  ["GENERIC_SETTLEMENT_CSV"],
  // Vendor-neutral MVP contract (below) — no Razorpay-/Cashfree-/PayU-
  // specific adapter exists or is proposed; no real settlement file from
  // a named provider exists in this repository to build a faithful
  // vendor-specific parser against. A vendor-specific format is a later,
  // evidence-driven addition to this same enum (§8), never a rewrite.
);
```

**MVP column contract**, one row per settlement record:

```
settlement_id,settlement_date,gross_amount,fee_amount,adjustment_amount,net_amount,description
```

Parser behavior: for each row, validate `gross_amount - fee_amount +
adjustment_amount == net_amount` (§17's arithmetic identity) before
persisting; a row failing this check is a parse-time rejection (mirrors
Banking-1c's `FAILED` import status with a per-row error list — never a
silent auto-correction of the provider's own numbers). `settlement_id`
becomes `providerSettlementId` (§17), the idempotency key (§20).

**No route change is required for import itself beyond the analogous
`POST /payment-provider-settlement-imports` this new domain needs (§17)**
— this is a new endpoint (not a widened existing one, unlike the prior
draft's mistaken plan to overload `bank-statement-imports`), because a
settlement import is a genuinely different resource with its own
lifecycle (§18), not a variant bank statement import.

---

## 15. Idempotency / Duplicate Handling

**No repository-wide idempotency framework exists** — confirmed by
inspection: each table that needs uniqueness enforces it with its own
UNIQUE constraint (`bank_cash_accounts_gl_account_unique`,
`bank_statement_imports_account_file_hash_unique`,
`journal_entries_tenant_entity_number_unique`). This proposal follows the
identical, established pattern — no new infrastructure:

| Scenario                                                   | Mechanism                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same settlement file imported twice                        | `fileHash` UNIQUE on the import header (`(tenantId, legalEntityId, bankCashAccountId, fileHash)`) — identical shape to Banking-1c's own, rejected before parsing.                                                                                                                               |
| Same settlement ID appears in two different files          | `providerSettlementId` UNIQUE on `(tenantId, legalEntityId, bankCashAccountId, providerSettlementId)` on the settlement record itself — catches this even when the file-hash differs, which file-level dedup alone would miss. **This is the deterministic identity key** (Part 22 decision 8). |
| Same settlement split across multiple bank statement lines | Existing Banking-1c N:1 manual matching (§10) — no new mechanism.                                                                                                                                                                                                                               |
| Multiple settlement batches as one bank credit             | Existing Banking-1c 1:N manual matching (§10) — no new mechanism.                                                                                                                                                                                                                               |
| Same settlement file re-uploaded                           | Same as "imported twice," above — one mechanism covers both phrasings.                                                                                                                                                                                                                          |

---

## 16. Differences / Exceptions

Per Part 11's explicit instruction to only include states that can
actually be implemented correctly, MVP reuses exactly the two mechanisms
Banking-1c already has proven, applied to the new domain — **no invented
taxonomy of difference "reasons":**

1. **Internal-consistency warning** (parse-time, non-blocking) — mirrors
   Banking-1c's own opening+credits-debits≠closing warning (§7 of the
   Banking-1c proposal) exactly: if a settlement row's own
   gross/fee/adjustment/net arithmetic doesn't reconcile, MVP rejects it
   outright (§14) rather than importing an internally-inconsistent
   record — stricter than Banking-1c's own bank-statement warning,
   because a settlement record's arithmetic is fully known and
   verifiable at parse time, unlike a bank's own declared closing
   balance.
2. **Matching status** (`UNMATCHED`/`PARTIALLY_MATCHED`/`MATCHED`/
   `IGNORED`) — identical enum, identical semantics to
   `bank_statement_lines.matchStatus` (§18). `UNMATCHED` most commonly
   means a timing difference (the bank hasn't credited yet, or the
   settlement hasn't been imported yet) — MVP does not attempt to guess
   or auto-label the cause beyond this, honestly.
3. **Balance-level `differenceMinor`** (Clearing Account Reconciliation
   report, §13) — identical shape to Banking-1c's own §17: `Σ(settlement
net amounts for the period) − Clearing Account's GL movement for the
period`. A nonzero figure tells the user _that_ something doesn't tie
   out and gives them the underlying settlement records and matched bank
   lines to investigate _why_ — MVP does not auto-classify the cause
   (fee/timing/chargeback/error) beyond what the settlement record's own
   gross/fee/adjustment/net fields and match status already show.

No "explainable difference" / "unresolved difference" state machine is
proposed — that would require automated causal classification this
proposal has no evidence-grounded way to build correctly (the identical
reasoning Banking-1c used to reject fuzzy matching).

---

## 17. POS Future Seam

```
   POS sale
       |
   payment method (CARD / UPI)
       |
   provider transaction        <-- NOT ingested by Banking-1e (payment-
       |                           activity-level data, §5/§9); a future
       |                           POS/payment-processing work item's
       |                           own domain
       v
   provider settlement          <-- Banking-1e's payment_provider_
       |                            settlements (§17 data model) — THIS
       |                            is where a future POS settlement feed
       |                            would land, at the SAME batch-level
       |                            granularity this proposal already
       |                            defines
       v
   bank settlement (TRANSFER + FEE, §6)     <-- unchanged, existing
       |
   bank statement (Banking-1c)              <-- unchanged, existing
```

**Seams Banking-1e reserves now, without building POS integration**:
`paymentProviderSettlementFormatEnum` is exactly as extensible as
`bankStatementSourceFormatEnum` (§14) — a future POS-settlement-file
adapter is an additional enum value + parser, targeting the same
normalized `payment_provider_settlements` schema (§8). `providerSettlementId`
(free text, §17) is general enough to hold a POS acquirer's own batch
identifier unchanged. **What is deliberately not built**: any POS
transaction capture, any provider-transaction-level linkage, or
payment-activity-level reconciliation (§5's item A) — a future POS work
item connects at the settlement layer this proposal defines, without
Banking-1e needing to be redesigned.

**CTO amendment (this turn) — the stable identifier and FK direction for
the future transaction-level chain.** Not building POS ingestion now
does not excuse leaving its future connection point unspecified; this is
the direct answer to Part 2's requirement, still design-only:

```
POS Payment Activity
       |
Payment Provider Transaction   <-- future table, Banking-1f+:
       |                           payment_provider_transactions
       |                           (NOT proposed or implemented here)
       v
Provider Settlement            <-- payment_provider_settlements
       |                           (THIS proposal, §32 — id: uuid PK,
       |                           providerSettlementId: unique per
       |                           account) — already stable today.
       v
Bank Statement / GL            <-- unchanged (§11, §12)
```

- **Stable identifier**: the future `payment_provider_transactions` row
  would carry the provider's own per-transaction identifier (its
  `providerTransactionId`, analogous in shape to this proposal's own
  `providerSettlementId` — a provider-issued string, no format assumed)
  as its natural/business key, and a **nullable** `settlementId`
  reference once (and only once) that transaction is included in a
  settlement batch.
- **FK direction: many (transactions) → one (settlement), not the
  reverse.** A provider transaction occurs _before_ it is known which
  settlement batch will eventually include it (settlement is typically
  many-to-one: a batch aggregates many transactions), so the "many" side
  must hold the FK — the same relational shape this proposal already
  uses everywhere else (`payment_settlement_matches` → one
  `payment_provider_settlements` row it belongs to; `bank_statement_lines`
  is never modified to point back at its matches). The future FK would
  target `payment_provider_settlements.id` — the existing, stable
  surrogate primary key this proposal already defines (§32) — never the
  natural `providerSettlementId` key, so no future migration needs to
  change how this proposal's own table is keyed.
- **Why 1e's current schema already accommodates this without
  modification**: `payment_provider_settlements.id` is a UUID primary
  key today, exactly the kind of stable target a future FK needs; adding
  a _new_ table with a FK pointing at an _existing_ primary key is, by
  construction, additive and requires zero change to this proposal's own
  tables. No column is missing, no key is the wrong shape, and no
  reserved-but-empty column is being added speculatively to
  `payment_provider_settlements` today (this proposal does not add a
  `posTransactionId` or similar placeholder column — Part 2's own
  instruction is to document the seam, not pre-build it).
- **What remains intentionally deferred to Banking-1f+**: the
  `payment_provider_transactions` table itself; POS sale capture; the
  provider-transaction-level reconciliation this would enable (matching
  individual POS sales to the settlement batch that eventually paid
  them out, distinct from this proposal's own settlement↔bank matching,
  §10); any transaction-level variance/timing reporting. None of this is
  built, and none of it is required for Banking-1e's own MVP (§26) to be
  complete and correct on its own terms.

---

## 18. Lifecycle — Three Independent State Machines, Never Conflated

Per Part 18's explicit warning not to repeat the exact mistake the
original Banking-1c draft made (conflating import status with
reconciliation status):

**A. Import status** (`paymentProviderSettlementImportStatusEnum`:
`PENDING` / `VALIDATED` / `FAILED`) — parsing lifecycle only. Did the file
read and validate. Identical shape, identical reasoning, to Banking-1c's
`bankStatementImportStatusEnum` (§2.4).

**B. Reconciliation status** (`paymentSettlementReconciliationStatusEnum`:
`OPEN` / `COMPLETED`) — a **separate** enum, on the **same**
`payment_provider_settlement_imports` header row, exactly mirroring how
Banking-1c keeps its own two lifecycles on one row without conflating
them. Completion requires, identically to Banking-1c's §9 (both
independently, neither sufficient alone):

- **A. Matching completeness** — every `payment_provider_settlements`
  row for this import is `MATCHED` or `IGNORED`.
- **B. Balance reconciliation** — the period's `differenceMinor`
  (§16) is `0` against the Clearing Account's real GL balance.

**C. Accounting status** — **not a field on any Banking-1e table.**
Accounting status lives entirely on `bank_transactions.status`
(DRAFT/POSTED, if the optional create-settlement-transactions convenience,
§19, was used) and `journal_entries.status` — both pre-existing,
untouched. Banking-1e owns no accounting entries and therefore has no
accounting-status concept of its own to conflate with anything.

---

## 19. Posting Architecture — the Bounded create-from-settlement Convenience

The only new write-adjacent capability this proposal recommends for MVP
(§26, Open CTO Decision 3): `POST
/payment-provider-settlements/:id/create-settlement-transactions` —
directly analogous to Banking-1c's existing create-from-line convenience
(§2.4), pre-filling **two** DRAFT `bank_transactions` from one settlement
record:

- A `TRANSFER` (Clearing Account → the real Bank/Cash Account the user
  selects, `amountMinor = netAmountMinor`).
- A `FEE` (Clearing Account → an EXPENSE account the user selects,
  `amountMinor = feeAmountMinor`, skipped if the fee is zero).

Both are created via the **existing, unmodified**
`BankTransactionsService.create()` — the identical mechanism Banking-1c's
own create-from-line convenience already calls. **Neither is posted by
this action.** The user still issues two separate, explicit `POST
/bank-transactions/:id/post` calls, with the exact same RBAC, period
validation, and audit trail Banking-1b already has. This preserves
"reconciliation must never become a hidden second accounting engine"
(§26, Rule 6) by construction: the convenience only ever reaches DRAFT,
never POSTED, on its own. `adjustmentAmountMinor`, when nonzero, is
**not** auto-converted into a third transaction (§6) — the user handles it
manually, exactly as any GL adjustment is handled today.

---

## 20. Reporting

| Report                                                    | MVP / Future | Authoritative source                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settlement import list/detail                             | **MVP**      | `payment_provider_settlement_imports` / `payment_provider_settlements` (new tables, read-only).                                                                                                                                                                                                                                                              |
| Settlement ↔ bank matching view                           | **MVP**      | `payment_provider_settlements.matchStatus` + `payment_settlement_matches`.                                                                                                                                                                                                                                                                                   |
| Clearing Account Reconciliation (settlement total vs. GL) | **MVP**      | Two figures, never merged: **PROVIDER SETTLEMENT TOTAL** = `Σ payment_provider_settlements.netAmountMinor` (a claim _from_ the provider, never GL-authoritative) vs. **CLEARING ACCOUNT (GL) BALANCE** = the Clearing Account's own `journal_lines`-derived balance, computed locally (§13) — `differenceMinor` reported, never silently reconciled to zero. |
| Gateway fee report (aggregate, cross-settlement)          | **Future**   | No accounting need beyond what the FEE bank transaction already puts in the P&L via the existing, unmodified Financial Statements module.                                                                                                                                                                                                                    |
| Provider-wise summary / settlement variance trend         | **Future**   | Presentation-only refinement of MVP's existing data; no new data requirement.                                                                                                                                                                                                                                                                                |

**No report in this proposal may become a second accounting authority.**
The five distinct figures this domain touches are never conflated:
**BANK BALANCE** (Banking-1c's `bank_statement_imports.closingBalanceMinor`,
the bank's own declared figure) / **GL BALANCE** (`journal_lines`, always
authoritative, everywhere) / **CLEARING ACCOUNT BALANCE** (= the GL
balance _of_ the Clearing Account specifically — not a separate concept,
just a scoped view of GL BALANCE) / **PROVIDER SETTLEMENT TOTAL** (this
proposal's own new figure, a claim from the provider) / **BANK STATEMENT
TOTAL** (Banking-1c's own, unmodified). Every report in §20 states which
of these five it is showing.

---

## 21. RBAC / Security / RLS

Reuses the existing three roles exactly — no new role is proposed, per
Part 19's explicit instruction and Banking-1c's own established
`route-role-matrix.spec.ts` shape (verified against the actual file in
this turn's baseline check, §0):

| Action                                                     | Role(s)                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Import a provider settlement file                          | `finance.poster`                                                   |
| View settlements / matches / reconciliation reports        | `finance.viewer`, `finance.poster`, `finance.admin`                |
| Match / unmatch a settlement against a bank statement line | `finance.poster`                                                   |
| Create settlement transactions (DRAFT only, §19)           | `finance.poster` — identical to Banking-1c's create-from-line RBAC |
| Complete settlement reconciliation                         | `finance.poster`                                                   |

RLS: new tables get the identical `tenant_id`-only `ENABLE`+`FORCE ROW
LEVEL SECURITY` policy every one of the 13 existing RLS files in
`services/sphere-finance/drizzle/rls/` already uses (verified listing,
`001_enable_rls.sql` through `013_banking_1c_rls.sql`); `legalEntityId`
isolation stays an explicit service-layer predicate, the same convention
every Finance service already uses. No special control beyond the
existing Finance conventions is identified for this imported external
data — it carries the same sensitivity class (financial transaction data)
as a bank statement, already covered.

---

## 22. Auditability / Immutability

Reuses the existing `audit_logs` table (`packages/db-core/src/schema.ts:218-243`
— `tenantId`, `legalEntityId`, `actorUserId`, `action`, `entityType`,
`entityId`, `beforeState`, `afterState`) — no new audit framework:

- **`payment_provider_settlement_import`** — CREATE at upload, UPDATE at
  each import-status transition and, separately, at each
  reconciliation-status transition (identical dual-lifecycle-one-
  entityType pattern to Banking-1c's own `bank_statement_import`, §18).
- **`payment_settlement_match`** — CREATE on match, UPDATE on undo
  (status ACTIVE → UNDONE, an UPDATE not a DELETE — the row and its audit
  trail both preserve that a match once existed, identical to Banking-1c's
  own `bank_reconciliation_match`).
- **No per-record audit row** for `payment_provider_settlements` itself —
  identical reasoning to Banking-1c's own explicit decision against
  per-line audit rows for `bank_statement_lines` (a single import can
  carry many records; one CREATE row on the import summarizing count is
  sufficient).

Immutability: once a settlement import's `reconciliationStatus =
COMPLETED`, its `payment_provider_settlements` and
`payment_settlement_matches` rows become immutable at the DB-trigger
level — the identical mechanism (a new numbered file in
`services/sphere-finance/drizzle/constraints/`, continuing the existing
sequence past `021_bank_reconciliation_matches_immutability_trigger.sql`)
Banking-1c already uses for its own three tables, verified independently
(bypassing the application layer entirely), the same discipline
`test/bank-transactions.e2e-spec.ts` and Banking-1c's own e2e suite
already established.

---

## 23. API / Route Design

New routes only — no existing Banking-1a/1b/1c/1d/AP/AR route is widened
or modified (correcting the prior draft's plan to overload `POST
/bank-statement-imports`):

```
POST   /payment-provider-settlement-imports
GET    /payment-provider-settlement-imports
GET    /payment-provider-settlement-imports/:id
DELETE /payment-provider-settlement-imports/:id
POST   /payment-provider-settlement-imports/:id/complete
GET    /payment-provider-settlement-imports/:id/settlements
GET    /payment-provider-settlements/:id/suggestions
POST   /payment-provider-settlements/:id/match
POST   /payment-provider-settlements/:id/matches/:matchId/undo
POST   /payment-provider-settlements/:id/create-settlement-transactions
GET    /payment-provider-settlements/clearing-reconciliation
```

Route-shape follows Banking-1c's own controller exactly (a plural
resource prefix, `:id`-scoped sub-actions) — no routing-collision risk of
the kind self-caught in Banking-1d's own design (§2.5's history), since
this prefix is entirely new and shares no path segment with any existing
controller.

---

## 24. Testing Strategy

Mirrors Banking-1c's own e2e discipline exactly — real Postgres, no
mocking of accounting behavior — for whichever future turn receives
implementation authorization (this document authorizes none of it):

- Valid provider settlement import: file parses, records created,
  `gross - fee + adjustment = net` holds for every record.
- Duplicate settlement import (same file hash) — rejected, 409.
- Duplicate settlement ID across two different files — rejected via the
  `providerSettlementId` UNIQUE constraint (§15), independent of file
  hash.
- Malformed provider data (arithmetic doesn't reconcile) — `FAILED`
  import, per-row error, zero records persisted (§14/§16).
- Settlement-to-bank-statement-line matching: 1:1, 1:N, N:1, partial
  allocation, over-allocation rejection (identical shape to Banking-1c's
  own existing test coverage, applied to the new pair of tables).
- Settlement variance: a settlement whose net figure does not match any
  bank statement line — surfaces as `UNMATCHED`, contributes to
  `differenceMinor` in the Clearing Account Reconciliation report.
- Gateway fee handling: a FEE bank transaction created via
  create-settlement-transactions correctly reduces the Clearing
  Account's GL balance once posted.
- Clearing Account balance: proven GL-derived, never
  `payment_provider_settlements`-derived (an explicit regression test
  asserting the two would differ if a settlement were imported without
  its corresponding TRANSFER/FEE yet posted — proving the report is
  honest about the difference, not silently zeroed).
- GL authority: no test scenario in which completing settlement
  reconciliation, or any Banking-1e action, writes to `journal_entries`/
  `journal_lines`.
- Tenant isolation / legal-entity isolation — raw-SQL RLS verification,
  identical discipline to `rls-hardening.e2e-spec.ts`.
- RBAC — `route-role-matrix.spec.ts` coverage for every new route.
- Audit trail — `payment_provider_settlement_import`/
  `payment_settlement_match` entityType rows created correctly.
- Immutability — raw-SQL UPDATE/DELETE rejection post-completion,
  bypassing the application layer, identical discipline to Banking-1c's
  own verification.
- Reconciliation completion — both conditions (matching completeness,
  balance equality) independently required; each failing alone is
  rejected; both together succeeds.
- Currency behavior — single functional currency per legal entity (no
  FX anywhere in this schema, §2.1); a settlement record's currency must
  match the Clearing Account's own.
- Concurrent operations — over-allocation guard under concurrent match
  creation, identical discipline to Banking-1c's own existing
  concurrency tests.

**These are stated as future implementation acceptance criteria — none
has been run, because none has been implemented (§27).**

---

## 25. Migration Strategy

**Corrected this turn (quality-pass finding, §3 of the amendment
instruction)**: this section previously said "5 new tables," which never
matched §32's data model (3 new tables). Corrected below.

Additive, with exactly one narrow exception introduced by this
amendment: **3 new tables** (`payment_provider_settlement_imports`,
`payment_provider_settlements`, `payment_settlement_matches` — §32), **6
new enums** scoped to those tables (`paymentProviderSettlementFormatEnum`,
`paymentProviderSettlementImportStatusEnum`,
`paymentSettlementReconciliationStatusEnum`,
`paymentSettlementMatchStatusEnum`, `paymentSettlementMatchTypeEnum`,
`paymentSettlementMatchStatusStateEnum`), 1 new RLS file (continuing past
`013_...`), 1-2 new immutability trigger files (continuing past
`021_...`).

**The one exception (§7, this amendment)**: 1 new enum
(`bankCashAccountPurposeEnum`, values `OPERATING`/`CLEARING`) and 1
additive `NOT NULL DEFAULT 'OPERATING'` column (`purpose`) on the
**existing** `bank_cash_accounts` table (Banking-1a) — the only `ALTER`
this proposal now recommends, deliberately minimal (§7 explains why it is
safe: zero existing consumer branches on any column of this table by
value except `kind`, and `purpose` does not touch `kind`). Every other
existing table (`bank_transactions`, `bank_statement_imports`,
`bank_statement_lines`, `bank_reconciliation_matches`,
`customer_receipts`, `supplier_payments`, `journal_entries`,
`journal_lines`, `chart_of_accounts`) remains completely unaltered. Zero
change to Banking-1b/1c/1d/AP/AR/Journal Engine/GeneralLedgerService
_behavior_ — confirmed architecturally throughout this document, not
merely asserted; Banking-1a's _schema_ gains one additive column, and
its DTOs would need a small, separately-scoped follow-on to accept/return
it on write (§7) — neither is implemented by this document.

---

## 26. MVP Scope

- An additive `purpose` column (`OPERATING`/`CLEARING`, default
  `OPERATING`) on the **existing** `bank_cash_accounts` table (§7, §25,
  amended this turn) — the machine-readable Clearing Account
  classification; the only proposed change to an existing table.
- `payment_provider_settlement_imports` / `payment_provider_settlements` /
  `payment_settlement_matches` (§17), reusing Banking-1c's exact
  three-table shape.
- One vendor-neutral `GENERIC_SETTLEMENT_CSV` import format (§14).
- Settlement ↔ bank-statement-line matching, reusing Banking-1c's
  existing engine unmodified (§10).
- The bounded `create-settlement-transactions` convenience (§19),
  DRAFT-only, reusing `BankTransactionsService.create()` unmodified.
- Clearing Account Reconciliation report (§20/§13), GL-authoritative.
- Settlement reconciliation completion (§18), the identical
  two-condition gate Banking-1c already established.
- RBAC/RLS/audit/immutability, reusing existing conventions exactly
  (§21/§22).

---

## 27. Explicitly Out of Scope

- Any payment gateway/PSP API or webhook integration (§2.8) — this
  proposal only ever ingests a file the user downloads and uploads,
  exactly like a bank statement.
- Vendor-specific parsers (Razorpay/Cashfree/PayU/Stripe-named formats)
  — no real settlement file evidence exists to build one against (§8,
  §14).
- Payment/provider-activity-level reconciliation (§5 item A, §10) —
  individual transaction-to-settlement-line-item matching.
- Dispute/chargeback case-management lifecycle (§9).
- Itemized tax/withholding/other-fee modeling (§9) — folded into one net
  `adjustmentAmountMinor` figure.
- Automatic adjustment-driven GL postings (§6) — the user handles these
  manually, as today.
- Any new `bank_cash_accounts.kind` value — the amended §7 resolution
  adds a separate, orthogonal `purpose` column instead, deliberately
  leaving `kind`'s existing two values (`BANK`/`CASH`) untouched.
- A `clearingProviderCode` (or similar) column recording _which_
  provider a Clearing Account serves — considered and rejected as
  redundant with the existing
  `payment_provider_settlement_imports.bankCashAccountId` FK (§7).
- Any change to AP/AR posting code (§13).
- Any change to `bank-reports.service.ts`, Cash Position, the Bank/Cash
  Account Statement, or Unreconciled Transactions (§12).
- Any change to `docs/roadmap.md`.
- POS transaction capture or integration (§17) — a future seam is
  reserved, nothing is built.
- Gateway fee report, provider-wise summary, settlement variance trend
  (§20) — future, presentation-only.

---

## 28. Future Extension Points

- Vendor-specific settlement-format adapters, once real export files
  justify them (§8, §14).
- Itemized adjustment taxonomy (tax on fee, withholding, chargeback,
  refund) once evidence of real usage volume justifies the modeling risk
  (§9).
- Automatic adjustment-driven GL posting, if a specific, evidence-backed
  adjustment type proves common enough to warrant it (§6).
- Payment/provider-activity-level reconciliation and the full POS
  integration (§17), once a POS work item defines what data it actually
  captures.
- A `UPI` (or other) `paymentMethodEnum` value with real downstream
  behavior on AR/AP, if evidence justifies moving those labels beyond
  free text (§2.6) — explicitly not this proposal's decision to make.

---

## 29. Critical Anti-Regression Rules — Preserved Throughout

1. General Ledger remains the accounting authority — every balance this
   proposal reports is GL-derived (§12, §13, §20).
2. Banking-1d does not gain a second balance authority — zero changes to
   `bank-reports.service.ts` (§12).
3. Banking-1c remains the bank-statement import/reconciliation
   foundation — zero changes to any of its files (§11).
4. Banking-1e does not duplicate Banking-1c functionality — it owns a
   different external input (provider settlements) and reuses
   Banking-1c's own matching/statement-line infrastructure at the one
   point they relate (§11).
5. No AP/AR posting behavior is modified (§13).
6. Reconciliation — both kinds — never becomes a posting engine; the one
   new convenience only ever reaches DRAFT (§6, §19).
7. Clearing accounts are never presented as, or confused with, real bank
   accounts in this proposal's own reports (§7, §20) — enforced, as of
   this amendment, by an explicit machine-readable `purpose` field
   (`OPERATING`/`CLEARING`), not by naming convention alone.
8. Provider settlement imports are idempotent at both the file level and
   the individual-settlement-identifier level (§15).
9. Gross/fee/adjustment/net arithmetic is validated at parse time and
   auditable thereafter (§14, §16, §22).
10. The payment-provider abstraction is a source-format seam, not a
    vendor-specific rewrite risk (§8).
11. POS integration has a clean, reserved, unbuilt future seam (§17).
12. Import lifecycle, reconciliation lifecycle, and accounting lifecycle
    are three separate state machines, never conflated (§18).

---

## 30. Open CTO Decisions

| #   | Decision                                                                                                                                                                       | Options                                                                                                                                                                                                                                                                                                                                    | Recommended                                                                                                                                       | Reason                                                                                                                                                                                                                                                                                                                                                                                                | Impact if rejected                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is provider settlement a first-class domain entity?                                                                                                                            | (a) Yes — dedicated tables (this proposal); (b) No — extend `bank_statement_lines` (prior draft's approach)                                                                                                                                                                                                                                | **(a)**                                                                                                                                           | Only (a) can express gross/fee/adjustment/net as one auditable, arithmetic-validated record (§4, §17); (b) loses that structure.                                                                                                                                                                                                                                                                      | Rejecting (a) reopens the exact defect this rewrite corrects — settlement data with no provable internal consistency.                                                                                                        |
| 2   | Should Clearing Accounts remain represented through existing `bank_cash_accounts`, and how should the distinction from a real bank account be recorded? **Amended this turn.** | (a) Yes, represented via `bank_cash_accounts`, distinguished by an explicit `purpose` column (`OPERATING`/`CLEARING`) — this amendment, §7; (b) Yes, represented via `bank_cash_accounts`, distinguished only by naming convention + FK discoverability — this proposal's **prior**, now-superseded recommendation; (c) a new `kind` value | **(a)**                                                                                                                                           | Investigation (§7) found zero existing logic branches on any `bank_cash_accounts` column by value except `kind`, so an additive, orthogonal `purpose` column is safe and gives a genuinely machine-readable answer — (b) cannot be queried or constrained, only inferred; (c) collapses two independent questions (BANK-vs-CASH, OPERATING-vs-CLEARING) into one enum and forecloses future purposes. | Rejecting (a) in favor of (b) reopens exactly the "not machine-readable" gap this amendment was requested to close. Rejecting in favor of (c) is a larger, less extensible schema change than (a) for no added benefit (§7). |
| 3   | Should Banking-1e create accounting entries automatically?                                                                                                                     | (a) No, fully manual; (b) DRAFT-only convenience (this proposal, §19); (c) auto-post                                                                                                                                                                                                                                                       | **(b)**                                                                                                                                           | Mirrors Banking-1c's own approved create-from-line precedent exactly; never auto-posts, so Rule 6 (§29) holds.                                                                                                                                                                                                                                                                                        | (c) would violate "reconciliation must not post GL" outright — not recommended under any circumstance. (a) is safe but a real UX gap at volume.                                                                              |
| 4   | Should Banking-1e create `bank_transactions` automatically (fully, without user confirmation)?                                                                                 | (a) No — DRAFT only, explicit user `post()` (this proposal); (b) auto-post                                                                                                                                                                                                                                                                 | **(a)**                                                                                                                                           | Identical reasoning to decision 3.                                                                                                                                                                                                                                                                                                                                                                    | (b) rejected for the same reason.                                                                                                                                                                                            |
| 5   | What is the MVP reconciliation universe?                                                                                                                                       | (a) B↔C only (this proposal); (b) A↔B↔C↔D fully                                                                                                                                                                                                                                                                                            | **(a)**, with B↔D reported (not matched)                                                                                                          | No transaction-level provider feed exists to reconcile A (§5, §10); D is a balance check, not a matching relationship.                                                                                                                                                                                                                                                                                | Attempting (b) now would require inventing payment-activity ingestion with no evidence base (§9's own reasoning).                                                                                                            |
| 6   | How should gateway fees be represented?                                                                                                                                        | (a) One net `feeAmountMinor` field (this proposal); (b) itemized fee schedule                                                                                                                                                                                                                                                              | **(a)**                                                                                                                                           | No evidence of real fee-schedule complexity to model correctly yet (§9).                                                                                                                                                                                                                                                                                                                              | (b) is future scope, not a blocker.                                                                                                                                                                                          |
| 7   | How should settlement differences be represented?                                                                                                                              | (a) Reuse existing matchStatus + differenceMinor (this proposal); (b) a new causal-classification state machine                                                                                                                                                                                                                            | **(a)**                                                                                                                                           | (b) requires automated cause classification this proposal cannot build correctly without evidence (§16).                                                                                                                                                                                                                                                                                              | (b) risks the same over-engineering Banking-1c explicitly avoided for fuzzy matching.                                                                                                                                        |
| 8   | What is the identity/idempotency key?                                                                                                                                          | (a) `providerSettlementId` UNIQUE per account (this proposal); (b) file-hash only                                                                                                                                                                                                                                                          | **(a)**, with (b) retained as a second, coarser check                                                                                             | (a) catches "same ID across two files," which (b) alone misses (§15).                                                                                                                                                                                                                                                                                                                                 | (b) alone leaves a real duplicate-accounting-effect gap.                                                                                                                                                                     |
| 9   | How much POS linkage belongs in 1E?                                                                                                                                            | (a) A reserved format/adapter seam only (this proposal, §17); (b) actual POS integration                                                                                                                                                                                                                                                   | **(a)**                                                                                                                                           | No POS transaction-capture architecture exists yet to link to (§2.8).                                                                                                                                                                                                                                                                                                                                 | (b) is a materially larger, separately-scoped work item.                                                                                                                                                                     |
| 10  | Which providers/formats belong in MVP?                                                                                                                                         | (a) One generic, vendor-neutral CSV contract (this proposal, §14); (b) named-provider adapters                                                                                                                                                                                                                                             | **(a)**                                                                                                                                           | No real export file from a named provider exists in this repository (§8).                                                                                                                                                                                                                                                                                                                             | (b) risks building a parser against a guessed, not evidenced, file shape.                                                                                                                                                    |
| 11  | Should settlement reporting ship in MVP?                                                                                                                                       | (a) Yes — the three reports in §20's MVP row; (b) defer all reporting                                                                                                                                                                                                                                                                      | **(a)**                                                                                                                                           | Without at least the Clearing Account Reconciliation report, completion (§18) has no way to verify condition B.                                                                                                                                                                                                                                                                                       | (b) would leave reconciliation completion unimplementable.                                                                                                                                                                   |
| 12  | What is explicitly deferred to Banking-1f or later?                                                                                                                            | See §28 in full                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                            |
| 13  | Should Banking-1d's Cash Position/Statement DTOs be updated to surface the new `purpose` field? **New this turn (§7, §12).**                                                   | (a) Yes, as a narrow follow-on shipped alongside Banking-1e's implementation (output-shape only, no balance-derivation change); (b) Defer — Banking-1a's own `GET /bank-cash-accounts` already surfaces `purpose` immediately, and Banking-1e's own reports filter on it explicitly                                                        | **Not recommended here — genuinely open.** Either choice preserves Rule 2 and GL authority; this is a UX/priority call, not an architectural one. | (a) closes the "Clearing Account shown in Cash Position with no flag" gap sooner; (b) keeps Banking-1e's diff strictly limited to new files, consistent with this proposal's own file-scope discipline throughout.                                                                                                                                                                                    | Deferring indefinitely leaves Cash Position permanently unable to visually flag a Clearing Account — a real, if minor, UX gap, not a correctness or GL-authority defect.                                                     |

---

## 31. Roadmap Integration

Using `docs/roadmap.md`'s own terminology (`docs/roadmap.md:167`):

```
COMPLETED
    Banking-1a — Bank accounts
    Banking-1b — Bank transactions, Bank transfers
    Banking-1c — Bank reconciliation
    Banking-1d — Cash position
    (Cash management, Cash receipts, Cash payments — already satisfied
     generically by the above, §2.3 — no separate work item needed)

NEXT
    Banking-1e — UPI/card/bank payment reconciliation where applicable
                 (this proposal)

FUTURE
    Payment/provider-activity-level reconciliation (§5, deferred from 1e)
    POS integration (§17, deferred from 1e)
    Vendor-specific settlement adapters (§8, deferred from 1e)
    Remaining Finance-roadmap items outside Banking & Cash entirely
    (e.g. multi-currency/FX, Cash Flow Statement, Expense Management,
    Fixed Assets, Budgeting/Planning — per docs/roadmap.md's own
    "Sphere Finance — complete finance suite" line item; none inspected
    in depth here, as they are unrelated to Banking-1e's scope)
```

No milestone number is invented — "Banking-1e" is this proposal's own
name, matching the sequential naming Banking-1a/1b/1c/1d already
established; nothing beyond that is asserted as an official roadmap
number.

---

## 32. Data Model

Only after §3-§20's discovery, and per Part 17's explicit instruction to
define entities/relationships/lifecycle/ownership before schema:

**Entities**: Settlement Import (header, one file/batch), Settlement
Record (one provider-reported settlement, gross/fee/adjustment/net),
Settlement Match (a link between one Settlement Record and one existing
`bank_statement_lines` row).

**Relationships**: one Settlement Import has many Settlement Records
(1:N); one Settlement Record has many Settlement Matches (1:N, supporting
partial/N:1/1:N per §10); one Settlement Match references exactly one
existing `bank_statement_lines` row (a read/reference FK into Banking-1c's
table, not a modification of it).

**Lifecycle**: three independent state machines (§18) — import status,
reconciliation status, and (not owned here) accounting status on the
optional `bank_transactions` created via §19.

**Ownership**: Banking-1e owns all three new tables outright. It
references but never owns `bank_statement_lines` (Banking-1c) or
`chart_of_accounts`/`journal_lines` (Accounting Core). `bank_cash_accounts`
remains Banking-1a's table in every respect that matters — Banking-1e
proposes exactly one additive column on it (`purpose`, §7, §25) and does
not otherwise modify, own, or take over any part of its lifecycle
(creation/update remains `BankCashAccountsService`'s alone).

**Accounting authority**: General Ledger, exclusively, everywhere in this
domain (§6, §29 Rule 1).

**Reconciliation authority**: this domain's own `matchStatus`/
`reconciliationStatus` for settlement↔bank matching; never conflated with
GL authority (§16, §18).

**Identity/idempotency**: `providerSettlementId`, scoped per
`(tenantId, legalEntityId, bankCashAccountId)` (§15).

```ts
// Illustrative — NOT implemented. Mirrors this codebase's existing
// conventions exactly (schema.ts's own patterns): real FKs within
// Finance's own tables, no cross-service FK to tenants/legal_entities,
// tenant_id-only RLS, explicit legalEntityId service-layer predicate,
// bigint-mode-number minor-unit amounts, date columns for accounting
// dates, the "friendly check + DB constraint" idempotency pattern.

// --- §7 amendment: the one additive change to an EXISTING table -----------
// ALTER, not CREATE — bank_cash_accounts is Banking-1a's table, already
// implemented and on `main`. This is the only schema change this
// proposal recommends against an existing table; every table below it
// is new.

export const bankCashAccountPurposeEnum = pgEnum(
  "bank_cash_account_purpose",
  ["OPERATING", "CLEARING"],
  // OPERATING = real, spendable bank/cash account (default — every
  // existing row is correctly OPERATING, since no Clearing Account
  // exists prior to Banking-1e). CLEARING = a payment-provider
  // settlement clearing/pooling account (§7) — orthogonal to `kind`,
  // never a replacement for it.
);

// Illustrative ALTER on the EXISTING bankCashAccounts table
// (schema.ts:1754) — shown here as the added column only, not a
// reproduction of the whole table:
//
//   purpose: bankCashAccountPurposeEnum("purpose")
//     .notNull()
//     .default("OPERATING"),
//
// Migration: `ALTER TABLE bank_cash_accounts ADD COLUMN purpose
// bank_cash_account_purpose NOT NULL DEFAULT 'OPERATING'` — metadata-only
// for a non-volatile default, no table rewrite (§7, §25).

export const paymentProviderSettlementFormatEnum = pgEnum(
  "payment_provider_settlement_format",
  ["GENERIC_SETTLEMENT_CSV"], // §8/§14 — vendor-neutral MVP seam.
);

export const paymentProviderSettlementImportStatusEnum = pgEnum(
  "payment_provider_settlement_import_status",
  ["PENDING", "VALIDATED", "FAILED"],
  // Import/parsing lifecycle ONLY (§18.A) — mirrors
  // bankStatementImportStatusEnum exactly. Deliberately no COMPLETED
  // value here either.
);

export const paymentSettlementReconciliationStatusEnum = pgEnum(
  "payment_settlement_reconciliation_status",
  ["OPEN", "COMPLETED"],
  // §18.B — the ONLY place COMPLETED is used in this domain. Two
  // independent conditions required (§18), identical shape to
  // bankReconciliationStatusEnum.
);

export const paymentProviderSettlementImports = pgTable(
  "payment_provider_settlement_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    // The Clearing Account this settlement batch belongs to — an
    // ordinary bank_cash_accounts row, kind = BANK, purpose = CLEARING
    // (§7, amended this turn). Real FK: same migration lifecycle,
    // Finance's own table.
    bankCashAccountId: uuid("bank_cash_account_id")
      .notNull()
      .references(() => bankCashAccounts.id),
    providerFormat:
      paymentProviderSettlementFormatEnum("provider_format").notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(), // sha256 hex, §15.
    status: paymentProviderSettlementImportStatusEnum("status")
      .notNull()
      .default("PENDING"),
    reconciliationStatus: paymentSettlementReconciliationStatusEnum(
      "reconciliation_status",
    )
      .notNull()
      .default("OPEN"),
    parseWarnings: jsonb("parse_warnings"), // non-blocking, §16 item 1.
    parseErrors: jsonb("parse_errors"), // present only on a FAILED import.
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
    unique("ppsi_account_file_hash_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.bankCashAccountId,
      t.fileHash,
    ), // §15 — identical shape to Banking-1c's own file-hash guard.
    index("ppsi_tenant_entity_idx").on(t.tenantId, t.legalEntityId),
  ],
);

export const paymentSettlementMatchStatusEnum = pgEnum(
  "payment_settlement_match_status",
  ["UNMATCHED", "PARTIALLY_MATCHED", "MATCHED", "IGNORED"],
  // Identical semantics to bankStatementLineMatchStatusEnum — §16 item 2.
);

export const paymentProviderSettlements = pgTable(
  "payment_provider_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(), // denormalized — RLS requirement, same reasoning as journal_lines.tenantId.
    legalEntityId: uuid("legal_entity_id").notNull(),
    settlementImportId: uuid("settlement_import_id")
      .notNull()
      .references(() => paymentProviderSettlementImports.id),
    bankCashAccountId: uuid("bank_cash_account_id") // denormalized from the parent import.
      .notNull()
      .references(() => bankCashAccounts.id),
    // The provider's own settlement/batch identifier — §15's identity
    // key. Free text, no format validation (same posture as every other
    // external-reference column in this schema).
    providerSettlementId: varchar("provider_settlement_id", {
      length: 100,
    }).notNull(),
    settlementDate: date("settlement_date").notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    grossAmountMinor: bigint("gross_amount_minor", {
      mode: "number",
    }).notNull(),
    feeAmountMinor: bigint("fee_amount_minor", { mode: "number" })
      .notNull()
      .default(0),
    // Signed — a positive adjustment increases net, a negative one
    // decreases it (§9 — one net figure in MVP, not itemized).
    adjustmentAmountMinor: bigint("adjustment_amount_minor", {
      mode: "number",
    })
      .notNull()
      .default(0),
    netAmountMinor: bigint("net_amount_minor", { mode: "number" }).notNull(),
    rawDescription: text("raw_description"),
    matchStatus: paymentSettlementMatchStatusEnum("match_status")
      .notNull()
      .default("UNMATCHED"), // denormalized cache — single source of truth is payment_settlement_matches.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // §17's arithmetic identity, enforced at the database level in
    // addition to parse-time validation (§14) — the "friendly check +
    // DB constraint" pattern every other invariant in this codebase
    // already uses.
    check(
      "payment_provider_settlements_arithmetic",
      sql`${t.grossAmountMinor} - ${t.feeAmountMinor} + ${t.adjustmentAmountMinor} = ${t.netAmountMinor}`,
    ),
    check(
      "payment_provider_settlements_gross_positive",
      sql`${t.grossAmountMinor} > 0`,
    ),
    // §15 — the deterministic identity key: the same provider settlement
    // ID can never be recorded twice for the same Clearing account.
    unique("pps_account_provider_settlement_id_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.bankCashAccountId,
      t.providerSettlementId,
    ),
    index("pps_import_idx").on(t.settlementImportId),
    index("pps_account_idx").on(t.bankCashAccountId),
  ],
);

export const paymentSettlementMatchTypeEnum = pgEnum(
  "payment_settlement_match_type",
  ["DETERMINISTIC_MATCH", "MANUAL"], // identical semantics to Banking-1c's own.
);
export const paymentSettlementMatchStatusStateEnum = pgEnum(
  "payment_settlement_match_state",
  ["ACTIVE", "UNDONE"],
);

export const paymentSettlementMatches = pgTable(
  "payment_settlement_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    paymentProviderSettlementId: uuid("payment_provider_settlement_id")
      .notNull()
      .references(() => paymentProviderSettlements.id),
    // References Banking-1c's EXISTING table — the one cross-boundary
    // touch (§11), additive, no change to bank_statement_lines itself.
    bankStatementLineId: uuid("bank_statement_line_id")
      .notNull()
      .references(() => bankStatementLines.id),
    matchedAmountMinor: bigint("matched_amount_minor", {
      mode: "number",
    }).notNull(), // partial-matching-capable, identical to bank_reconciliation_matches.
    matchType: paymentSettlementMatchTypeEnum("match_type").notNull(),
    status: paymentSettlementMatchStatusStateEnum("status")
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
      "payment_settlement_matches_amount_positive",
      sql`${t.matchedAmountMinor} > 0`,
    ),
    index("psm_settlement_idx").on(t.paymentProviderSettlementId),
    index("psm_bank_line_idx").on(t.bankStatementLineId),
  ],
);
```

Every field above is either reused verbatim from an existing table
(marked as such) or newly proposed and marked `NOT implemented` by this
document's own status line (§0). Nothing described as "existing" in this
section is anything other than a direct FK reference to a table already
verified present in §2.

---

## 33. Acceptance Criteria (illustrative, for a future, separately-authorized implementation turn — NOT authorized by this document)

1. Importing a valid `GENERIC_SETTLEMENT_CSV` file creates exactly one
   `payment_provider_settlement_imports` header row and N
   `payment_provider_settlements` rows, each satisfying `gross - fee +
adjustment = net`.
2. A settlement row whose declared arithmetic does not reconcile is
   rejected at parse time (`FAILED` import, per-row error); zero
   settlement records are persisted from that file.
3. Re-uploading a byte-identical file for the same Clearing Account is
   rejected (409, file-hash unique constraint) without creating a
   duplicate import.
4. A settlement whose `providerSettlementId` already exists for the same
   Clearing Account is rejected, even from a different file with a
   different hash.
5. A `payment_provider_settlements` row's `matchStatus` reflects the real
   state of its `ACTIVE` `payment_settlement_matches` rows, identically
   to Banking-1c's own `bank_statement_lines.matchStatus` computation.
6. Matching supports 1:1, 1:N, and N:1 settlement-to-bank-statement-line
   pairings, with real partial allocation; over-allocation on either side
   is rejected.
7. `create-settlement-transactions` creates exactly two DRAFT
   `bank_transactions` (TRANSFER + FEE) from one settlement record,
   pre-filled correctly; neither is ever auto-posted.
8. The Clearing Account Reconciliation report's `differenceMinor` is
   computed from the Clearing Account's real GL balance
   (`journal_lines`), never from `payment_provider_settlements` totals
   alone — an explicit test proves the two would differ if a settlement
   were imported before its TRANSFER/FEE was posted.
9. Completing settlement reconciliation requires matching completeness
   AND balance equality, independently; either alone is insufficient;
   both together succeeds.
10. Once `reconciliationStatus = COMPLETED`, raw UPDATE/DELETE against
    the relevant `payment_provider_settlements`/`payment_settlement_matches`
    rows is rejected at the DB-trigger level, verified independently,
    bypassing the application layer.
11. Tenant isolation and legal-entity isolation are verified with raw SQL,
    the same discipline `rls-hardening.e2e-spec.ts` already establishes.
12. RBAC matches §21 exactly, verified via `route-role-matrix.spec.ts`.
13. Every audit-relevant action (import, match, unmatch, complete)
    produces the correct `entityType`/`action` `audit_logs` row.
14. Currency behavior: a settlement record's `currencyCode` must match
    its Clearing Account's own; no FX conversion exists anywhere in this
    proposal.
15. Concurrent match creation against the same settlement or the same
    bank statement line cannot produce an over-allocation — verified the
    same way Banking-1c's own concurrency tests already verify this for
    `bank_reconciliation_matches`.

**No test above has been run. No implementation exists. These are stated
as acceptance criteria for a future authorized turn, not results.**

---

## 34. Implementation Sequence (for a future, separately-authorized turn — not authorized by this document)

Schema + migration + RLS + immutability triggers → DTOs + DTO unit specs
→ settlement CSV parse/validate service (with the arithmetic-identity
check) → matching-suggestion + confirm/undo service (reusing Banking-1c's
matching logic shape) → create-settlement-transactions convenience →
complete-reconciliation service → controller/module/AppModule wiring +
route-role-matrix → e2e suite → full verification sequence
(typecheck/lint/build/unit/e2e twice/independent PostgreSQL verification)
→ diff review → commit → bundle — the identical sequence every prior
Banking sub-item has already followed.

---

## STOP

This document is a proposal only. Per the discovery-gate instructions for
this turn: no `src/` file was created or modified; no `drizzle/`
migration, RLS, or constraint file was created or modified; no test file
was created or modified; `route-role-matrix.spec.ts` was not modified;
`docs/roadmap.md` was not modified; no existing Banking-1a/1b/1c/1d
implementation file was modified; nothing was committed; nothing was
pushed. Only this document,
`docs/finance-work-item-banking-1e-proposal.md`, was rewritten in place —
no second proposal file was created.

Returning this proposal for CTO review. **Implementation is complete on `main` at `f7fd9ad`. This document remains the
architecture/design record and should be read alongside the implementation commit.**
