# Tax/VAT Phase 6 — Manual Journal Tax Coverage

**Discovery + Architecture Proposal**

**Status:** PROPOSED — discovery-stage. Not yet CTO-approved. Approval of this proposal is **not** implementation authorization (see §17/§18).

**Author:** Claude (Senior Engineer / Architecture & Discovery Engineer role, this session).

---

## §0 Executive Summary

**Work-item name:** Tax/VAT Phase 6 — Manual Journal Tax Coverage.

**Objective:** let a manually-posted (non-AP/AR) journal entry line that carries tax activity be classified with a tax code and direction, so that the VAT Position Report's per-tax-code breakdown can include it — closing a gap the repository's own Tax/VAT Phase 4 and Phase 5 discovery documents already identified, and which a currently-passing e2e test already demonstrates concretely (see §3).

**Why it is appropriate as the next Finance item:** this is not an invented candidate. It is the one deferred Tax/VAT item explicitly named in the current roadmap ("Manually-posted (non-AP/AR) tax journal entry coverage remains the recommended fast-follow candidate"), it was independently identified twice by two separate, already-approved discovery documents (Phase 4 §"No coverage of manually-posted journal entries carrying tax", Phase 5 §2/§10.4/Decision 1), and its exact shape is already partially proven by a live, currently-passing e2e test in this repository (`vat-position-report.e2e-spec.ts`, "reports a nonzero, correctly-signed difference when a manual journal entry posts to the tax-output account outside any AR document"). All of its dependencies — the Tax Code/Rate model, the Journal Engine, the VAT Position Report — are already implemented, verified, and stable on `main`.

**Current-state gap:** `journal_lines` carries no `tax_code_id` at all. A manually-posted journal entry that books directly to a tax account (e.g. a manual VAT accrual, adjustment, or correction) is invisible to the VAT Position Report's per-tax-code breakdown. It is visible only as an unexplained, unattributed difference in the report's GL cross-check — which can tell you a mismatch exists and its magnitude, but never which tax code it belongs to, because that information is never captured anywhere.

**Proposed outcome:** an optional, nullable `tax_code_id` + `tax_direction` pair on `journal_lines`, settable only while the parent entry is DRAFT, validated the same way every other optional tax classification in this codebase is validated (active code, same legal entity), immutable once POSTED via the _already-existing, unmodified_ `journal_lines_immutable` trigger, and folded into the VAT Position Report as a new, clearly-labelled "manual" bucket per tax code — additive to, not merged silently with, the existing AP/AR-sourced totals (exact merge-vs-separate decision is §16 Decision 3, since it changes report semantics and requires explicit CTO sign-off).

**Explicit non-goals:** this phase does **not** add tax _calculation_ to journal entries. A journal line already states its own debit/credit amount directly; there is no "net base amount" for a manual line the way there is for an AP/AR document line, so there is nothing to compute a percentage against (see §5, §15 Alternative 2). This phase also does not touch reverse charge, statutory filing, multi-jurisdiction, multi-currency, tax-inclusive pricing, or any AP/AR posting logic (see §14).

---

## §1 Verified Baseline

Verified directly against the live repository in this session, via the device shell (`device_bash`) against the repository mounted at the user's connected `noryx-platform` folder — not assumed from this prompt.

```
Current branch:        main
Current local HEAD:    ac16fa0e195f175806240924832c8c1567cc9772
Current origin/main:   ac16fa0e195f175806240924832c8c1567cc9772   (verified via `git ls-remote`/fetch over HTTPS — the repo's configured `origin` remote is SSH, which fails host-key verification inside this sandboxed device shell; HTTPS against the same GitHub repository is the read-only equivalent check, and it returned the identical SHA)
Verified equality:     YES
git status --short:    only `services/sphere-finance/_to_delete/` (pre-existing, unrelated cleanup debris from a prior session, untouched by and out of scope for this discovery)
```

**Authoritative starting SHA (this discovery):** `ac16fa0e195f175806240924832c8c1567cc9772` — the current, delivered `main` HEAD, confirmed above.

**Historical Budgeting implementation SHA:** `0b76882c3c6c4e651b27bbaf5d44a58addad276a` — the Budgeting Phase 1 code commit. Not the baseline for this discovery; referenced only for provenance.

**Historical Budgeting discovery baseline:** `71964dc2863000741cae1a7278e0d824160c3105` — the SHA Budgeting's own discovery was approved against. Historical only; not used anywhere in this document's analysis.

All architecture analysis below reflects the repository **at `ac16fa0`**, read directly (file contents, schema, service code, tests) in this session — not carried forward from any older document without an explicit citation and cross-check.

**Labelling convention used throughout this document:** every material claim is marked **[OBSERVED]** (read directly from the current repository — file path/line given), **[INFERRED]** (a reasonable conclusion drawn from OBSERVED facts, not itself directly stated anywhere), or **[PROPOSED]** (this document's own recommendation, not yet approved). A claim with none of these markers in a section that is substantially OBSERVED should be read as OBSERVED.

---

## §2 Current Architecture

### Journal Engine — **[OBSERVED]**, `services/sphere-finance/src/journal-entries/`

- `journal-entries.module.ts`, `journal-entries.controller.ts`, `journal-entries.service.ts` (951 lines).
- Schema (`src/db/schema.ts`): `journalEntries` (id, tenantId, legalEntityId, journalNumber, status DRAFT|POSTED, transactionDate, periodId, currencyCode, memo, reversalOfJournalEntryId, reversedByJournalEntryId, postedAt/postedBy, createdBy, createdAt/updatedAt) and `journalLines` (id, tenantId, journalEntryId → journalEntries FK cascade-delete, lineNumber, accountId → chartOfAccounts FK, debitMinor, creditMinor, description, createdAt). `journal_lines` has a composite unique `(journalEntryId, lineNumber)`, an index on `accountId`, and two DB CHECK constraints: `journal_lines_single_sided` (exactly one of debit/credit > 0) and `journal_lines_nonzero` (not both zero) — mirrored, not replaced, by `CreateJournalLineDto`'s `SingleSidedNonzeroConstraint`.
- Routes (`journal-entries.controller.ts`): `POST /journal-entries` (create, `finance.poster`), `GET /journal-entries` (list, all three roles), `GET /journal-entries/:id` (all three roles), `PATCH /journal-entries/:id` (`finance.poster`), `DELETE /journal-entries/:id` (`finance.poster`), `POST /journal-entries/:id/post` (`finance.poster`), `POST /journal-entries/:id/reverse` (`finance.poster`). No `finance.admin`-only route exists on this controller today.
- `create()`/`update()` validate every line's `accountId` (`validateLinesOrThrow` → `findInvalidAccountIds`: must exist, be active, be in this tenant+legal entity) and persist via `insertLines()` — a plain `INSERT ... RETURNING`, no per-line business calculation. `update()` does a full-array replace of lines (delete all, reinsert 1..N) when `dto.lines` is supplied, never a line-level patch.
- `post()` (`journal-entries.service.ts:303-406`): locks the header row first (`SELECT ... FOR UPDATE`), requires DRAFT status, requires ≥ 2 lines, requires debits === credits (backstopped by a deferred DB trigger from 2b), **re-validates every line's account** (`revalidateLinesForPostingOrThrow` — an account can be deactivated between draft and posting), resolves+locks the covering OPEN accounting period (`resolveAndLockOpenPeriod`, rejects NOT_FOUND/CLOSED with a distinguishing message), atomically allocates the journal number (`journal_number_counters`, `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, never `MAX()+1`), commits the DRAFT→POSTED transition, and writes one audit row. All in one transaction.
- `reverse()`/`completeReversalPosting()`: locks and validates the original (POSTED, not already reversed, not itself a reversal), resolves+locks the reversal's **own** OPEN period, builds new lines by mapping the original's lines with debit/credit swapped (`accountId` and `description` carried over verbatim), inserts them via the same `insertLines()`, allocates a fresh journal number, posts the reversal, links exactly one column back on the original (`reversedByJournalEntryId`), and writes three audit rows (REVERSE on the original, CREATE + POST on the reversal) in the same transaction.
- Immutability: `drizzle/constraints/003_journal_entries_immutability_trigger.sql` and `004_journal_lines_immutability_trigger.sql` — both are generic, **column-agnostic** BEFORE triggers keyed only on the parent entry's `status`. `journal_lines_immutable` blocks _any_ INSERT/UPDATE/DELETE on a line once its parent is POSTED, with no per-column enumeration — so any new nullable column added to `journal_lines` is automatically protected by this existing trigger with **zero trigger changes**.

### Chart of Accounts / Accounting Periods — **[OBSERVED]**

- `chartOfAccounts`: `type` is `ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE` — no restriction preventing any account type from being used on a journal line (same posture the schema doc comment states explicitly for `journalLines.accountId`).
- `accountingPeriods`: `status` is `OPEN|CLOSED`. `resolveAndLockOpenPeriod()`/`resolvePeriodForDate()` already reject posting into a period that is not OPEN, or not found at all, with a locked row so a concurrent period-close cannot race a concurrent post. This is an existing invariant this phase reuses unmodified — it already governs every journal line, tax-tagged or not.

### Tax Configuration Foundation — **[OBSERVED]**, `services/sphere-finance/src/tax-configuration/`

- `taxCodes`: `id, tenantId, legalEntityId, code, name, treatment (STANDARD|ZERO_RATED|EXEMPT), isActive, apTaxAccountId, arTaxAccountId (both nullable FK → chartOfAccounts, Phase 5), createdBy, createdAt, updatedAt`. Unique `(tenantId, legalEntityId, code)`. **No direction column** — a single code may legitimately be used on both AP and AR documents (schema doc comment, Phase 5); direction today is always _implicit_ from which document type a line belongs to (bill/debit-note ⇒ input, invoice/credit-note ⇒ output), never stored explicitly anywhere.
- `taxRates`: `id, tenantId, legalEntityId, taxCodeId → taxCodes FK, rateBasisPoints, effectiveFrom, effectiveTo (nullable, open-ended)`. CHECK `rateBasisPoints >= 0`, CHECK `effectiveTo IS NULL OR effectiveTo > effectiveFrom`, plus a GiST EXCLUDE constraint (`025_tax_rates_no_overlap_exclusion.sql`) preventing two overlapping effective-dated rates for the same code.
- `TaxRatesService.resolveEffectiveRate(tx, tenantId, legalEntityId, taxCodeId, onDate) → { rate, taxCode }` (`tax-rates.service.ts:213-247`) — validates the code exists in this legal entity and is active, resolves the rate effective on `onDate`, returns both rows in one call (Phase 5's "no unnecessary extra `tax_codes` SELECT" optimization). This is a pure read/validate helper with no side effects; reusable as-is by any new caller.
- `calculateTaxAmountMinor(amountMinor, rateBasisPoints)` (`tax-calculation.ts:27-30`) — pure, stateless, round-half-up integer arithmetic. **Not applicable to this phase** — see §5.

### AP/AR Tax Wiring (Phases 2/3/5) — **[OBSERVED]**, the established shape this phase's design is measured against

Each of `supplier_bill_lines`, `supplier_debit_note_lines`, `customer_invoice_lines`, `customer_credit_note_lines` carries: `taxAmountMinor` (authoritative, always populated), optional `taxCodeId` (null ⇒ legacy manual amount), `taxRateId` (immutable snapshot of the resolved rate), `taxAmountCalculatedMinor` (retained even under an override), `taxAmountOverridden` (server-computed flag), and (Phase 5) `resolvedTaxAccountId` (the GL account this line's tax posts to, resolved and snapshotted at DRAFT-time, never re-derived at `post()`). Direction (input vs. output) is always implicit from the table/document type, never a stored column. Defense-in-depth CHECK constraints enforce the implications between these columns (e.g. `..._tax_overridden_requires_code`, `..._tax_rate_requires_code`) in addition to the service-layer checks.

### VAT Position Report (Phase 4/5) — **[OBSERVED]**, `services/sphere-finance/src/tax-reports/`

- `TaxReportsController`/`TaxReportsService` (840 lines), read-only, `GET /v1/finance/tax-reports/vat-position`, roles `finance.viewer|finance.poster|finance.admin`.
- Computes net output tax from `customer_invoice_lines` minus `customer_credit_note_lines` (POSTED, in-window) and net input tax from `supplier_bill_lines` minus `supplier_debit_note_lines` (POSTED, in-window), broken down **per tax code**, with an explicit `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` bucket for legacy (`taxCodeId IS NULL`) lines so the headline total can never silently exclude them.
- **Never reads `journal_lines` for the per-code breakdown** — confirmed directly in code and doc comment (`tax-reports.service.ts:124-130`): "`journal_lines` carries no `tax_code_id` at all, so a... per-code data[source]" is impossible from it today.
- Optional `glCrossCheck`: a coarser, **account-level period-movement** sanity check (not point-in-time balance) against the AP/AR-settings singleton tax accounts (Phase 4) plus, since Phase 5, every per-code override account actually in play for the window (`{ap_settings.tax_input_account_id} ∪ {tax_codes.ap_tax_account_id WHERE NOT NULL}`, mirrored for output). This _does_ read `journal_lines` (`glMovement()`, `tax-reports.service.ts:746-`), but purely as `SUM(credit) − SUM(debit)` (output) / `SUM(debit) − SUM(credit)` (input) over POSTED lines touching those specific accounts — never attributed to a tax code, because the query has no `tax_code_id` to group by.

### Security / RLS / RBAC / Audit conventions — **[OBSERVED]**, reused unmodified by this proposal

- Tenant isolation: `FORCE ROW LEVEL SECURITY` + a tenant-scoped policy (`current_setting('app.current_tenant_id', true)`), applied per-table, identical wording across every RLS file in `drizzle/rls/`.
- Legal-entity isolation: always an explicit service-layer `WHERE legalEntityId = ...` predicate, never delegated to RLS — the unbroken convention across every module inspected (Journal Entries, Tax Configuration, Budgeting, AP, AR).
- RBAC: `@Roles(...)` + `RolesGuard`, exhaustively cross-checked by `route-role-matrix.spec.ts` (147 routes / 27 controllers as of the Budgeting delivery), which fails the build if any route is left unrecognized or its role set drifts from the hand-maintained `EXPECTED` table.
- Audit: every mutation writes an `auditLogs` row (`entityType`, `entityId`, `beforeState`/`afterState`, `actorUserId`) inside the same transaction as the mutation, per the repo-wide convention every module inspected follows identically.

---

## §3 Current Gap

**Demonstrated, not assumed**, by a currently-passing e2e test already in the repository (`services/sphere-finance/test/vat-position-report.e2e-spec.ts:694-740`):

```
Manual Journal Entry              Customer Invoice
  Dr Revenue        700             Dr Customer AR
  Cr Tax-Output Acct  700             Cr Revenue
                                       Cr Tax-Output Acct
        │                                   │
        ▼                                   ▼
   journal_lines                    customer_invoice_lines
   (NO tax_code_id column exists)   (taxCodeId, taxRateId, taxAmountMinor...)
        │                                   │
        ▼                                   ▼
  glCrossCheck.glOutputTaxMovementMinor   VatPositionResponse.outputTaxMinor /
  (account-level, sees BOTH postings —    perCode[].netTaxMinor
   the ONLY place the manual entry is     (per-tax-code, sees ONLY the invoice —
   visible at all)                         the manual entry is invisible here)
```

That test asserts, and the current code delivers, exactly this outcome:

1. `outputTaxMinor` (the report's headline, source-line-based figure) is **unaffected** by the manual entry — it never touched `customer_invoice_lines`.
2. `glCrossCheck.glOutputTaxMovementMinor` **does** include the manual entry's 700 credit.
3. The two figures now disagree by exactly 700 (`outputDifferenceMinor = -700`, `outputReconciled = false`).

This is documented and intentional _as a detection mechanism_ (both Phase 4's discovery §"No coverage of manually-posted journal entries..." and Phase 5's discovery §10.4 call it "expected-mismatch behavior... not a bug"), but it is a **detection-only** capability: the report can tell you a mismatch of a known size exists, and it can tell you it touched one of the tax accounts, but it structurally cannot tell you which tax code it was for, what treatment (STANDARD/ZERO_RATED/EXEMPT) applies, or whether it was even genuinely tax-related activity versus a coincidental posting to the same account for an unrelated reason. Every accounting user who needs to actually _explain_ a VAT position — not merely notice that one line doesn't reconcile — currently has no way to do so from inside this system for any manually-posted tax activity.

**Why this is a genuine gap, not a defect:** nothing in the current implementation is wrong. `journal_lines` was never designed to carry tax attribution (2b's Journal Engine predates the Tax Configuration Foundation entirely), and the VAT Position Report correctly refuses to guess at attribution it doesn't have. The gap is a **missing capability**, not a bug in an existing one — consistent with how both prior discovery documents already characterized it.

**Why it is in current roadmap scope:** `docs/roadmap.md`'s own text: _"Manually-posted (non-AP/AR) tax journal entry coverage remains the recommended fast-follow candidate"_ — not invented for this discovery.

**Dependencies — all already exist [OBSERVED], zero missing:** the Tax Code/Rate model (Phase 1), the Journal Engine's create/update/post/reverse lifecycle (2b/2c), the VAT Position Report's per-code aggregation shape (Phase 4/5), and the exact class of "optional nullable FK, validated at DRAFT time, protected by an existing immutability trigger, additive to reporting" pattern this phase reuses (Phases 2/3/5).

**One coherent work item, no prerequisites:** this phase touches exactly two existing components — `journal_lines`'/`JournalEntriesService`'s DRAFT-time line validation and insertion, and `TaxReportsService`'s per-code aggregation — both fully implemented today. No other work item needs to land first.

---

## §4 Proposed Architecture

**Reused, unmodified:**

- `taxCodes`/`taxRates` tables and `TaxRatesService` (validation + rate lookup only — see §5 for why rate/amount calculation is _not_ reused).
- `journal_lines_immutable` trigger (already column-agnostic — protects the two new columns for free).
- `withTenant()` transaction wrapper, `READ COMMITTED` isolation, the existing header-row `SELECT ... FOR UPDATE` lock-first pattern in `create()`/`update()`/`post()`/`reverse()`.
- `resolveAndLockOpenPeriod()`, `allocateJournalNumber()`, `findInvalidAccountIds()` — all unchanged.
- RLS (`002_journal_engine_rls.sql`, already covers `journal_lines` — no new table, so no new RLS file).
- `auditLogs` convention — no new audit action type needed; tax classification travels inside the existing CREATE/UPDATE/POST/REVERSE `afterState` snapshots of the line, same as every other line field.
- `route-role-matrix.spec.ts` — extended (no new controller, no new route; see §7), not replaced.

**New:**

1. Two nullable columns on `journal_lines`: `tax_code_id` (FK → `tax_codes`) and `tax_direction` (new 2-value enum `journal_line_tax_direction`: `INPUT` | `OUTPUT`), governed by a CHECK constraint requiring both-null or both-set (§6).
2. `CreateJournalLineDto`/the line-shape used by `update()` gain two optional fields, `taxCodeId?: string` and `taxDirection?: "INPUT" | "OUTPUT"`, with class-validator rules requiring them to be both-present-or-both-absent (mirroring the DB CHECK, same "clean 400 instead of a raw constraint violation" principle `CreateJournalLineDto` already uses for `journal_lines_single_sided`).
3. A new private validation step in `JournalEntriesService`, alongside the existing account validation, resolving/validating any tagged `taxCodeId` (exists, active, same legal entity — via `TaxRatesService`'s existing `taxCodes.findByIdInTx`-style lookup, **not** `resolveEffectiveRate()`, since no rate/amount is being calculated — see §5). Called from both `create()`'s and `update()`'s existing `validateLinesOrThrow()`, and — mirroring the exact reasoning already applied to accounts — re-checked at `post()` time inside `revalidateLinesForPostingOrThrow()` (a tax code can be deactivated between draft and posting, same risk class as an account).
4. `completeReversalPosting()`'s reversal-line-building step (`journal-entries.service.ts:556-563`) carries the original line's `taxCodeId`/`taxDirection` onto the reversing line unchanged — a reversal of tax-related activity is still tax-related activity; only the amount's sign flips, not its classification (§16 Decision 2 — confirm with the CTO, since it is a judgment call, not dictated by the schema).
5. `TaxReportsService` gains a new private query against `journal_lines` (joined to `journal_entries` for status/date-window and to `tax_codes` for `code`/`treatment`), grouped by `(taxCodeId, taxDirection)`, POSTED + in-window — structurally the same shape as the existing per-code AP/AR query, just against a different source table with only one amount column to attribute (debit or credit, whichever is nonzero, signed by `taxDirection`) instead of a dedicated `taxAmountMinor`.
6. The `VatPositionResponse` per-code entries gain new fields carrying this manual total, additive alongside the existing `netSupplyValueMinor`/`netTaxMinor`/`netCalculatedTaxMinor` fields (exact shape and whether it also changes the existing headline totals is §16 Decision 3 — this is the one genuinely report-semantics-changing choice in this phase, and is not silently resolved here).
7. `glCrossCheck`'s existing account-level movement figure is **unchanged in computation** — it still sums _every_ posted line touching the relevant accounts, tagged or not. What changes is only that a tagged manual line's activity now _also_ appears, correctly attributed, in the per-code breakdown — so once every manually-posted tax entry is properly tagged, `outputDifferenceMinor`/`inputDifferenceMinor` should trend toward zero, while an untagged manual entry continues to surface exactly the same detection signal it does today (§10).

**No schema change, no new table, no new RLS file, no new migration-tracking concern, no new controller, no new route.** This is the smallest change that closes the identified gap while reusing every relevant piece of existing infrastructure.

---

## §5 Accounting Semantics

**What constitutes manual tax activity (this phase's scope):** a journal line, on a manually-created journal entry (i.e. going through `POST /journal-entries`, not created as a side effect of any AP/AR document's `post()`), whose preparer explicitly tags it with a tax code and a direction. Nothing is inferred from the account it hits, its amount, or any other heuristic — tagging is always an explicit, opt-in act by the preparer, exactly mirroring how `taxCodeId` is optional on every AP/AR line today.

**Input-tax vs. output-tax treatment:** unlike AP/AR documents, a manual journal line has no document type to imply direction (a bill is always input, an invoice is always output — but a manual journal entry could be either, or neither, on the very same entry). Direction must therefore be **explicit**, not inferred — see §16 Decision 1 for the two alternatives considered and why an explicit field is recommended over inference.

**Debit/credit polarity — [PROPOSED], mirroring AP/AR's existing polarity exactly:** a line tagged `OUTPUT` contributes `creditMinor − debitMinor` to that code's manual output-tax total (output tax is normally a credit — mirrors how invoices credit the output account and credit notes, which debit it, are already handled as a _negative_ contribution in the existing per-code AP/AR logic, `tax-reports.service.ts:281-`/`~470-490`). A line tagged `INPUT` contributes `debitMinor − creditMinor` to that code's manual input-tax total (input tax is normally a debit — mirrors bills debiting / debit notes crediting). A tagged line with the "wrong" polarity for its declared direction (e.g. `INPUT` but net-credit) is **not rejected** — a manual correcting/reversing entry is exactly this shape by design (§4 point 4), and the signed contribution formula above already produces the mathematically correct (negative) effect without any special-casing, identical in spirit to how the existing per-code logic already handles credit notes/debit notes as negative contributions rather than as a separate error case.

**Sign conventions:** integer minor units throughout (`debitMinor`/`creditMinor`, already `bigint` non-negative columns on `journal_lines`), matching every other monetary field in this codebase. No new rounding is introduced anywhere in this phase (§5, calculation, below) — the amounts already exist as exact integers on the line.

**Period/date semantics:** unchanged. A tagged line's date is its parent entry's `transactionDate`/resolved `periodId`, exactly as for every other line — no new date concept. The report's existing `dateFrom`/`dateTo`/`periodId` window logic applies identically to the new manual query.

**Reversal behavior:** see §4 point 4 — the tag carries over onto the reversing line unchanged (same code, same direction), only the amount's sign flips (debit↔credit swap, same as every other field on a reversal line today). Flagged as §16 Decision 2 because, unlike everything else in `completeReversalPosting()`, this is not dictated by any existing mechanical rule (accountId/description literally cannot mean anything different on reversal; a tax _classification_, in principle, could be argued to not need to persist — but leaving it off would silently make the reversal itself invisible to the very report this phase exists to feed, which this document's author considers the wrong default without an explicit CTO decision recorded).

**Interaction with AP/AR tax:** **none, by construction.** This phase never reads or writes `supplier_bill_lines`/`supplier_debit_note_lines`/`customer_invoice_lines`/`customer_credit_note_lines`, and AP/AR's `post()` methods never write to `journal_lines.tax_code_id`/`tax_direction` (those columns are only ever set by `JournalEntriesService`, on manually-created entries, at DRAFT time). The two universes remain structurally disjoint at the schema level, exactly as `journal_lines` and the four AP/AR line tables already are today.

**Double-count prevention:** because AP/AR `post()` writes to `journal_lines` only through its own posting code path (which this phase does not modify) and never sets the two new columns, and because a _manual_ journal entry (the only thing that can set them) is, by definition, not an AP/AR document's own generated posting, there is no code path by which the same tax activity could ever be counted once in the AP/AR-sourced total and again in the manual-sourced total. **[INFERRED, to be proven, not assumed — see §11 JTX-014/JTX-015 and §12]:** this claim is testable and must be proven by a concrete e2e assertion (create + post an AP document, confirm its generated journal lines carry `tax_code_id = NULL`), not left as an architectural assertion alone.

**Manual journal classification:** the two new columns exist **only** on `journal_lines` (used by manual entries) — never added to any AP/AR line table, and never populated on the journal lines an AP/AR document's own `post()` generates, since that generated-line-insertion code is untouched by this phase.

**Tax-code availability/absence:** identical rule to every AP/AR line today — a code must exist, be active, and be in the same legal entity as the journal entry, checked at DRAFT-time (create/update) and re-checked at posting time (§4 point 3) exactly as accounts already are.

**Multiple tax-account lines:** no restriction — a single journal entry may have any number of tagged lines, on any accounts, in any mix of directions/codes, exactly as a journal entry may already touch any number of accounts today. No new "one tax line per entry" rule is introduced or needed.

**Tax adjustments:** a manual adjustment (e.g. correcting a prior period's tax figure) is simply a tagged journal entry like any other — no separate "adjustment" concept is introduced. This is deliberate: introducing a distinct adjustment workflow would be new scope beyond "coverage," and nothing in the roadmap or either prior discovery calls for one.

**Closed periods:** unaffected — a tagged line is still subject to the exact same `resolveAndLockOpenPeriod()` check every journal line already goes through; there is no way to post a tagged line into a CLOSED period that a plain line couldn't already be blocked from.

**Posted-entry immutability:** unchanged — the existing, column-agnostic `journal_lines_immutable` trigger already blocks any mutation to a POSTED line, including the two new columns, without any trigger change (§2, §4).

---

## §6 Data Model

**No new table.** Two new nullable columns and one new enum on the existing `journal_lines` table.

| Table           | Field           | Type                                                       | Nullable | FK                                                                                                                                 | Notes                                                |
| --------------- | --------------- | ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `journal_lines` | `tax_code_id`   | `uuid`                                                     | YES      | → `tax_codes(id)`, no `onDelete` (tax codes are deactivate-only, never hard-deleted — identical to every AP/AR line's `taxCodeId`) | NULL = untagged (today's behavior, unchanged)        |
| `journal_lines` | `tax_direction` | `journal_line_tax_direction` (new enum: `INPUT`, `OUTPUT`) | YES      | —                                                                                                                                  | Must be NULL iff `tax_code_id` is NULL (CHECK below) |

**New enum:** `CREATE TYPE journal_line_tax_direction AS ENUM ('INPUT', 'OUTPUT');` — deliberately its own enum, not a reuse of `taxTreatmentEnum` (`STANDARD|ZERO_RATED|EXEMPT`, an orthogonal concept — a code's treatment and a line's direction are independent axes, exactly as `tax_codes` already has no direction column at all because a single code can be used in either direction).

**CHECK constraint** (mirrors the existing `..._tax_overridden_requires_code`/`..._tax_rate_requires_code` implication-CHECK pattern on the AP/AR line tables verbatim):

```sql
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tax_direction_requires_code
  CHECK (
    (tax_code_id IS NULL AND tax_direction IS NULL)
    OR (tax_code_id IS NOT NULL AND tax_direction IS NOT NULL)
  );
```

**Indexes:** none added. The existing AP/AR line tables carry no dedicated index on their own `taxCodeId` either (only on `accountId`) — this phase stays consistent with that established, evidently-sufficient convention rather than adding one speculatively. If the new VAT-report query proves slow in practice, a follow-up index is a trivial, independent, non-schema-breaking addition — not something this phase needs to pre-empt.

**Deletion behavior:** none — `journal_lines` rows are never independently deleted except via their parent entry's cascade (`onDelete: "cascade"` already on `journalEntryId`, unaffected by this change) or the existing full-array-replace in `update()` (DRAFT only).

**Migration implications:** additive only — `ALTER TABLE journal_lines ADD COLUMN tax_code_id ...`, `ADD COLUMN tax_direction ...`, `ADD CONSTRAINT ...`, `CREATE TYPE journal_line_tax_direction ...`. Every existing row gets `NULL`/`NULL`, satisfying the CHECK trivially and preserving 100% of existing behavior for every entry ever posted before this migration (§13).

**Why no schema change to any other table:** proven by §2/§4 — the AP/AR line tables are untouched by this phase's read/write paths, and the VAT report needs only a new _query_ against the now-richer `journal_lines`, not a new column on `tax_codes`/`tax_rates`/`vat_position` (there is no such table — the report is computed live).

---

## §7 API / Service Contract

**No new route.** The existing five mutating Journal Entries routes and one read-only Tax Reports route absorb this phase's entire surface.

| Method                                                                   | Route               | Role                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/finance/journal-entries`                                       | create              | `finance.poster`                                    | Request body: each line in `lines[]` may now optionally include `taxCodeId`/`taxDirection`. Validation: both-or-neither (400 if exactly one supplied — class-validator, mirrors the existing `SingleSidedNonzeroConstraint` pattern); if supplied, `taxCodeId` must resolve to an active code in this legal entity (400 — **not** 422; this mirrors `findInvalidAccountIds`'s existing 400 for an invalid `accountId` at create time, both being "malformed reference in an otherwise well-formed request," the repo's own established convention, distinct from AP/AR's 422 for the _same_ kind of check — a deliberate, explained deviation: `JournalEntriesService`'s own account-validity check is already 400 at create-time today, unlike AP/AR's 422 convention, and this phase follows the controller it's actually extending, not a different one). Response: each returned line includes `taxCodeId`/`taxDirection` (both `null` when untagged). |
| `PATCH /v1/finance/journal-entries/:id`                                  | update              | `finance.poster`                                    | Identical semantics to create, applied to the full-array line replacement `update()` already performs when `lines` is supplied. Unchanged: still rejected 409 if the entry is not DRAFT (existing check, untouched).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /v1/finance/journal-entries`, `GET /v1/finance/journal-entries/:id` | list/get            | all three roles                                     | Response shape gains the two new nullable fields per line; no other change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /v1/finance/journal-entries/:id`                                 | remove              | `finance.poster`                                    | Unchanged — deleting a DRAFT entry deletes its lines (existing cascade), tagged or not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /v1/finance/journal-entries/:id/post`                              | post                | `finance.poster`                                    | Adds one re-validation step (§4 point 3) inside the existing `revalidateLinesForPostingOrThrow()`: any tagged line's `taxCodeId` must still be active. On failure: 422 (matches the existing account-revalidation 422 at this exact step — a business-invariant failure at posting time, not a request-shape failure). No other behavior change; balance/period/numbering logic is completely untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /v1/finance/journal-entries/:id/reverse`                           | reverse             | `finance.poster`                                    | The generated reversal line carries over `taxCodeId`/`taxDirection` unchanged (§4 point 4, §16 Decision 2). No request/response shape change — this is purely internal line-construction behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /v1/finance/tax-reports/vat-position`                               | VAT position report | `finance.viewer`, `finance.poster`, `finance.admin` | Response gains new fields per §16 Decision 3 (exact shape pending that decision). No request (query param) change — `dateFrom`/`dateTo`/`periodId` continue to scope the new manual-tax query identically to the existing AP/AR queries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Idempotency:** unaffected — none of the six routes above were idempotent before this phase (each `create()`/`update()`/`post()`/`reverse()` call has exactly the same non-idempotent semantics it has today; tagging two fields differently does not change that).

**Tenant/legal-entity behavior:** unchanged in every route — `tenantId`/`legalEntityId` continue to come only from the verified JWT via `requireTenantContext`/equivalent, never from the request body, and every new lookup (`tax_codes` validation) is scoped by both, mirroring every existing lookup in this controller.

**No UI requirement invented:** this phase is a backend/API + reporting change only, consistent with every other Finance phase's scope in this repository so far (no `apps/web` change anywhere in the current Finance build).

---

## §8 Concurrency / Transaction Safety

**No new mutation path, no new lock, no new transaction boundary.** Every mutation this phase touches already runs inside `JournalEntriesService`'s existing transactional methods, each of which already locks its header row first:

| Mutation path                           | Transaction boundary               | Lock order (unchanged)                                                                            | What this phase adds                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create()`                              | `withTenant(...)`, one transaction | No lock needed — new row, nothing to race against                                                 | Extra validation query (`tax_codes` lookup) inside the same transaction, before insert — no new lock                                                                                                                                               |
| `update()`                              | `withTenant(...)`, one transaction | Header row `SELECT ... FOR UPDATE` first (unchanged, §2)                                          | Same as `create()` — extra read-only validation query only                                                                                                                                                                                         |
| `post()`                                | `withTenant(...)`, one transaction | Header row `SELECT ... FOR UPDATE` first, then period row `SELECT ... FOR UPDATE` (unchanged, §2) | One extra read-only re-validation query (tax code still active) inserted into the _existing_ `revalidateLinesForPostingOrThrow()` step, at the exact same point in the sequence the account re-check already runs — no new lock, no new step order |
| `reverse()`/`completeReversalPosting()` | `withTenant(...)`, one transaction | Original header row locked first, then reversal's own period row locked (unchanged, §2)           | Copies two extra fields when building the reversal's line objects — no new query, no new lock                                                                                                                                                      |

**Isolation:** unchanged — `READ COMMITTED`, the codebase default, exactly as every other Journal Engine operation already runs (`withTenant()` called with no `txConfig` override, same as today).

**Race conditions explicitly considered:**

- **Duplicate tax activity:** not a new risk class — a journal entry's lines are inserted once, inside one transaction, exactly as today; tagging two fields on an existing insert statement introduces no new duplication surface.
- **Double counting:** addressed architecturally in §5 (the two universes — AP/AR-sourced and manual-sourced — are structurally disjoint by construction) and must be proven, not assumed (§11 JTX-014/015, §12).
- **Stale reports:** the VAT Position Report already runs its own read-only query at request time (no caching, no materialized state) — a tagged line only affects the report after its parent entry is POSTED (the report already filters to POSTED-only), so there is no new staleness class beyond what already exists for AP/AR-sourced figures.
- **Inconsistent reconciliation:** the `glCrossCheck`'s movement query and the new per-code manual query both run inside the same report request's read-only transaction context the report already uses (unchanged) — no new cross-query consistency risk is introduced.
- **Partial mutation:** `create()`/`update()`/`post()`/`reverse()` all remain single-transaction, all-or-nothing exactly as today — a validation failure on the new tax-code check throws before any row is written/updated, inside the same transaction, rolling back everything (identical to how an invalid `accountId` already behaves).
- **Cross-tenant / cross-legal-entity access:** the new `tax_codes` lookup is scoped by both `tenantId` and `legalEntityId` in every call site, mirroring `findInvalidAccountIds` exactly — no new cross-tenant surface.

**Concurrent post() vs. tax-code deactivation:** the one genuinely new interleaving this phase introduces — a `finance.admin` deactivating a tax code (`TaxCodesService`, Phase 1, unmodified by this phase) concurrently with a `post()` that references it. This is architecturally identical in shape to the pre-existing "concurrent account archival vs. post()" race the codebase already handles (`revalidateLinesForPostingOrThrow`'s account re-check), which is not itself protected by any special lock beyond the header-row lock `post()` already takes — the re-check simply runs under `READ COMMITTED` after that lock is held, so it sees the tax code's committed state as of that moment. **[PROPOSED black-box test, §12]:** deactivate a referenced tax code concurrently with a `post()` call across real trials, confirming `post()` either succeeds (deactivation lost the race, ran after) or is rejected 422 (deactivation won), mirroring the existing account-deactivation-vs-post() test shape this repository should already have for accounts (to be located and pattern-matched, not re-invented, during implementation).

**No concurrency-proof-style repeated-trials testing is required beyond what's noted above** — unlike Budgeting's five-operations-sharing-one-lock design, this phase adds no new lock and no new invariant that two operations could race to violate; it adds read-only validation queries to paths whose locking already exists and is already correct.

---

## §9 RLS / Security / RBAC

**Tenant isolation:** `journal_lines`' existing RLS policy (`002_journal_engine_rls.sql`, unmodified) already covers every column on the table, including the two new ones — RLS filters by row, not by column, so no RLS change is needed or possible to "extend" here.

**Legal-entity isolation:** the new `tax_codes` validation lookup is explicitly scoped by `legalEntityId` in every call site (§8), matching the unbroken convention that legal-entity isolation is always an explicit service-layer predicate in this codebase, never RLS.

**Authorization:** no new role, no new permission. Every route this phase touches already requires `finance.poster` (mutations) or any of the three finance roles (reads) — reused unmodified (§7).

**Database protection:** the new CHECK constraint (§6) is a defense-in-depth backstop identical in kind to the existing AP/AR implication-CHECK pattern — it protects against a hypothetical future caller that bypasses the service layer entirely (raw SQL, a bug in a different code path), exactly as those existing constraints do, not because the service-layer validation (§4 point 3) is expected to ever fail on its own.

**Auditability:** no new audit action type. The two new fields travel inside the same `beforeState`/`afterState` JSON snapshots every CREATE/UPDATE/POST/REVERSE audit row already captures for a line — nothing new to wire, nothing new to test beyond confirming the fields are present in an existing snapshot (§11 JTX-016).

**Posted-accounting immutability:** proven at the database level, not merely asserted — the existing `journal_lines_immutable` trigger is column-agnostic (§2), so a direct raw-SQL `UPDATE` attempt against a POSTED line's new `tax_code_id`/`tax_direction` columns is rejected by the same, already-existing trigger with zero code change. This must still be **directly verified** post-implementation (§11 JTX-013, §12), not assumed merely because the trigger's `CREATE OR REPLACE FUNCTION` body is column-agnostic by inspection — the same discipline Phase 5 itself applied when it verified this same trigger for its own new column.

**Privilege boundaries:** unchanged — `finance.poster` can already create/edit/post/reverse journal entries and already can reference any active account in scope; this phase lets that same role additionally reference any active tax code in scope, which is a narrower privilege than "any account," not a broader one.

---

## §10 Reporting / Reconciliation Semantics

**How the report's per-code breakdown changes:** today, each per-code entry in `VatPositionResponse` is built from exactly the four AP/AR source-line tables (§2). This phase adds a new, independent query source — tagged `journal_lines` — grouped by `(taxCodeId, taxDirection)`, POSTED + in-window, using the signed-contribution formula from §5 (`creditMinor − debitMinor` for `OUTPUT`, `debitMinor − creditMinor` for `INPUT`).

```
                    ┌─────────────────────────────┐
                    │   VAT Position Report        │
                    │   GET /tax-reports/vat-       │
                    │   position                    │
                    └──────────────┬────────────────┘
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                      ▼
   customer_invoice_lines   supplier_bill_lines/    journal_lines
   customer_credit_note_    supplier_debit_note_    WHERE tax_code_id
   lines (existing,          lines (existing,        IS NOT NULL
   unchanged)                 unchanged)              (NEW, this phase)
              │                    │                      │
              ▼                    ▼                      ▼
     per-code OUTPUT tax   per-code INPUT tax      per-code MANUAL tax
     (existing)             (existing)              (NEW — §16 Decision 3
                                                       decides whether this
                                                       merges into the
                                                       headline total or
                                                       stays a separate,
                                                       additive figure)
```

**`netSupplyValueMinor` for the manual bucket:** does not exist for a manually-tagged line — there is no separate "net amount the tax was calculated from" the way there is for an AP/AR line's `amountMinor` (§5, §15 Alternative 2). **[PROPOSED]:** the manual bucket's `netSupplyValueMinor`-equivalent field should be explicitly `null`/omitted rather than `0` — `0` would misleadingly claim "zero supply value" when the true answer is "not applicable," a distinction this report should not blur (§16 Decision 3 covers the exact field shape).

**AP-originated / AR-originated / manual tax — kept distinguishable:** whatever the exact merge-or-separate shape §16 Decision 3 settles on, the underlying per-source figures must remain independently recoverable from the response (never silently summed into a single number with no way to tell the sources apart) — mirroring the existing report's own discipline of keeping `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` visible as their own field rather than folding them invisibly into the classified per-code rows.

**Reconciliation:** with tagging adopted, `glCrossCheck`'s existing account-level movement (§4 point 7, computation unchanged) should trend toward equalling `(AP/AR-sourced + manual-tagged)` per account, leaving only genuinely _untagged_ manual activity as the residual, correctly-attributed-as-a-gap signal — which is precisely the intended, narrowing end state this phase exists to produce, not a promise that the cross-check becomes meaningless once adopted.

**Double counting:** see §5/§8 — architecturally prevented by construction (disjoint source tables, disjoint write paths), to be proven by e2e assertion (§11 JTX-014/015).

**Reversals:** a tagged manual entry's reversal (§4 point 4, §5) carries the same code/direction with the amount's sign flipped — the report's existing POSTED-only, signed-sum-over-the-window query shape already nets a reversal against its original correctly for every other figure it computes today (e.g. a reversed AP bill's tax), and the new manual query uses the identical shape, so no special-case reversal logic is needed in the report itself.

**Legacy records:** every `journal_lines` row posted before this migration has `tax_code_id = NULL` (§13) — behaviorally identical to "untagged," which the new query already treats as "not included in the manual per-code breakdown," exactly the same as how a legacy AP/AR line with `taxCodeId = NULL` is excluded from _that_ per-code breakdown today. No backfill is proposed or needed (§13) — retroactively guessing which historical manual journal lines were "really" tax-related is out of scope and would require inventing data that was never captured.

**Date boundaries:** the new query uses the exact same `dateFrom`/`dateTo`/resolved-`periodId` window logic the report already applies to every other source, via the parent `journal_entries.transactionDate`/`periodId` — no new date-boundary concept.

**Tax-account mappings:** irrelevant to the new per-code query (it groups by `tax_code_id` directly, not by which GL account was hit) — relevant only to `glCrossCheck`, whose account-set computation (§2, Phase 5) is entirely unchanged by this phase.

**Zero activity:** a legal entity/window with no tagged manual lines produces exactly today's report output plus an empty/zero manual bucket — not an error, not a different code path, mirroring how a legal entity with no AP/AR tax activity yet already produces a report with zero figures today (Phase 4's own stated design posture).

**Closed periods:** irrelevant to the report itself (the report reads POSTED lines regardless of the covering period's _current_ status) — unaffected by this phase, exactly as today.

---

## §11 Acceptance Matrix

Scenario IDs use a fresh `JTX-` prefix (Journal Tax) — no established ID scheme exists in the prior Tax/VAT Phase 4/5 discovery documents to extend. Coverage-focused, not count-inflated.

| ID      | Preconditions                                                                                                                         | Action                                                                                                                 | Expected result                                                                                                                                                                                 | Invariant proved                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| JTX-001 | DRAFT journal entry being created                                                                                                     | `POST /journal-entries` with one line carrying a valid, active `taxCodeId` + `taxDirection: OUTPUT`                    | 201; line in response carries both fields                                                                                                                                                       | Happy path — create with tag                                                                          |
| JTX-002 | as above                                                                                                                              | Same, `taxDirection: INPUT`                                                                                            | 201                                                                                                                                                                                             | Happy path — both directions accepted                                                                 |
| JTX-003 | as above                                                                                                                              | Line carries `taxCodeId` but omits `taxDirection`                                                                      | 400                                                                                                                                                                                             | Both-or-neither validation (request shape)                                                            |
| JTX-004 | as above                                                                                                                              | Line carries `taxDirection` but omits `taxCodeId`                                                                      | 400                                                                                                                                                                                             | Both-or-neither validation, inverse                                                                   |
| JTX-005 | as above                                                                                                                              | Line carries a `taxCodeId` from a different legal entity                                                               | 400                                                                                                                                                                                             | Legal-entity-scoped tax-code validation                                                               |
| JTX-006 | as above                                                                                                                              | Line carries a `taxCodeId` for a code that is `isActive: false`                                                        | 400                                                                                                                                                                                             | Active-code-only validation at create time                                                            |
| JTX-007 | as above                                                                                                                              | Line carries a syntactically-valid but non-existent `taxCodeId`                                                        | 400                                                                                                                                                                                             | Existence validation                                                                                  |
| JTX-008 | DRAFT entry with a tagged line exists                                                                                                 | `PATCH /journal-entries/:id` replacing `lines` with a differently-tagged set                                           | 200; new tags persisted, old ones gone (full-array replace, unchanged existing semantics)                                                                                                       | Update applies the same validation                                                                    |
| JTX-009 | POSTED entry with a tagged line                                                                                                       | `PATCH`/`DELETE` against it                                                                                            | 409 (existing immutability check, unaffected by tagging)                                                                                                                                        | Posted-entry immutability, header level                                                               |
| JTX-010 | DRAFT entry, one line tagged with an active code                                                                                      | Deactivate that code (via `TaxCodesService`, another actor), then `POST /journal-entries/:id/post`                     | 422                                                                                                                                                                                             | Posting-time re-validation (mirrors account re-check)                                                 |
| JTX-011 | DRAFT entry, one line tagged with a still-active code, entry otherwise valid (balanced, ≥2 lines, covering OPEN period)               | `POST .../post`                                                                                                        | 200; posted lines carry the tags in the response                                                                                                                                                | Tag survives posting unchanged                                                                        |
| JTX-012 | POSTED, tagged entry                                                                                                                  | `POST .../reverse`                                                                                                     | 200; the new reversal entry's line(s) carry the same `taxCodeId`/`taxDirection` as the original, with debit/credit swapped                                                                      | Reversal carries the tag over (§4 point 4, §5)                                                        |
| JTX-013 | POSTED, tagged line                                                                                                                   | Raw SQL `UPDATE journal_lines SET tax_code_id = ... WHERE id = ...` (owner DB connection, bypassing the service layer) | Rejected by the existing `journal_lines_immutable` trigger                                                                                                                                      | Immutability enforced at the database level, not just the app layer (§9)                              |
| JTX-014 | A Supplier Bill with `taxCodeId` set, posted                                                                                          | Inspect the journal lines `post()` generated for it                                                                    | `tax_code_id`/`tax_direction` are `NULL` on every generated line                                                                                                                                | AP posting never writes the new columns — no accidental double-classification                         |
| JTX-015 | A Customer Invoice with `taxCodeId` set, posted, plus a separately-tagged manual journal entry using the _same_ tax code, same window | `GET /tax-reports/vat-position`                                                                                        | The AP/AR-sourced figure and the manual-sourced figure for that code are each exactly what their own source lines sum to — never double-counted into either figure                              | Double-count prevention, proven end-to-end (§5, §8)                                                   |
| JTX-016 | Any tagged create/update/post/reverse from JTX-001/008/011/012                                                                        | Query `audit_logs` for that entity                                                                                     | `beforeState`/`afterState` line snapshots include the tag fields                                                                                                                                | Auditability, no new audit code path needed                                                           |
| JTX-017 | A manual entry tagged `OUTPUT`, net-credit (normal polarity)                                                                          | `GET /tax-reports/vat-position` in-window                                                                              | Manual bucket for that code shows the credit-minus-debit amount, positive                                                                                                                       | Signed-contribution formula, normal polarity (§5)                                                     |
| JTX-018 | A manual entry tagged `OUTPUT` but net-debit (a correcting/reversing-shaped entry, not created via `/reverse`)                        | `GET /tax-reports/vat-position`                                                                                        | Manual bucket shows a negative contribution for that code — not rejected, not miscategorized                                                                                                    | Signed-contribution formula, "wrong-polarity" correcting entry (§5)                                   |
| JTX-019 | Zero tagged manual lines exist for a legal entity/window                                                                              | `GET /tax-reports/vat-position`                                                                                        | Manual bucket is present and zero/empty, not an error, not omitted                                                                                                                              | Zero-activity baseline (§10)                                                                          |
| JTX-020 | An entry with a manual tagged line posted into a legal entity/window; a second tenant queries the same report                         | `GET /tax-reports/vat-position` as tenant B                                                                            | Tenant B's response never reflects tenant A's tagged line                                                                                                                                       | Tenant isolation for the new query path                                                               |
| JTX-021 | Same, second legal entity within the same tenant                                                                                      | `GET /tax-reports/vat-position` scoped to the other legal entity                                                       | The other legal entity's response never reflects the first's tagged line                                                                                                                        | Legal-entity isolation for the new query path                                                         |
| JTX-022 | `finance.viewer` token                                                                                                                | `GET /tax-reports/vat-position`                                                                                        | 200 (unchanged — already a viewer-accessible read)                                                                                                                                              | RBAC unaffected by this phase                                                                         |
| JTX-023 | `finance.viewer` token                                                                                                                | `POST /journal-entries` with a tagged line                                                                             | 403 (unchanged — create was never viewer-accessible)                                                                                                                                            | RBAC unaffected by this phase                                                                         |
| JTX-024 | The exact e2e scenario already in `vat-position-report.e2e-spec.ts` (§3)                                                              | Re-run unmodified, then re-run again with the same manual entry's line now _tagged_ instead of untagged                | Untagged: identical mismatch behavior to today (regression-proves nothing broke); tagged: the mismatch narrows/disappears from the cross-check while the new per-code manual figure reflects it | The exact gap this phase closes, proven end-to-end against the repository's own pre-existing evidence |
| JTX-025 | Fresh migration, no data                                                                                                              | Apply the new migration                                                                                                | Both new columns exist, both NULL-default, CHECK constraint present, no error                                                                                                                   | Migration correctness, fresh DB (§13)                                                                 |
| JTX-026 | Seeded DB with existing POSTED journal entries (pre-migration data)                                                                   | Apply the new migration                                                                                                | Existing rows get `NULL`/`NULL` (satisfies the CHECK trivially); existing reports/queries against those rows are byte-for-byte unchanged                                                        | Migration correctness, seeded DB, 100% backward compatibility (§13)                                   |
| JTX-027 | Full pre-existing regression suite (unit + e2e)                                                                                       | Run unmodified                                                                                                         | 100% pass, 0 regressions                                                                                                                                                                        | REG gate                                                                                              |
| JTX-028 | Full repository                                                                                                                       | `tsc --noEmit`, `eslint src --ext .ts`, `nest build`                                                                   | Clean                                                                                                                                                                                           | REG gate                                                                                              |
| JTX-029 | `route-role-matrix.spec.ts`                                                                                                           | Run unmodified (no new route exists)                                                                                   | Still 100% pass, no new entries required                                                                                                                                                        | Confirms this phase genuinely adds zero new routes                                                    |

Coverage note: happy path (JTX-001/002/011/012/017), validation (003-007), RBAC (022/023, plus 029 confirming no new surface), tenant/legal-entity isolation (020/021), period boundaries (§10 notes this is inherited, not separately re-tested — the underlying `resolveAndLockOpenPeriod()` mechanism is unmodified and already has its own coverage), posted-entry rules (009/013), reversals (012), AP interaction (014), AR interaction (014's mirror, implied — an equivalent scenario for Customer Invoices), manual journal interaction (001-012, 017-019), reconciliation (015, 024), double-count prevention (014/015), concurrency (§8's tax-code-deactivation-vs-post race — a JTX-030-equivalent black-box concurrency test, deliberately not pre-numbered here since its exact shape depends on locating the repository's existing account-deactivation-vs-post() test to pattern-match, per §8), atomic rollback (implied by 003-007/010 — a validation failure never leaves a partial line), migration (025/026), regression (027/028/029) are all represented.

---

## §12 Test / Verification Plan

- **Unit tests:** `CreateJournalLineDto`'s new both-or-neither validator (mirrors the existing `create-journal-line.dto.spec.ts` pattern for `SingleSidedNonzeroConstraint` exactly — same file, same style, new test cases).
- **Service tests / e2e:** the full JTX-001 through JTX-024 matrix above runs as real HTTP requests against a real NestJS app instance + real PostgreSQL 16, in the existing `test/journal-entries.e2e-spec.ts` (extended) and `test/vat-position-report.e2e-spec.ts` (extended, including re-running and extending the exact existing "manual journal entry" test named in §3/JTX-024) — following this repository's own established e2e convention (`supertest` against `app.getHttpServer()`, `Test.createTestingModule`, direct DB seeding via `getFinanceDb()`/`getPlatformDb()` for fixtures), not a new test harness.
- **PostgreSQL-level tests:** JTX-013 (raw-SQL immutability proof, owner connection, `.rejects.toMatchObject(...)`) and JTX-025/026 (migration tests) require real PostgreSQL — no mocking, matching this repository's own standing rule that DB-level invariants are proven against real Postgres, not simulated.
- **Concurrency test:** the tax-code-deactivation-vs-`post()` race (§8) — a real two-connection/`Promise.all` test against real PostgreSQL, in the same "repeated trials, assert the invariant on every iteration" style this repository already uses (Budgeting's BUD-051/052 being the most recent precedent) if a suitable existing account-deactivation-vs-post() test is not found to extend directly during implementation.
- **RLS tests:** JTX-020/021, using the non-superuser `noryx_app` role for the raw-SQL variant, mirroring Budgeting's RLS-003 and every earlier phase's established pattern.
- **RBAC route matrix:** `route-role-matrix.spec.ts` re-run unmodified (JTX-029) — this phase's entire value in this dimension is proving it adds _zero_ new surface, not adding new entries.
- **Fresh migration test:** apply the new migration to a genuinely empty database, confirm structure (JTX-025).
- **Seeded migration test:** apply to a database with pre-existing, real POSTED journal entries, confirm zero data loss/behavior change (JTX-026).
- **Full regression:** the complete pre-existing unit suite and e2e suite (JTX-027), run unmodified, must pass at 100% — no test file outside the two extended above should need to change.
- **Typecheck / lint / build:** `tsc --noEmit`, `eslint src --ext .ts`, `nest build` (JTX-028), matching every prior phase's gate.

No aspect of this phase requires mocking a concurrency or accounting invariant that mocking would fail to actually prove — every DB-level and concurrency claim above is tied to a real-PostgreSQL test.

---

## §13 Migration / Deployment Plan

**Migration needed:** yes — additive only.

- **Proposed migration number:** `0024` — confirmed by direct inspection of `drizzle/migrations/` on the verified `ac16fa0` baseline: the highest existing migration is `0023_budgeting_phase_1_foundation.sql` (Budgeting Phase 1, delivered in the immediately-preceding work item). No renumbering risk exists — Budgeting is now merged into this same linear history, unlike the still-isolated Fixed Assets branch's own historical `0023` collision (irrelevant here, since that branch remains untouched and unmerged).
- **Collision check:** none found — `0024` is unused in `drizzle/migrations/` on this baseline.
- **RLS:** no new RLS file needed — `journal_lines` is an existing table already covered by `002_journal_engine_rls.sql`; adding nullable columns to an already-RLS-protected table requires no RLS change (confirmed: RLS policies filter rows, not columns).
- **Constraints file:** no new immutability-trigger file needed (§2/§9) — the existing `004_journal_lines_immutability_trigger.sql` already protects the new columns with zero modification. The new CHECK constraint (§6) can be added either inline in the `0024` migration itself (matching how the AP/AR line tables' own implication-CHECKs were added inline in their migrations) or as a small dedicated constraints file (`028_...`) — a minor stylistic choice for implementation, not an architectural one, and does not need CTO adjudication.
- **Forward migration:** `CREATE TYPE journal_line_tax_direction AS ENUM ('INPUT', 'OUTPUT'); ALTER TABLE journal_lines ADD COLUMN tax_code_id uuid REFERENCES tax_codes(id); ALTER TABLE journal_lines ADD COLUMN tax_direction journal_line_tax_direction; ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_tax_direction_requires_code CHECK (...);` — four statements, all additive, all safe to run against a live table with existing rows (no default needed beyond implicit `NULL`, no table rewrite required for a nullable column add in PostgreSQL, no lock beyond the brief `ACCESS EXCLUSIVE` a plain `ADD COLUMN`/`ADD CONSTRAINT` already takes on this repository's other additive migrations).
- **Backfill:** **none** — deliberate (§10). Every pre-existing `journal_lines` row correctly becomes "untagged" (`NULL`/`NULL`), which is the truthful, honest state for historical data whose tax classification was genuinely never captured — inventing a backfill would fabricate data that was never actually recorded.
- **Rollback considerations:** a straightforward `ALTER TABLE journal_lines DROP CONSTRAINT ...; DROP COLUMN tax_direction; DROP COLUMN tax_code_id; DROP TYPE journal_line_tax_direction;` — safe at any point before any row has non-null values in the new columns, and safe even after (drops the classification data, nothing else), since nothing else in the schema references these two new columns (no other table's FK, no other constraint).
- **Fresh DB:** JTX-025 — apply to an empty database, confirm structure directly (`\d journal_lines`, confirm both columns, the CHECK, and the new enum type).
- **Seeded DB:** JTX-026 — apply to a database carrying real, pre-existing POSTED journal entries (mirroring Budgeting's MIG-002 discipline of using genuinely pre-populated data, not an empty seed), confirm those rows are untouched and every existing query/report against them is unchanged.

---

## §14 Scope Boundary

**IN SCOPE:**

- Two new nullable columns + one new enum + one new CHECK constraint on `journal_lines`.
- DTO/validation additions for `taxCodeId`/`taxDirection` on journal lines (create + update).
- Posting-time re-validation of a tagged code's active status.
- Reversal-line tag carry-over.
- A new, additive per-code "manual" figure in the VAT Position Report, sourced from tagged `journal_lines`.
- The corresponding tests (§11/§12) and one additive migration (§13).

**OUT OF SCOPE (this phase does not touch, and no dependency proven to require it):**

- **Multi-Currency / FX** — journal entries remain single-currency (fixed to the legal entity's functional currency, no FX anywhere in this codebase today); this phase introduces no currency concept and depends on none.
- **Reverse charge** — `taxTreatmentEnum` explicitly excludes it today (schema doc comment: "reverse-charge changes the posting shape, which is out of scope"), and nothing in this phase changes posting shape for any document type.
- **Statutory VAT filing** — no export/filing-format concept exists anywhere in Tax/VAT Phases 1-5; this phase adds none.
- **Multi-jurisdiction** — `tax_codes`/`tax_rates` remain per-legal-entity exactly as today; this phase adds no jurisdiction concept.
- **Tax-inclusive pricing** — irrelevant to journal lines, which state raw debit/credit amounts directly, never a gross-price-plus-embedded-tax figure.
- **Expense Management, Fixed Assets, HRMS, Procurement, Inventory** — none of these modules exist yet in this repository's implemented surface (roadmap: PLANNED/not started); this phase has no dependency on and creates no dependency for any of them.
- **Unrelated Finance hardening** (Milestone 3.3-3.5) — explicitly deferred repository-wide per the roadmap's own stated sequencing, unaffected by and unrelated to this phase.
- **Tax _calculation_ on journal lines** — explicitly rejected as a goal, not merely deferred (§5, §15 Alternative 2) — a manual journal line has no base amount to calculate a percentage against.
- **A new "tax adjustment" workflow/document type** — a tagged manual journal entry already suffices for this use case (§5); no new concept is introduced.
- **Backfilling historical journal lines with a guessed tax code** — explicitly rejected (§13).
- **Any change to AP/AR posting code, AP/AR schema, or AP/AR reporting logic** — the four existing tax-bearing line tables and their services are untouched by every read/write path this phase introduces (§2, §4, §5).

**DEFERRED (real, named, but not this phase's problem to solve):**

- A dedicated index on `journal_lines.tax_code_id`, if the new report query's performance ever warrants one (§6) — a trivial, independent follow-up, not a blocking dependency.
- Whether the report's headline totals should include manual-tagged activity — resolved by §16 Decision 3, not silently deferred, but its _implementation_ naturally happens as part of this same phase once decided (not a separate future phase).

---

## §15 Risks / Alternatives

**Decision area: how should a manually-tagged journal line's tax contribution be calculated?**

- **Option A — [PROPOSED] Classification only; the line's own existing debit/credit amount is used directly (signed per §5's formula), no new calculation.** Consequences: trivial to implement and reason about, cannot introduce a rounding discrepancy (no division happens at all), matches how a manual journal preparer already thinks about the entry (they typed the exact amount they wanted posted). Accounting implication: correct — a manual line's amount is already the intended figure by definition; there is nothing to "calculate." Compatibility: fully additive, zero risk to existing AP/AR calculation logic. Complexity: minimal. Operational consequence: none. **Recommendation: adopt.**
- **Option B — Reuse `calculateTaxAmountMinor()`/`resolveEffectiveRate()` to _compute_ a suggested tax amount from some user-supplied "base amount" on the line.** Consequences: requires inventing a "base amount" input that does not correspond to anything a journal line actually has today (a journal line's debit/credit _is_ the amount, full stop — there is no separate net-vs-tax split concept on a single double-entry line the way there is on an AP/AR document's line-item). Accounting implication: would require either adding a third amount field to every journal line (a real schema/semantics expansion well beyond "coverage") or silently repurposing debit/credit as "tax amount only," which breaks double-entry balancing in a way this codebase's own balance-invariant trigger would then have to specially accommodate. Compatibility: high risk — touches the core Journal Engine's balancing semantics. Complexity: substantially higher, for no evidenced requirement (neither prior discovery document, nor the roadmap, nor the demonstrating e2e test in §3 calls for calculation — only for _classification/attribution_). **Recommendation: reject.** Recorded here so it is not silently reinvented later.

**Decision area: should the manual bucket merge into the report's existing headline `outputTaxMinor`/`inputTaxMinor`, or stay a separate additive figure?**

Full options laid out as §16 Decision 3, below — this is the single most consequential choice in this proposal (it changes the meaning of numbers existing report consumers may already rely on), so it is not resolved here by recommendation alone; both options' full consequences are stated in §16 for explicit CTO adjudication.

**Decision area: explicit `tax_direction` field vs. inferring direction from the account/side.**

- **Option A — [PROPOSED] Explicit `tax_direction` field, set by the preparer.** Consequences: unambiguous, no inference logic to get wrong, consistent with this schema's existing posture that `tax_codes` itself carries no direction (direction is always contextual) — a manual journal line's context (unlike a bill or an invoice) carries no implicit direction, so making it explicit here is the only way to avoid guessing. **Recommendation: adopt** (§16 Decision 1).
- **Option B — Infer direction from which GL account the line hits (matching against `tax_codes.apTaxAccountId`/`arTaxAccountId`, or the AP/AR-settings singletons).** Consequences: fragile — a per-code override account (Phase 5) can coincide with an account also used for unrelated postings, multiple codes can share one account, and a preparer could legitimately want to tag a line touching a _non-tax_ account (e.g., correcting the revenue side of a tax-related manual entry, as in the very e2e test in §3, which credits/debits Revenue, not a tax account, on one of its two lines) — inference from the account would silently produce wrong or missing classification in exactly the cases this phase most needs to get right. **Recommendation: reject.**
- **Option C — Infer direction from debit vs. credit side, using "input tax is normally a debit, output tax is normally a credit" as a heuristic default.** Consequences: breaks immediately for the correcting/reversing-entry case (§5, JTX-018) — a legitimate `OUTPUT`-direction correcting line is deliberately net-debit, so a side-based heuristic would misclassify exactly the entries most likely to need this feature (adjustments/corrections). **Recommendation: reject.**

**Decision area: should this phase's tests physically extend the existing named e2e test from §3, or write a wholly new one?**

Not a CTO-level decision — a straightforward implementation choice, resolved here for completeness: **[PROPOSED]** extend the existing test (JTX-024) rather than duplicate it, since it is the single clearest piece of executable evidence this repository already has for the exact problem this phase solves, and re-running it unmodified alongside a new tagged variant is the strongest possible proof the gap is actually closed.

---

## §16 Explicit CTO Decisions Required

**Decision 1 — Explicit `tax_direction` field vs. inferring direction.**
_Options:_ (A) explicit nullable `tax_direction` enum field on `journal_lines`, set by the preparer whenever `tax_code_id` is set [PROPOSED/recommended]; (B) infer from the account touched; (C) infer from debit/credit side.
_Consequences:_ (A) is unambiguous but requires the preparer to know and correctly state direction; (B)/(C) remove that burden but are demonstrably fragile against real cases this repository already exercises (§15).
_Recommendation:_ (A).
_Dependency:_ blocks §6 (schema), §7 (DTO shape), §11 (JTX-001 through JTX-007).

**Decision 2 — Does a reversal carry the tag forward onto the reversing line?**
_Options:_ (A) yes, same code/direction, amount sign flips with the rest of the line [PROPOSED/recommended]; (B) no, a reversal's line is always untagged regardless of the original.
_Consequences:_ (A) keeps a tax-related reversal visible to the VAT report exactly as the original was; (B) is mechanically simpler but makes the report silently blind to a reversal's tax impact, reopening a smaller version of the exact gap this phase exists to close.
_Recommendation:_ (A).
_Dependency:_ `completeReversalPosting()`'s line-building step (§4 point 4); JTX-012.

**Decision 3 — Does the manual per-code figure merge into the report's existing headline `outputTaxMinor`/`inputTaxMinor` totals, or stay a separate, clearly-labelled additive figure?**
_Options:_

- (A) **Merge into the headline totals.** The report's `outputTaxMinor`/`inputTaxMinor` become the true, complete VAT position — every posted tax-classified activity of any origin. This directly and fully closes the reconciliation gap §3 demonstrates (the report's own headline number would then equal what `glCrossCheck` measures, once all manual activity is tagged). Consequence: **changes the meaning of an existing, already-relied-upon response field** for any consumer reading `outputTaxMinor`/`inputTaxMinor` today — a materially observable behavior change for anyone who has integrated against the current report, even though the _shape_ of the response is unchanged.
- (B) **Keep headline totals AP/AR-only** (byte-for-byte current meaning, current values, for any legal entity with no tagged manual activity — and even for one that adopts tagging, the headline never moves), with the manual figure surfaced only in new, additive per-code fields — mirroring Phase 5's own explicit discipline of never changing the meaning of the pre-existing 8 singleton `glCrossCheck` fields when it added its own new ones.
  _Recommendation:_ this document recommends (A) on the grounds that "VAT position" should mean the entity's true, complete tax position, and that is the explicit, named purpose behind selecting this work item at all — but flags it, deliberately, as the one choice in this whole proposal that is a genuine behavior change to an existing, already-shipped API response, not merely an additive extension, and therefore not something to silently decide inside an architecture document.
  _Dependency:_ blocks §6 (no schema impact either way), §10 (response shape), §11 (JTX-015/017/018/019/024's exact assertions).

**Decision 4 — Should `netSupplyValueMinor`-equivalent be `null`/omitted or `0` for the manual bucket?**
_Options:_ (A) `null`/omitted, honestly signaling "not applicable" [PROPOSED/recommended]; (B) `0`, keeping every per-code entry's field set structurally identical regardless of source.
_Recommendation:_ (A) — see §10.
_Dependency:_ exact response DTO shape for §7/§10; low-risk, easily revisited, but recorded here rather than silently decided.

None of the four decisions above requires new external business input to resolve (no unresolved business question blocks meaningful architecture — §17/§18) — each is a closed technical/product choice this document has fully reasoned through, with a stated recommendation, awaiting only CTO sign-off before implementation begins.

---

## §17 Definition of Done

- **Functionality:** all seven route behaviors in §7 implemented exactly as specified (once §16 is resolved); a manually-tagged journal line survives create/update/post/reverse with its classification intact and correctly validated at each step.
- **Accounting correctness:** the signed-contribution formula (§5) produces correct, sign-verified figures for both directions and for both normal-polarity and correcting-entry-shaped lines (JTX-017/018); double-counting against AP/AR-sourced tax is proven absent, not merely argued (JTX-014/015).
- **Security:** tenant isolation (JTX-020), legal-entity isolation (JTX-021), RBAC unchanged and re-verified (JTX-022/023/029), posted-line immutability proven at the database level (JTX-013).
- **Concurrency:** the tax-code-deactivation-vs-`post()` interleaving (§8) proven safe across real repeated trials against real PostgreSQL.
- **Testing:** every scenario in §11 executed — not inferred from code inspection — with PASS/FAIL/BLOCKED recorded per the same Acceptance Discipline this repository's most recent work item (Budgeting) already established and demonstrated.
- **Migration:** JTX-025 (fresh) and JTX-026 (seeded, real pre-existing data, zero loss/behavior change) both pass.
- **Documentation:** `docs/roadmap.md` and `docs/project/PROJECT_STATE.md` updated to reflect this phase's actual delivered state (matching how Phases 1-5 and Budgeting were each recorded), plus a completion report matching the established format (baseline/final SHA, files changed, summaries, tests executed, acceptance results, self-review, confirmations).
- **Regression:** the complete pre-existing unit and e2e suites pass unmodified at 100%; typecheck/lint/build clean.
- **Operational readiness:** no new operational surface (no new service, no new external dependency, no new config) — deployment is exactly "run the new migration, deploy the updated `sphere-finance` service," identical in kind to every prior Tax/VAT phase.

---

## §18 Discovery Conclusion

**READY FOR CTO REVIEW.**

The candidate — Tax/VAT Phase 6, Manual Journal Tax Coverage — is confirmed, by direct repository verification in this session (§1-§3), as the correct next Finance work item under every criterion the CTO specified: all material dependencies already exist and are stable on `main` (§2, §3); it is completable as one coherent work item with no prerequisite phases (§3, §4); it belongs to the current, locked Finance-first Tax/VAT strategy and is explicitly named, twice, in this repository's own prior approved discovery documents and its current roadmap, not invented (§0, §3); it requires no unresolved external business input to design (§16 — every open point is a closed technical/product choice with a stated recommendation, not a missing business fact); it pulls in no unrelated future capability (§14); it has a small, bounded implementation surface (two nullable columns, one enum, one CHECK, zero new tables/routes/RLS files — §4, §6, §7); it reuses the Journal Engine's, Tax Configuration's, and VAT Position Report's existing infrastructure near-completely (§2, §4, §8, §9); it is fully testable and verifiable, including every accounting/concurrency/security invariant, against real PostgreSQL (§11, §12); it does not duplicate any already-completed functionality (§2, §14); and it does not reopen any completed work item — Budgeting Phase 1, and every completed Tax/VAT phase, remain untouched by everything in this proposal.

This document is a proposal, not an authorization. No implementation, commit, branch, or push has occurred or is authorized by this document (§16 governance framing). Implementation begins only under a separate, explicit CTO implementation-authorization prompt, after §16's four decisions are resolved.
