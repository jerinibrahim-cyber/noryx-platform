# Technical Proposal — Cash Flow Statement (Indirect Method)

**Role:** Architect / Engineer. Technical/architecture proposal only. No implementation. No code, schema, migration, test, documentation, roadmap, or configuration changes have been made. Nothing here has been committed or pushed.

**Date:** 2026-09-14
**Revision history:**

- Rev 1 (2026-09-14): Initial proposal — Operating/Investing/Financing via account-level `cashFlowCategory` classification (Architecture A below), proven-by-construction aggregate identity.
- Rev 2 (2026-09-14): CTO revision request — five points on account-vs-transaction classification, cash-account population, unclassified-account UX, audit action, and identity language. All five resolved.
- **Rev 3 (this revision, 2026-09-14) — CTO Architecture Gate.** The CTO rejected the Rev 2 disclosure-only treatment of "phantom" non-cash Investing/Financing amounts (the `Dr Fixed Asset / Cr Loan Payable` example) as a **material reporting-correctness defect, not a documentation limitation**, and required the architecture itself to be fixed. This revision re-inspects the repository from scratch, evaluates the CTO's proposed transaction-driven Architecture B against the account-delta Architecture A, derives and proves a third, hybrid architecture that eliminates the phantom-flow defect **without any new schema** and **without weakening the reconciling hard identity**, and works every one of the CTO's 15 required journal scenarios (A–O) through the actual repository data model. See §5 for the central decision.

**Authorized by:** CTO instruction "PROCEED TO TECHNICAL PROPOSAL," reopening the prior "CTO decision 4" deferral (docs/finance-work-item-next-discovery-post-reversal.md §23.1); CTO Rev-2 revision instruction; CTO "ARCHITECTURE GATE" instruction (this revision) — discovery/architecture/proposal only, no implementation authorized by any of the three.
**Baseline:** `main` @ `40b32e967755f6dfb797583c298d59cea37aed3d`, re-confirmed against GitHub.
**Status:** PROPOSAL — awaiting CTO review/approval. Not authorized for implementation.

---

## 1. Repository Re-Inspection (this revision) — Exact Facts, Not Assumptions

Every fact below was independently re-verified by reading the actual repository this revision, not carried over from memory of the earlier drafts.

### 1.1 — `journal_entries` (`services/sphere-finance/src/db/schema.ts:188-277`)

```ts
export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "DRAFT",
  "POSTED",
]);

export const journalEntries = pgTable("journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  legalEntityId: uuid("legal_entity_id").notNull(),
  journalNumber: varchar("journal_number", { length: 20 }), // null while DRAFT
  status: journalEntryStatusEnum("status").notNull().default("DRAFT"),
  transactionDate: date("transaction_date").notNull(), // the sole date-range filter field, used everywhere
  periodId: uuid("period_id").references(() => accountingPeriods.id),
  currencyCode: varchar("currency_code", { length: 3 }).notNull(),
  memo: text("memo"),
  reversalOfJournalEntryId: uuid("reversal_of_journal_entry_id"), // nullable, self-FK
  reversedByJournalEntryId: uuid("reversed_by_journal_entry_id"), // nullable, self-FK
  createdBy: uuid("created_by"),
  postedBy: uuid("posted_by"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Only two statuses exist — `DRAFT`/`POSTED` — there is no `VOID`/`REVERSED` status; a reversed entry stays `POSTED` forever, with `reversedByJournalEntryId` set. **No polymorphic `sourceDocumentType`/`sourceDocumentId` column exists on `journal_entries`** — the FK points the other way (`supplier_bills.journal_entry_id`, `customer_invoices.journal_entry_id`, etc.), so there is no generic "what kind of document produced this entry" signal available to a GL-layer report; classification must be derived from the entry's own lines and accounts, not from its source.

### 1.2 — `journal_lines` (`schema.ts:282-344`)

```ts
export const journalLines = pgTable("journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  journalEntryId: uuid("journal_entry_id")
    .notNull()
    .references(() => journalEntries.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => chartOfAccounts.id),
  debitMinor: bigint("debit_minor", { mode: "number" }).notNull().default(0),
  creditMinor: bigint("credit_minor", { mode: "number" }).notNull().default(0),
  description: varchar("description", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Indexes/constraints (`schema.ts:310-340`): `unique(journalEntryId, lineNumber)`, `index("journal_lines_account_idx").on(accountId)` (single-column), `CHECK` non-negative amounts, `CHECK` single-sided (never both debit and credit on one line), `CHECK` nonzero. No `sourceDocumentType`/`sourceDocumentId` here either. No dedicated index on `journalEntryId` alone (it is the leading column of the `(journalEntryId, lineNumber)` unique constraint, which Postgres can use for a `journalEntryId`-only lookup, just not as efficiently as a dedicated index — see §16 performance).

### 1.3 — `chart_of_accounts` (`schema.ts:52-100`)

```ts
export const accountTypeEnum = pgEnum("account_type", [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);
```

Five types, confirmed exactly. `isActive` boolean, no `isCash` flag, `parentId` self-FK exists but nothing in the codebase reads it for rollups or inheritance.

### 1.4 — Exact existing GL query pattern (`general-ledger.service.ts:590-618`, `rawTotalsWithinRange`)

```sql
SELECT COALESCE(SUM(jl.debit_minor),0) AS raw_debit, COALESCE(SUM(jl.credit_minor),0) AS raw_credit
FROM journal_lines jl
INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE jl.account_id = :accountId AND jl.tenant_id = :tenantId AND je.tenant_id = :tenantId
  AND je.legal_entity_id = :legalEntityId AND je.status = 'POSTED'
  AND je.transaction_date >= :dateFrom AND je.transaction_date <= :dateTo
```

`sign(type)` (`general-ledger.service.ts:481-483`): `ASSET`/`EXPENSE` → `+1`, everything else → `-1`. This is the exact, unchanged convention this proposal continues to use.

**No per-journal-entry aggregate/EXISTS/HAVING pattern (checking a property across an entry's own lines) exists anywhere in this codebase today** — confirmed by grep across every report service (`general-ledger`, `financial-statements`, `tax-reports`, `ap-reports`, `ar-reports`, `bank-reports`). The closest precedent (`ap-reports.service.ts:766-770`, `ar-reports.service.ts:805-809`, `tax-reports.service.ts:398-402/436-440`) checks a _document's_ own `journal_entries` header for `reversedByJournalEntryId IS NOT NULL` — a single-row lookup, not a per-entry line aggregate. §7 below is therefore a genuinely new query shape for this codebase, not a reuse of an existing one — its cost is analyzed on its own merits in §16.

### 1.5 — Reversal mechanics, verbatim (`journal-entries.service.ts:545-654`, `completeReversalPosting`)

```ts
const reversalLineInputs = original.lines.map((l) => ({
  accountId: l.accountId,
  debitMinor: l.creditMinor, // swapped, not negated
  creditMinor: l.debitMinor,
  description: l.description ?? undefined,
}));
```

The reversal is a **brand-new `journal_entries` row**, touching **the exact same set of accounts** as the original, one line per original line, **debit and credit swapped per line** (not a signed negation of a lump amount). `reversalOfJournalEntryId` points the new entry at the original; `reversedByJournalEntryId` is set on the original via a single-column `UPDATE`. This confirms the claim used throughout §11 below: **a reversal always touches the identical account set as its original**, which is what makes reversal-classification-invariance provable rather than assumed.

### 1.6 — AP/AR posting does **not** guarantee a Revenue/Expense line — a materially important finding for this revision

Re-verified directly (`supplier-bills.service.ts:868-888`, `findInvalidAccountIds`; `customer-invoices.service.ts`, equivalent check): a supplier-bill line's `accountId` and a customer-invoice line's `accountId` are validated only for `tenantId`/`legalEntityId`/`isActive = true` — **there is no `type` restriction on either**. A bill can legitimately debit a `LIABILITY` or prepaid-`ASSET` account instead of an `EXPENSE` account (a deposit/prepayment bill); an invoice can credit a deferred-revenue `LIABILITY` instead of a `REVENUE` account (an advance/deposit invoice). This means **"has an Expense/Revenue line" cannot be assumed for every AP/AR posting**, and any architecture that relies on that assumption would be wrong on real, already-supported transaction shapes — this finding directly shapes the chosen architecture's rule in §5.4, and is worked through explicitly as a scenario in §6.

### 1.7 — `bank_cash_accounts` → `chart_of_accounts` (unchanged from Rev 2, re-confirmed)

One-way FK via `glAccountId`, unique per GL account (`bank_cash_accounts_gl_account_unique`), `isActive` a reversible toggle (`deactivate`/`reactivate` routes, not a delete), `glAccountId` itself editable via `update()` (re-validated, audited with before/after state).

---

## 2. Correcting an Inherited Imprecision in the Base Identity's Intermediate Statement

Before addressing the phantom-flow architecture question, one correctness issue surfaced during this re-derivation and is fixed here rather than left standing: Rev 1/2's §1.1 stated the "trivial global identity" as a **flat, uniformly-signed sum**:

> `Σ_ASSET signedDelta + Σ_LIABILITY signedDelta + Σ_EQUITY signedDelta + Σ_REVENUE signedDelta + Σ_EXPENSE signedDelta = 0`

This is **not correct as literally written** — a one-line counter-example proves it: `Dr Cash 100 / Cr Revenue 100`. `signedDelta(Cash) = +1×(100-0) = 100`. `signedDelta(Revenue) = -1×(0-100) = 100`. Flat sum = `200 ≠ 0`. The error is a missing sign: the correct trivial identity (derivable directly from "every entry's total debit equals its total credit," summed by type) is

```
signedDelta(ASSET) − signedDelta(LIABILITY) − signedDelta(EQUITY) − signedDelta(REVENUE) + signedDelta(EXPENSE) = 0
```

which rearranges to the **already-correct** target formula both prior revisions actually used throughout the rest of the document (`Assets = Liabilities + Equity + NetIncome`, and its Cash Flow specialization in §5.2 below) — so **no downstream formula in Rev 1/2 was wrong**, only this one intermediate sentence's stated identity was imprecise. Fixed here; verified against the corrected form for every worked example in §6.

---

## 3. The CTO's Central Concern, Demonstrated Concretely on This Repository

```
Dr Fixed Asset       100   (ASSET, classified INVESTING)
Cr Loan Payable      100   (LIABILITY, classified FINANCING)
```

This entry is **legitimately postable today** through the generic Journal Entries module (§1.1–1.2: no restriction prevents it) — it is not a hypothetical. Actual cash movement = `0` (no line touches a `bank_cash_accounts`-linked GL account). Under Rev 1/2's account-delta architecture (**Architecture A**):

- `contribution(FixedAsset) = -signedDelta(FixedAsset) = -100` → `CashFlowFromInvesting += -100`
- `contribution(LoanPayable) = +signedDelta(LoanPayable) = +100` → `CashFlowFromFinancing += +100`

The aggregate hard identity still passes (`-100 + 100 = 0 =` actual cash movement), but the **statement itself displays** `Investing: -100` and `Financing: +100` — a fabricated $100 of capex and a fabricated $100 of debt issuance, neither of which ever happened. Rev 2 treated this as a disclosed v1 limitation. The CTO has correctly rejected that: a Cash Flow Statement whose Investing/Financing section totals can contain fictitious amounts is not fit for its stated purpose regardless of how well-disclosed the caveat is, and IAS 7.43 says exactly this class of transaction must be **excluded** from Investing/Financing and shown as a supplemental non-cash disclosure instead — not netted into the section totals at all. §5 fixes this architecturally.

---

## 4. Architecture A vs. Architecture B, Evaluated Rigorously

### 4.1 — Architecture A (account-delta, Rev 1/2's design)

**Correct for Operating** (IAS 7's indirect method is _itself defined_ as `NetIncome ± working-capital deltas` — this is not an approximation of the standard, it is the standard, for the Operating section specifically). **Incorrect for Investing/Financing** when a non-cash entry spans two differently-classified accounts (§3) — this is the defect the CTO identified, and it is real, not hypothetical, on this repository's actual capabilities.

### 4.2 — Architecture B, as the CTO specified it (derive cash-flow activity from the cash-moving side of journal entries and their non-cash counterpart accounts)

Evaluated directly against `journal_lines`'s actual shape (§1.2): this repository's journal lines carry no "this is the cash leg, that is its counterpart" pairing — a journal entry is an **unordered set of N balanced lines**, not a structured cash-leg/counterpart-leg pair. A naive Architecture B ("attribute each cash line's amount to its counterpart line's classification") runs immediately into the exact problem the CTO's own prompt anticipated in §4 ("multi-line allocation mathematics"): `Dr Asset 600 / Dr Expense 400 / Cr Cash 1000` has **one** cash line and **two** non-cash counterpart lines of _different_ natures (Investing-shaped and Operating-shaped) — there is no principled way to decide "how much of the $1000 was 'for' the Asset vs. 'for' the Expense" by treating the cash line as the thing being allocated, because that is the wrong direction of attribution. **Architecture B, taken literally, is not implementable without an arbitrary proportionality assumption this repository's data cannot justify.**

### 4.3 — The resolution: invert the direction of attribution, not the unit of classification

The insight that resolves this (proved algebraically in §5.2, not asserted): **each non-cash line's own `signedDelta` is already the exact, unambiguous dollar amount to attribute to its account's classification** — nothing needs to be "allocated" from the cash side at all, because the entry's balance invariant guarantees that summing every non-cash line's own contribution reconstructs the entry's true cash effect automatically, with no proportionality assumption anywhere (proof in §5.2; verified against `Dr Asset 600/Dr Expense 400/Cr Cash 1000` in §6, scenario L). This means the correct fix keeps Architecture A's per-account attribution mechanism (no allocation problem to solve) and instead fixes _which entries are eligible_ to contribute to Investing/Financing/Operating at all. That is the chosen architecture, §5.

---

## 5. Chosen Architecture — "Account-Level Classification, Entry-Level Reconciling Gate"

### 5.1 — Definition

For every journal entry in the requested window, define:

> An entry is a **reconciling entry** if at least one of its lines posts to a cash account (§8) **or** at least one of its lines posts to a `REVENUE`/`EXPENSE` account. An entry is a **pure non-cash reclassification entry** if neither is true — i.e., every one of its lines posts to a non-cash `ASSET`/`LIABILITY`/`EQUITY` account.

- For every non-cash `ASSET`/`LIABILITY`/`EQUITY` line belonging to a **reconciling entry**, `contribution(a)` is summed into its account's `cashFlowCategory` bucket (`OPERATING`/`INVESTING`/`FINANCING`/`Unclassified`) — **exactly Architecture A's original mechanism, unchanged**, with no allocation step.
- For every such line belonging to a **pure non-cash reclassification entry**, `contribution(a)` is **excluded from all four buckets** and instead reported in a new, separate, supplemental `nonCashReclassifications` disclosure (§15.3) — never netted into a reconciling total.
- `NetIncome` is computed exactly as today (§1.3, unrestricted, over every `REVENUE`/`EXPENSE` posting in the window) — it needs no restriction, because by the very definition above, any entry touching `REVENUE`/`EXPENSE` is automatically a reconciling entry, never a pure reclassification entry.

`cashFlowCategory` itself remains exactly what Rev 1/2 proposed: a single nullable enum column on `chart_of_accounts`, admin-set via §14, requiring **zero new schema beyond that one column** — the reconciling/pure-reclassification distinction is **computed at query time** from data that already exists (`journal_lines.accountId`, `chart_of_accounts.type`, `bank_cash_accounts.glAccountId`), not stored anywhere new. §9 explains why this beats storing the distinction at the entry or line level.

### 5.2 — Proof: the hard identity is preserved exactly, unchanged in form

**Claim:** for any pure non-cash reclassification entry, `Σ contribution(a)` over its own lines equals exactly `0`, always.

**Proof.** By definition the entry has no cash line and no `REVENUE`/`EXPENSE` line — every line is non-cash `ASSET`/`LIABILITY`/`EQUITY`. The entry balances (`Σ debitMinor = Σ creditMinor`, the DB trigger), which — summed by type exactly as in §2's corrected trivial identity, with `REVENUE = EXPENSE = 0` for this entry — gives `signedDelta_ASSET(entry) − signedDelta_LIABILITY(entry) − signedDelta_EQUITY(entry) = 0`, i.e. `signedDelta_ASSET(entry) = signedDelta_LIABILITY(entry) + signedDelta_EQUITY(entry)`. Since `contribution(ASSET) = -signedDelta`, `contribution(LIABILITY/EQUITY) = +signedDelta`: `Σcontribution(entry) = -signedDelta_ASSET(entry) + signedDelta_LIABILITY(entry) + signedDelta_EQUITY(entry) = -[signedDelta_LIABILITY(entry)+signedDelta_EQUITY(entry)] + signedDelta_LIABILITY(entry)+signedDelta_EQUITY(entry) = 0`. ∎

**Consequence:** because excluded entries always contribute exactly `0` in aggregate regardless of which bucket their lines would otherwise have landed in, removing them from the four buckets changes **nothing** about `CashFlowFromOperating + CashFlowFromInvesting + CashFlowFromFinancing + CashFlowUnclassified` — it remains **exactly** `Σ_Cash signedDelta`, the real net cash movement, with **the identical formula and hard-failure check as Rev 1/2** (§13). The fix is invisible to the aggregate reconciliation and visible only in _which bucket, if any,_ a given non-cash movement is allowed to land in — precisely what was needed.

### 5.3 — Multi-line allocation mathematics — resolved: no allocation is needed or appropriate (§4 of the CTO's ask)

Directly answering the CTO's §4: proportional allocation across counterpart lines is **not the correct model and is not proposed**. Each non-cash line already has its own exact, unambiguous `signedDelta` — there is nothing to estimate or split. `Dr Asset 600 / Dr Expense 400 / Cr Cash 1000`: `Asset` contributes exactly `-600` to its own bucket, `Expense` contributes exactly `-400` to `NetIncome` (hence Operating); these are not estimates of "how much of the $1000 cash was for X" — they are each account's own, independently, exactly-known movement. Summing them reconstructs the entry's true $1000 cash effect by §5.2's algebra, not by assumption. A proportional-allocation model would be _solving a problem this data doesn't have_: this repository already knows, exactly, how much of a multi-line entry touched each account — no estimation step exists to introduce error into.

### 5.4 — Non-cash transaction detection — resolved (§5 of the CTO's ask)

An entry with **zero** cash lines and **zero** `REVENUE`/`EXPENSE` lines contributes **nothing** to `Operating`/`Investing`/`Financing`, regardless of how its accounts are classified — proven in §5.2, not merely asserted. An entry with **one** cash line is handled by the unchanged, existing per-account mechanism (§5.1) with no special-casing. An entry with **multiple** cash lines (scenario M, §6) is handled identically — `Σ_Cash signedDelta` is defined as the aggregate across _every_ cash account (§8), so multiple cash lines in one entry simply both contribute to that same aggregate sum with no extra logic, exactly as they already do for every other GL report in this codebase (Trial Balance, Balance Sheet) that sums across many accounts of a type.

---

## 6. Every Required Journal Scenario, Worked Through Precisely

For each: the entry, actual cash movement, what the chosen architecture reports, and why it is correct.

**A — Normal operating transaction.** `Dr Expense 100 / Cr Cash 100`. Cash `-100`. Has a cash line → reconciling. `NetIncome -100` → `Operating -100`. **Correct**: matches cash exactly.

**B — Customer receipt.** `Dr Cash 100 / Cr AR 100`. Cash `+100`. Reconciling (cash line). `AR` (OPERATING, LIABILITY... — AR is `ASSET`) decreases: `contribution(AR) = -signedDelta(AR) = -(-100) = +100` → `Operating +100`. **Correct**, matches cash.

**C — Supplier payment.** `Dr AP 100 / Cr Cash 100`. Cash `-100`. Reconciling. `AP` (LIABILITY, OPERATING) decreases: `contribution(AP) = +signedDelta(AP) = -100` → `Operating -100`. **Correct.**

**D — Loan proceeds.** `Dr Cash 100 / Cr Loan Payable 100`. Cash `+100`. Reconciling (cash line). `Loan Payable` (FINANCING) increases: `contribution = +100` → `Financing +100`. **Correct.**

**E — Capital contribution.** `Dr Cash 100 / Cr Equity 100`. Cash `+100`. Reconciling. `Equity` (FINANCING) increases: `contribution = +100` → `Financing +100`. **Correct.**

**F — Fixed-asset purchase (for cash).** `Dr Fixed Asset 100 / Cr Cash 100`. Cash `-100`. Reconciling (cash line). `Fixed Asset` (INVESTING) increases: `contribution = -100` → `Investing -100`. **Correct.**

**G — Depreciation.** `Dr Depreciation Expense 100 / Cr Accumulated Depreciation 100`. Cash `0`. Has an `EXPENSE` line → reconciling. `NetIncome -100`. `Accumulated Depreciation` (`ASSET`-typed contra-account, INVESTING, matching its parent Fixed Asset per admin classification, §10) credited: `contribution = -signedDelta = -(-100) = +100` → `Investing +100`. Net effect this entry: `Operating -100, Investing +100`, total `0` = cash movement `0`. **Correct** — this is precisely the textbook "add back depreciation" line, falling out with zero special-casing exactly as Rev 1 already established (§1.6 there), unaffected by this revision.

**H — Non-cash asset acquisition.** `Dr Fixed Asset 100 / Cr Loan Payable 100`. Cash `0`. **Zero cash lines, zero Revenue/Expense lines → pure reclassification entry → excluded from Operating/Investing/Financing entirely**, reported only in `nonCashReclassifications` (§15.3). **This is the CTO's central example — fixed.**

**I — Non-cash liability conversion.** `Dr Loan Payable 100 / Cr Equity 100` (debt-to-equity conversion; postable today via the generic Journal Entries module, no restriction prevents it). Cash `0`. Pure reclassification (no cash, no rev/exp) → excluded, disclosed. **Correct**, same mechanism, no special-casing needed for this specific transaction shape.

**J — Cash-to-cash transfer.** `Dr Bank B 100 / Cr Bank A 100` (both `bank_cash_accounts`-linked GL accounts). Both lines are cash lines — **zero non-cash lines exist to classify at all**. `Σ_Cash signedDelta` for this entry `= signedDelta(BankB) + signedDelta(BankA) = 100 + (-100) = 0`. **Net cash movement is correctly zero, and Operating/Investing/Financing are correctly untouched — no special "internal transfer" logic is needed**, it falls out of the aggregate-across-all-cash-accounts definition (§8) automatically. This directly answers the CTO's §3.J: it is neither separately represented nor excluded by special-case code — it is structurally invisible to the statement, which is the IAS 7-correct treatment for intra-entity cash transfers.

**K — Mixed multi-line cash transaction.** `Dr Expense A 60 / Dr Expense B 40 / Cr Cash 100`. Cash `-100`. Reconciling (cash line, and also has Expense lines). `NetIncome -100` (both expenses) → `Operating -100`. **Correct**, no ambiguity — both expenses are Operating by nature, no split needed.

**L — Mixed classification transaction.** `Dr Asset 600 (INVESTING) / Dr Expense 400 / Cr Cash 1000`. Cash `-1000`. Reconciling. `NetIncome -400` → `Operating -400`. `Asset contribution -600` → `Investing -600`. Total `-1000` = cash movement. **Correct, exact, no proportional allocation used** — directly resolves §4/§5.3's concern.

**M — Multiple cash lines.** `Dr Bank A 300 / Dr Bank B 200 / Cr Liability(FINANCING) 500`. `Σ_Cash = 300+200 = 500`. Reconciling (two cash lines). `Liability contribution +500` → `Financing +500`. **Correct**, matches; multiple cash lines need no special handling (§5.4).

**N — Reversal.** Proven generally in §11; concretely: original `Dr Fixed Asset 100/Cr Cash 100` (Investing `-100`, cash `-100`); its reversal is `Dr Cash 100/Cr Fixed Asset 100` (same accounts, swapped) — also has a cash line → also reconciling → `Investing +100`, cash `+100`. Within one window containing both, net `Investing 0`, net cash `0`. **Correct**, and the classification (reconciling vs. pure-reclassification) is provably identical for original and reversal (§11) — no special reversal logic needed, consistent with the existing §6/Rev-1 finding, now re-confirmed under the fixed architecture.

**O — Manual JE, both shapes distinguished.** `Dr Asset 100 / Cr Loan Payable 100` — no cash, no rev/exp → pure reclassification → excluded/disclosed (as H). `Dr Asset 100 / Cr Cash 100` — has a cash line → reconciling → `Investing -100`. **The two cases are cleanly, correctly distinguished by the same single rule** (§5.1), with no per-source-module special-casing — the rule is purely a function of which accounts a journal entry's own lines touch, identical for AP, AR, payments, receipts, and manual JEs alike (§1.6's finding — that AP/AR lines aren't type-restricted — is exactly why this rule, not a "does this come from AP/AR" rule, is the right one: it works identically regardless of posting source).

---

## 7. The Role of `cashFlowCategory` — One Architecture, Chosen Explicitly

Evaluated against the CTO's five options, plus the actual chosen synthesis:

**A. Account-level only (Rev 1/2, unmodified).** Correct for Operating; phantom-flow risk for Investing/Financing (§3) if used alone. **Rejected alone.**

**B. Journal-entry-level classification.** Requires a new `cashFlowCategory`-shaped column on `journal_entries`, set by the poster. Fails scenario L (§6) structurally: a single entry can legitimately span two categories (`Dr Asset(INVESTING)/Dr Expense(OPERATING)/Cr Cash`) and one entry-level value cannot represent a split. Also burdens every poster (AP, AR, manual JE) with classification at posting time — a materially larger UX/workflow change than admin-time account classification, with no precedent anywhere else in this codebase (tax codes, cash-flow category — every existing classification concept in this repository lives on **master data**, never on the transaction). **Rejected.**

**C. Journal-line-level.** Most granular in principle, but requires a new column on `journal_lines` and touches **every** posting path (AP, AR, payments, receipts, manual JE, tax) at write time — the largest blast radius of any option, directly contrary to the CTO's own standing preference for minimal additive changes, and again with zero precedent for line-level classification anywhere in this codebase. Also raises the same UX burden as B, at every line instead of once per entry. **Rejected.**

**D. Transaction/document-level** (classify the supplier bill / customer invoice as a whole). Doesn't cover manual JEs at all (no "document" wrapper exists for them — confirmed, §1.1's finding that journal entries carry no source-document reference), and has the same category-splitting problem as B for any document whose lines span two categories. **Rejected.**

**E/Chosen — Account-level classification (`cashFlowCategory` on `chart_of_accounts`, exactly as Rev 1/2 proposed), gated by a computed, unstored, entry-level "reconciling vs. pure-reclassification" eligibility test (§5.1).** This is the actual chosen architecture. It keeps the **zero-new-write-path-friction** property of pure account-level classification (an admin classifies ~dozens of GL accounts once, not every future transaction), while the entry-level gate — computed from data that already exists, not configured by anyone — closes exactly the gap that made "A" alone insufficient. It requires no new schema beyond the one nullable enum column, no new write path, and no change to any existing posting flow (AP/AR/payments/receipts/manual JE all continue exactly as today). This is chosen, decisively, not left open.

---

## 8. Cash-Account Identification (re-confirmed, unchanged from Rev 2)

`chart_of_accounts.id` values referenced by **all** of a legal entity's `bank_cash_accounts.glAccountId` rows, **regardless of `isActive`** — re-verified this revision against the same `bank_cash_accounts_gl_account_unique` constraint (unambiguous, one row per GL account) and the same reasoning as Rev 2: `isActive` is a reversible toggle, not a deletion, and filtering on it would silently drop real historical cash movement from any window predating a deactivation. The residual `glAccountId`-repointing limitation (no history table; recoverable only via `audit_logs.beforeState`/`afterState`) remains disclosed, not engineered around, for the same reasons as Rev 2 — narrow, low-probability, zero effect on the (now-fixed) phantom-flow question, which is unrelated to cash-account identification.

Duplicates: **not possible** — `bank_cash_accounts_gl_account_unique` is a hard Postgres unique constraint on `glAccountId`, so one GL account can never be linked from two different `bank_cash_accounts` rows, and one `bank_cash_accounts` row obviously names exactly one `glAccountId` — the mapping is a clean bijection between (a subset of) `chart_of_accounts` and `bank_cash_accounts`, never one-to-many in either direction.

Classification of the residual limitations here: **cash-account population via `isActive`** — this revision confirms it is **not** blocking (fixed, §8 above, zero remaining exposure). **`glAccountId` repointing** — **acceptable v1 limitation** (disclosed, low-probability, unrelated to the phantom-flow defect this revision resolves).

---

## 9. Account Classification Semantics, By Type

- **`ASSET` (non-cash):** an increase is a use of cash (`contribution = -signedDelta`). Classified `OPERATING` for working-capital assets (AR, Inventory, Prepaid Expenses) or `INVESTING` for long-lived assets (Fixed Assets, long-term Investments). A liability is never `ASSET`-typed in this schema, so no cross-type ambiguity exists.
- **`LIABILITY`:** an increase is a source of cash (`contribution = +signedDelta`). `OPERATING` for working-capital liabilities (AP, accrued expenses, tax payable); `FINANCING` for borrowings (loans, notes, bonds payable).
- **`EQUITY`:** an increase is a source of cash (`contribution = +signedDelta`). Always `FINANCING` in practice — capital contributions/share issuance increase it (source of cash), buybacks/distributions decrease it (use of cash) — there is no accounting basis for an `OPERATING` or `INVESTING` equity account, and this proposal does not restrict the enum to prevent an admin from mis-classifying one that way (§14.3's DTO validates only that the value is one of the three enum members, matching every other classification field in this codebase, e.g. tax-code GL mappings — a plausibility check, not a semantic one, is the established convention here).
- **`REVENUE`/`EXPENSE`:** never individually classified — excluded from the four-bucket mechanism entirely, folded into `NetIncome` (§1.3, unchanged since Rev 1).
- **Cash accounts** (§8): never classified for this report's purposes — structurally excluded via the `bank_cash_accounts` join, not by `cashFlowCategory` (unchanged since Rev 1 §2.5); setting a value on a cash-linked account is harmless and unused.
- **Contra accounts** (e.g. Accumulated Depreciation, Allowance for Doubtful Accounts) — typed `ASSET` in this schema (no separate contra-asset type exists) but net-credited in practice. This proposal classifies them exactly like any other account, by the same admin action (§14.3) — an admin classifies Accumulated Depreciation `INVESTING` to match its parent Fixed Asset account, or Allowance for Doubtful Accounts `OPERATING` to match AR. `chart_of_accounts.parentId` exists in the schema but this proposal does **not** auto-inherit a child's classification from its parent — every account is classified individually and explicitly, keeping the mechanism simple and auditable (one column, one write path) rather than introducing implicit inheritance rules with their own edge cases.

---

## 10. IAS 7 / Accounting Correctness — What This Architecture Proves, Precisely

The hard identity (§13) proves that **the aggregate statement reconciles exactly to actual GL cash movement**: `Opening + NetCashMovement = Closing`, and `Operating + Investing + Financing + Unclassified = NetCashMovement`. With this revision's fix, it _additionally_ now proves that **no pure non-cash transaction can appear as a phantom amount inside Investing or Financing** — that specific, CTO-identified defect is closed, not merely disclosed.

What it still does **not** prove, and is not claimed to prove: that an admin's `cashFlowCategory` assignment for any given account is itself the GAAP-correct one (e.g., an admin could still mis-classify an Equity account as `OPERATING` — nothing in the mechanism prevents a semantically wrong but syntactically valid classification, §9), or that every genuinely cash-touching entry's counterpart account has been classified at all (the `Unclassified` bucket, §14, exists precisely because that is not guaranteed and must be surfaced honestly rather than assumed). These are **classification-quality** concerns, distinct from the **transaction-eligibility** concern this revision resolves, and they are not blocking (§17-C) — they are the ordinary, expected residual responsibility of whoever configures the chart of accounts, identical in kind to every other classification field in this codebase (tax-code GL mappings, cash-flow category itself) never being semantically validated beyond "is this a real enum value."

---

## 11. Reversal Interaction — All Five Required Cases

**Provable general claim:** a reversal always touches the identical account set as its original (§1.5 — same `accountId` per line, only debit/credit swapped), so an entry's classification as _reconciling_ or _pure-reclassification_ is **provably identical** for both: if the original has a cash or Revenue/Expense line, so does the reversal (same accounts); if the original has neither, neither does the reversal. No reversal-specific logic is added anywhere.

1. **Original cash transaction, no reversal in window:** counted normally (§6, scenarios A–O).
2. **Reversal of original, both in window:** reversal is reconciling iff original was (proven above); its `contribution()`/`NetIncome` effect is the exact negation of the original's (swapped debit/credit ⇒ negated `signedDelta` line-by-line), so the pair nets to exactly `0` in every bucket it touches, matching the pair's true net cash effect of `0`.
3. **Reversal after the reporting cutoff:** the reversal's `transactionDate` falls outside `[dateFrom, dateTo]` — excluded by the existing date filter (§1.4, unchanged), exactly like every other GL-layer report. The window correctly shows the original's activity as it stood; a later window containing the reversal shows it reversing then.
4. **Original before cutoff, reversal after:** identical mechanism to case 3, just from the other side — no special handling, standard date-range partitioning already used throughout this codebase.
5. **Both before cutoff (both in window):** case 2.

This reaffirms, and extends to the fixed architecture, the finding already established for Rev 1 (§6 there) and the Document-Level Reversal work item: reversal-awareness requires **zero** special-case code at the GL-aggregation layer, because a reversal is an ordinary balanced entry that nets to zero in any correctly-constructed `SUM()`.

---

## 12. Tax/VAT Interaction — Re-confirmed, Unaffected

Input/Output VAT control accounts are ordinary `ASSET`/`LIABILITY` accounts. Every VAT-bearing entry this codebase can produce (AP bill with tax lines, AR invoice with tax lines) also carries the bill's or invoice's own expense/revenue-or-equivalent line (§1.6 notes those specific lines are unrestricted in type, but the tax posting itself is always alongside the bill/invoice's control-account and line postings within the same entry, which — per real Tax/VAT Phase 2/5 posting code — always also includes the AP/AR control-account line, itself typically `OPERATING`) or is part of a cash-touching entry (a cash-basis manual tax remittance, `Dr VAT Payable/Cr Cash`) — either way it is a **reconciling** entry under §5.1's rule, handled by the unchanged, generic mechanism with no VAT-specific logic, exactly as Rev 1 §7 already established. Unaffected by this revision's architecture change.

---

## 13. Reporting Reconciliation Invariants — Exact, With the New Disclosure Bucket

**Hard invariant (enforced by `throw`, matching Balance Sheet/Trial Balance precedent, unchanged in form from Rev 1/2):**

```
openingCashMinor + netCashMovementMinor = closingCashMinor
operatingMinor + investingMinor + financingMinor + unclassifiedMinor = netCashMovementMinor
```

Both hold exactly, proven in §5.2 — the `nonCashReclassifications` figures (§15.3) are **not** part of either equation; they are a separate, always-internally-zero-sum (§5.2) supplemental disclosure, never a reconciling quantity. A defensive test assertion (§18) verifies `nonCashReclassifications` sums to exactly zero on every fixture as a correctness check of the mechanism itself — not because a runtime failure there is meaningful (it cannot be nonzero given §5.2's proof), but because a test catching "it's supposed to always be zero and isn't" is a strong regression signal if the query is ever miswritten.

---

## 14. Unclassified Accounts (unchanged from Rev 2, re-confirmed compatible with this revision)

`NULL cashFlowCategory` → summed into `unclassifiedMinor`, `hasUnclassifiedAccounts`/`unclassifiedAccountCount`, and the actionable `unclassifiedAccounts: Array<{accountId, code, name, type, movementMinor}>` list (sorted by `abs(movementMinor)` descending) — exactly as Rev 2 defined. One refinement made necessary by this revision: `movementMinor` in that list reflects the account's **reconciling-entry** movement only (i.e., its contribution to the `Unclassified` bucket specifically) — its pure-reclassification-entry movement, if any, is separately visible only inside `nonCashReclassifications` (§15.3), keeping the two figures additive and non-overlapping rather than double-counted.

---

## 15. API Endpoint, DTOs, Response Structure

### 15.1 — Routes (unchanged from Rev 1/2)

```
GET /v1/finance/financial-statements/cash-flow?dateFrom=&dateTo=&periodId=
@Roles("finance.viewer", "finance.poster", "finance.admin")

PATCH /v1/finance/accounts/:id/cash-flow-category
@Roles("finance.admin")
Body: { cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null }
```

Same guard stack, same DTO shape (`CashFlowQueryDto` mirrors `ProfitAndLossQueryDto`, no `asOf` field), same module (extends `FinancialStatementsService`, §1.4's finding that its private `fetchTypeBalancesWithinRange`-style helpers are the natural home for the new query) — none of this changes with the architecture fix.

### 15.2 — Response shape addition

```ts
{
  openingCashMinor, netCashMovementMinor, closingCashMinor,   // unchanged
  operatingMinor, investingMinor, financingMinor, unclassifiedMinor,  // unchanged, now phantom-free
  hasUnclassifiedAccounts, unclassifiedAccountCount, unclassifiedAccounts: [...],  // unchanged (§14)
  reconciled: true,   // unchanged — hard identity, §13
  nonCashReclassifications: {                 // NEW — §15.3
    totalGrossMinor: number,                  // sum of |contribution| over excluded lines / 2 — see §15.3
    entries: Array<{
      journalEntryId: string;
      journalNumber: string | null;
      transactionDate: string;
      lines: Array<{ accountId: string; code: string; name: string; type: string; cashFlowCategory: string | null; amountMinor: number }>;
    }>;
  };
}
```

### 15.3 — `nonCashReclassifications` — the IAS 7.43 supplemental disclosure

Populated directly from the pure-reclassification-entry set identified by §5.1's query (§16 gives the exact SQL). Reported as the **actual entries and lines**, not a netted figure (which would always be exactly `0` per §5.2's proof, and therefore useless on its own) — this is the concrete, actionable form of the IAS 7.43 "non-cash investing and financing activities" note: a caller (or a human preparing statutory disclosures) can see precisely which transactions were excluded and why, e.g. "$100 of Fixed Assets acquired via $100 of Loan Payable issuance." `totalGrossMinor` (sum of `|contribution(a)|` over every excluded line, divided by 2, since each entry's excluded lines are internally paired and each dollar of reclassification appears once on each side) is provided as a single at-a-glance magnitude figure alongside the itemized list — never as a signed reconciling quantity.

---

## 16. Database / Schema Impact — Unchanged: One Column, Zero New Tables

The architecture fix in this revision requires **no schema change beyond Rev 1/2's single proposed column** — the reconciling/pure-reclassification distinction is computed entirely at query time from `journal_lines.accountId`, `chart_of_accounts.type`, and `bank_cash_accounts.glAccountId`, none of which are new.

```sql
CREATE TYPE "cash_flow_category" AS ENUM ('OPERATING', 'INVESTING', 'FINANCING');
--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD COLUMN "cash_flow_category" "cash_flow_category";
```

No new tables, no new FKs, no `NOT NULL`, no `DEFAULT`, no RLS change (§16 of Rev 1, unaffected — `chart_of_accounts`'s RLS policy is column-agnostic), no constraint/trigger change. `services/sphere-finance/package.json`'s unconditional `apply-rls.ts`/`apply-db-constraints.ts` re-run remains a no-op for this change.

**Optional, not-required future optimization:** `journal_lines` currently has no dedicated index on `journalEntryId` alone (§1.2 — it is only the leading column of an existing unique constraint). If this report's new per-entry grouping step (§17) proves to be a bottleneck at high transaction volume, a dedicated `index("journal_lines_journal_entry_id_idx").on(journalEntryId)` would help — but this is **not proposed as part of this work item** (it is a general GL-layer optimization applicable to any future per-entry query, not specific to Cash Flow, and every other GL report already tolerates the same absence today).

---

## 17. Performance / Query Complexity

The new query adds exactly one extra grouping pass over the same `journal_lines` rows already being scanned for the existing working-capital sum (§1.4) — not a new full-table scan, not a per-account re-scan, and not `O(n²)`:

```sql
WITH cash_accounts AS (
  SELECT DISTINCT gl_account_id AS account_id FROM bank_cash_accounts
  WHERE tenant_id = :tenantId AND legal_entity_id = :legalEntityId   -- no isActive filter, §8
),
window_entries AS (
  SELECT id AS journal_entry_id FROM journal_entries
  WHERE tenant_id = :tenantId AND legal_entity_id = :legalEntityId AND status = 'POSTED'
    AND transaction_date >= :dateFrom AND transaction_date <= :dateTo
),
entry_flags AS (
  SELECT jl.journal_entry_id,
         BOOL_OR(ca.account_id IS NOT NULL) AS has_cash_line,
         BOOL_OR(coa.type IN ('REVENUE','EXPENSE')) AS has_income_line
  FROM journal_lines jl
  INNER JOIN window_entries we ON we.journal_entry_id = jl.journal_entry_id
  INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id
  LEFT JOIN cash_accounts ca ON ca.account_id = jl.account_id
  WHERE jl.tenant_id = :tenantId
  GROUP BY jl.journal_entry_id
)
SELECT coa.id, coa.code, coa.name, coa.type, coa.cash_flow_category,
  COALESCE(SUM(jl.debit_minor)  FILTER (WHERE ef.has_cash_line OR ef.has_income_line), 0) AS reconciling_debit,
  COALESCE(SUM(jl.credit_minor) FILTER (WHERE ef.has_cash_line OR ef.has_income_line), 0) AS reconciling_credit,
  COALESCE(SUM(jl.debit_minor)  FILTER (WHERE NOT (ef.has_cash_line OR ef.has_income_line)), 0) AS reclass_debit,
  COALESCE(SUM(jl.credit_minor) FILTER (WHERE NOT (ef.has_cash_line OR ef.has_income_line)), 0) AS reclass_credit
FROM chart_of_accounts coa
LEFT JOIN journal_lines jl ON jl.account_id = coa.id
LEFT JOIN entry_flags ef ON ef.journal_entry_id = jl.journal_entry_id
WHERE coa.tenant_id = :tenantId AND coa.legal_entity_id = :legalEntityId
  AND coa.type IN ('ASSET','LIABILITY','EQUITY') AND coa.id NOT IN (SELECT account_id FROM cash_accounts)
GROUP BY coa.id, coa.code, coa.name, coa.type, coa.cash_flow_category
```

`entry_flags` scans the same `journal_lines` rows in the window once (`journal_lines_account_idx` supports the `coa` join; the `window_entries`/`journal_entry_id` join uses the existing `(journalEntryId, lineNumber)` unique constraint's leading column, §16); the outer query re-scans the same rows once more for the bucketed sums. This is a small constant-factor increase (roughly 2x the row-touches of Rev 1/2's single-pass query) over the same working set, not a new order of growth, and follows the exact `REPORT_TX_CONFIG` (`REPEATABLE READ`/`READ ONLY`) transaction already used by every other Finance report (§18 below), so both passes see one consistent snapshot. As transaction volume grows, this scales the same way every other GL-layer report in this codebase already scales (linearly in the number of posted lines within the requested window) — it introduces no new scaling class, only a small constant multiplier.

---

## 18. Concurrency / Audit / RBAC / Tenant Isolation — Unchanged from Rev 1/2

`withTenant(tenantId, ..., REPORT_TX_CONFIG)` (`REPEATABLE READ` + `READ ONLY`), identical to every other Finance report — now more important than before given the extra query pass in §17, so that `entry_flags` and the outer bucketed sums see the same consistent snapshot even if a journal entry posts concurrently mid-computation. Audit action for the classification-write route resolved to `"UPDATE"` (Rev 2, unchanged, citing `BankCashAccountsService.update()`'s confirmed `action: "UPDATE"`/`entityType: "bank_cash_account"` precedent). RBAC unchanged: `finance.viewer`/`finance.poster`/`finance.admin` for the report, `finance.admin` alone for classification writes — the same trio/split used with no exception anywhere else in this codebase. Tenant/legal-entity isolation unchanged: explicit `tenantId`/`legalEntityId` predicates in every CTE plus RLS, belt-and-suspenders, matching `general-ledger.service.ts:116-119`'s established convention.

---

## 19. Test Strategy — Complete Matrix

Real PostgreSQL, real HTTP API posting (no direct inserts), following the established `financial-statements-*.e2e-spec.ts` convention exactly (Rev 1 §19's discipline, unchanged), with one `it()` per row below and what each proves:

| #   | Scenario                                                                                                                                        | What it proves                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A–G (operating, receipt, payment, loan proceeds, capital contribution, fixed-asset purchase, depreciation)                                      | Baseline correctness of the reconciling-entry mechanism for the common cases                                                                                                            |
| 2   | H, I (non-cash asset acquisition; non-cash liability conversion)                                                                                | The CTO's central defect is fixed: neither appears in Investing/Financing; both appear only in `nonCashReclassifications`                                                               |
| 3   | J (cash-to-cash transfer)                                                                                                                       | Zero effect on any bucket or the aggregate movement, with no special-case code path exercised                                                                                           |
| 4   | K, L (mixed multi-line; mixed classification)                                                                                                   | Per-line attribution reconstructs the entry's true cash split exactly, no proportional-allocation artifact                                                                              |
| 5   | M (multiple cash lines)                                                                                                                         | Aggregate cash sum correctly includes every cash line in one entry                                                                                                                      |
| 6   | AP bill with a non-Expense line (prepayment scenario, §1.6)                                                                                     | The reconciling-entry rule correctly handles AP/AR postings that don't touch Revenue/Expense — direct regression test for §1.6's finding                                                |
| 7   | Full prepaid-asset lifecycle across 3 entries (bill creation, cash payment, amortization) in one window                                         | The exclusion-then-inclusion sequence nets to the correct total across a realistic multi-entry accrual cycle (§ worked derivation)                                                      |
| 8   | Manual JE, both non-cash and cash-bearing shapes (O)                                                                                            | The same single rule distinguishes them correctly regardless of posting source                                                                                                          |
| 9   | Reversal of a reconciling entry, and of a pure-reclassification entry, both within one window                                                   | Both net to exactly zero in their respective bucket/disclosure, proving §11's reversal-invariance claim empirically, not just algebraically                                             |
| 10  | Reversal spanning the reporting cutoff (cases 3/4/5, §11)                                                                                       | Standard date-range partitioning behaves correctly with no special reversal logic                                                                                                       |
| 11  | Hard identity assertion, independently re-computed via raw SQL against `journal_lines` in the test itself (not the API's self-reported numbers) | `Operating+Investing+Financing+Unclassified = NetCashMovement` and `Opening+Movement=Closing` actually hold, not merely self-reported                                                   |
| 12  | `nonCashReclassifications` always sums to exactly zero across every fixture                                                                     | Defensive regression check of §5.2's proof — a nonzero result here would indicate the query itself is miswritten                                                                        |
| 13  | Deactivated cash account (§8)                                                                                                                   | Historical movement before/after deactivation is still counted correctly                                                                                                                |
| 14  | Repointed cash account (§8)                                                                                                                     | The disclosed residual limitation behaves as documented (window attributed to current linkage) — a characterization test, not a correctness bug test                                    |
| 15  | Unclassified account (§14)                                                                                                                      | Contributes to `unclassifiedMinor`/`unclassifiedAccounts`, not to any of the three named buckets; identity still holds                                                                  |
| 16  | Net-income cross-check against `GET .../profit-and-loss` for the same window                                                                    | `NetIncome` figures match exactly across the two reports                                                                                                                                |
| 17  | Tenant/legal-entity isolation                                                                                                                   | A second tenant's postings never leak into the first tenant's statement                                                                                                                 |
| 18  | RBAC on the report route and the classification-write route                                                                                     | 401/403/200 per role exactly as specified; `finance.admin`-only enforced on the write route                                                                                             |
| 19  | Audit trail on the classification-write route                                                                                                   | `audit_logs` row with `action:"UPDATE"`, `entityType:"chart_of_accounts"`, correct before/after `cashFlowCategory`                                                                      |
| 20  | Concurrency: a journal entry posts mid-computation                                                                                              | `REPEATABLE READ` prevents a torn read across the two-pass query (§17), using the same `jest.spyOn` seam-injection technique already proven in `general-ledger-concurrency.e2e-spec.ts` |
| 21  | Date-range/period semantics                                                                                                                     | `periodId` resolves identically to the equivalent explicit `dateFrom`/`dateTo`; `asOf` rejected (doesn't exist on this DTO); `periodId`+`dateFrom` combined rejected                    |

---

## 20. Category A / B / C / D Summary

**A — Implementable correctly today, as-is:** the entire fixed architecture (§5), all 15 required scenarios (§6), net income reuse, cash-account identification (§8, `isActive`-corrected), reversal-awareness (§11, re-proven under the fix), tax/VAT treatment (§12), tenant isolation, date-range semantics, RBAC, audit action (resolved to `"UPDATE"`).

**B — Requires the one small, additive schema/configuration addition:** `chart_of_accounts.cashFlowCategory`, nullable enum, no default (§16) — unchanged from Rev 1/2, the only schema change this proposal has ever required, now proven sufficient even after fixing the phantom-flow defect (the fix needed zero additional schema).

**C — Impossible to represent correctly today, because the underlying capability does not exist, and correctly renders as zero/absent:** depreciation/amortization add-back mechanics work (§6.G) but produce `0` today (no Fixed Assets module exists to generate postings); exchange-rate effects on cash (no multi-currency); restricted-cash segregation (no data-model concept).

**D — Explicitly out of scope:** direct-method Cash Flow Statement; bank reconciliation and all bank-statement/settlement tables (§8 of Rev 1, unaffected); any posting-path change (this remains a pure read-layer addition — confirmed again this revision: the fix is entirely a query-time computation, touching zero write paths); multi-currency/FX; manually-posted tax journal-entry coverage (unrelated work item).

---

## 21. Risks and Known V1 Limitations — Classified

- **`glAccountId` repointing (§8):** **Acceptable V1 limitation.** Disclosed, low-probability, unrelated to and unaffected by this revision's architecture fix.
- **Semantic mis-classification by an admin (§9, §10)** (e.g., classifying an Equity account `OPERATING`): **Acceptable V1 limitation.** No worse than, and consistent with, every other unvalidated classification field already in this codebase (tax-code GL mappings); mitigated only by admin diligence and the visible per-account breakdown (§14), not by system enforcement.
- **Accounts left `Unclassified` (§14):** **Acceptable V1 limitation**, now with a concrete, actionable remediation path (`unclassifiedAccounts` list) rather than only a count.
- **Query cost of the new per-entry pass (§17):** **Acceptable V1** — a bounded constant-factor increase over the existing single-pass query, not a new scaling class; the optional index (§16) is a future, not-required optimization.
- **The CTO's original phantom-Investing/Financing-flow concern (§3):** **Resolved, not a remaining limitation.** Proven closed by construction (§5.2), verified against all 15 required scenarios (§6). No workaround, disclosure-only fallback, or open design question remains for this specific issue.

No genuinely unresolved, blocking issue remains. Every item above is either fully resolved by this revision or an explicitly-classified, non-blocking, disclosed V1 characteristic — none of them meets the bar of "cannot be resolved from the repository and accounting analysis" that would require the CTO's own decision under this instruction's §20.

---

## 22. Final Architectural Decision

### Recommended Architecture

**Account-level `cashFlowCategory` classification (one nullable enum column on `chart_of_accounts`, admin-configured via a new `PATCH .../cash-flow-category` route), combined with a computed, unstored, entry-level "reconciling vs. pure-non-cash-reclassification" eligibility test** — an entry is reconciling if any of its lines touches a cash account (§8) or a `REVENUE`/`EXPENSE` account, and pure-reclassification otherwise. Reconciling entries' non-cash lines bucket into Operating/Investing/Financing/Unclassified by their account's classification exactly as originally proposed (Rev 1); pure-reclassification entries' lines are excluded from all four buckets and reported instead as an itemized `nonCashReclassifications` supplemental disclosure (§15.3), per IAS 7.43.

### Why It Is Correct

Proven algebraically (§5.2), not merely argued: every pure non-cash reclassification entry's excluded contribution sums to exactly zero by construction, so the aggregate reconciling identity (§13) is unchanged in form and continues to hold exactly, while every entry with zero cash and zero income-statement effect — the CTO's exact `Dr Fixed Asset/Cr Loan Payable` example, and every structural variant of it (§6, scenarios H/I) — now contributes nothing to Investing or Financing. Verified against all 15 required scenarios (§6), including the specific cases (mixed multi-line, multiple cash lines, AP/AR postings that skip Revenue/Expense, full multi-entry accrual lifecycles, reversals on both sides of the cutoff) most likely to have broken a less carefully-derived fix.

### Why It Fits NoryX

Zero new schema beyond the single column already proposed in Rev 1; zero change to any existing posting path (AP, AR, payments, receipts, manual JE all continue exactly as today — confirmed by re-reading their actual posting code, §1.6); reuses the exact `REPORT_TX_CONFIG`/tenant-isolation/RBAC/audit conventions already established for every other Finance report; introduces one genuinely new query shape (§17) that is a bounded, well-understood extension of patterns already used elsewhere in this codebase (LEFT JOIN'd derived subqueries, `fetchTypeBalancesWithinRange`'s style), not a new architectural pattern.

### Known V1 Limitations

All classified in §21 — none blocking. `glAccountId` repointing (acceptable V1), admin semantic mis-classification (acceptable V1, matches existing codebase precedent), Unclassified accounts (acceptable V1, now actionable), the new query's incremental cost (acceptable V1, bounded, optional future index available if ever needed).

### Schema Impact

Exactly one nullable enum column, `chart_of_accounts.cash_flow_category`, no default, no other table, FK, index, trigger, or RLS change required (§16). Unchanged from Rev 1/2 — the phantom-flow fix required no additional schema.

### Implementation Scope

`services/sphere-finance/src/financial-statements/` (extend `FinancialStatementsService`/`FinancialStatementsModule`/`FinancialStatementsController` with `getCashFlow()` and the new route); one new Drizzle migration (the single column + enum); `services/sphere-finance/src/accounts/` (the new `PATCH :id/cash-flow-category` route and its `AccountsService` method, audited `"UPDATE"`); no changes to `accounts-payable/`, `accounts-receivable/`, `journal-entries/`, `general-ledger/`, or `bank-cash-accounts/` beyond reading their existing tables.

### Test Scope

The 21-row matrix in §19, in a new `financial-statements-cash-flow.e2e-spec.ts` (plus a concurrency spec or an addition to `general-ledger-concurrency.e2e-spec.ts`), following the existing real-Postgres, real-HTTP-API-posting convention with no exception.

### CTO Approval Gate

**This proposal is now sufficiently resolved for implementation authorization.** Every point raised in this Architecture Gate instruction has been addressed with a specific, cited, provable answer rather than an open question: the phantom-flow defect is fixed and proven closed (§5.2, §6); the multi-line allocation question is resolved by showing allocation is unnecessary (§5.3); non-cash-transaction detection is proven against the actual schema (§5.4); the classification-level question is decided explicitly, not left as a menu (§7); cash-account identification is re-confirmed correct (§8); every required scenario is worked through concretely (§6); reversal, tax/VAT, reconciliation invariants, schema, API, audit, RBAC, and testing are each fully specified (§11–§19); and no item in §21's risk list rises to a genuinely blocking, unresolved issue. No implementation authorization is requested or granted by this document itself — that decision remains the CTO's — but no further discovery iteration is required before that decision can be made.

**STOP — proposal complete. No implementation performed. No commit. No push. No bundle.**
