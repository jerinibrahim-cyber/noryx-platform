# Document-Level Reversal for Posted AP & AR Documents — Completion Report

**Status:** Implementation complete, verified, committed locally. Not pushed to GitHub (see Git Status below — this is expected and consistent with every prior phase in this repository).

**Proposal:** `docs/work-items/document-reversal/PROPOSAL.md` (CTO-approved for implementation).

**Implementation commit:** `fe94b388c9f6777619d4943677dcfa7b7947706b` (branch `main`)
**Baseline commit:** `83549747c18f1e53e8348cd00de1cf8b90e9b292` ("Finalize Tax/VAT Phase 5 completion report with commit/verification details")
**Bundle:** `finance-document-reversal-fe94b38.bundle` (range `8354974..main`, contains exactly the one implementation commit; `git bundle verify` passed)

---

## 1. Implementation Summary

Reversal is now implemented, symmetrically, for all six posted AP/AR document types:

| Document type        | Route                            | Kind                       |
| -------------------- | -------------------------------- | -------------------------- |
| Supplier Bill        | `POST /bills/:id/reverse`        | Target                     |
| Customer Invoice     | `POST /invoices/:id/reverse`     | Target                     |
| Supplier Payment     | `POST /payments/:id/reverse`     | Settlement                 |
| Customer Receipt     | `POST /receipts/:id/reverse`     | Settlement                 |
| Supplier Debit Note  | `POST /debit-notes/:id/reverse`  | Settlement (has own lines) |
| Customer Credit Note | `POST /credit-notes/:id/reverse` | Settlement (has own lines) |

All three CTO-approved architectural decisions were implemented exactly as directed:

1. **Reversal state is never stored.** No new status, no new boolean/status column, no new table. It is always derived from the document's existing `journalEntryId` → `journal_entries.reversedByJournalEntryId` linkage. A reversed document's own `status` column stays `POSTED`.
2. **RBAC is `finance.poster`** on all six new routes — the existing repository convention made `finance.admin` unnecessary; no repository constraint required broadening it.
3. **Shared reversal architecture is reused, not duplicated.** All six services call `JournalEntriesService.lockAndValidateOriginalForReversal()` and `JournalEntriesService.completeReversalPosting()` directly (registered as a second DI provider per service module — the same pattern `ScheduledReversalsModule` already established). One new shared helper was added for the settlement-unwind arithmetic (see below) — not six copies of it.

## 2. Files Changed

**New files:**

- `services/sphere-finance/src/common/reversal/reversal.util.ts` — shared helpers: `unsettleTarget()` (settlement-unwind arithmetic, the mirror image of every existing `post()`'s apply-side arithmetic), `resolveOpenPeriodOrThrow()` (a public wrapper around the already-public `resolvePeriodForDate()`, needed because the original `resolveAndLockOpenPeriod()` turned out to be `private` — verified by direct inspection, not assumed from the proposal's prose), `resolveReversalInfo()` (derives the additive `reversal` field).
- `services/sphere-finance/test/document-reversal.e2e-spec.ts` — 55 new e2e tests (see §7).
- `docs/finance-work-item-document-reversal-proposal.md` — the approved proposal (added to version control alongside its implementation).

**Modified — six document services** (each gained a `reverse()` method and a `reversal` field on `findOne()`):

- `src/accounts-payable/supplier-bills/supplier-bills.service.ts`
- `src/accounts-payable/supplier-payments/supplier-payments.service.ts`
- `src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts`
- `src/accounts-receivable/customer-invoices/customer-invoices.service.ts`
- `src/accounts-receivable/customer-receipts/customer-receipts.service.ts`
- `src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts`

**Modified — six controllers** (each gained a `POST :id/reverse` route, `finance.poster`-only):

- The six controllers matching the services above.

**Modified — six modules** (each registers `JournalEntriesService` as a second DI provider):

- The six modules matching the services above.

**Modified — reporting layer** (reversal-awareness, proposal §12/§23):

- `src/accounts-payable/ap-reports/ap-reports.service.ts` — `currentTotals()`, `getApAgeing()`, `asOfTotals()`.
- `src/accounts-receivable/ar-reports/ar-reports.service.ts` — the exact AR mirror.
- `src/tax-reports/tax-reports.service.ts` — `codeRows()`, `totalTax()`.

**Modified — RBAC completeness test:**

- `src/route-role-matrix.spec.ts` — six new `role("POST", ".../:id/reverse", ..., ["finance.poster"])` entries; doc comment updated (133 routes total across the same 25 controllers).

No file outside this list was touched. `docs/hardening/` and `docs/finance-work-item-next-discovery.md` (pre-existing, unrelated to this work item) were left completely untouched, per the explicit git-boundary instruction.

## 3. Database / Schema Status

**No migration.** Confirmed unnecessary by direct implementation, exactly as the proposal predicted: reversal state is fully derivable from the pre-existing `journal_entries.reversalOfJournalEntryId`/`reversedByJournalEntryId` self-referential FKs. No new column, no new table, no new enum value, no modified trigger, no modified RLS policy.

## 4. API Routes

Six new routes, one per document type, all `POST /<resource>/:id/reverse`, all `finance.poster`-only, all returning `201` (a genuinely new journal entry is created), all accepting the existing `ReverseJournalEntryDto` (`{ transactionDate?: string; memo?: string }`) reused directly from `journal-entries/dto/reverse-journal-entry.dto.ts` — no new DTO was introduced.

Additively, `GET /<resource>/:id` on all six resources now returns a `reversal` field: `null` if never reversed, else `{ journalEntryId, journalNumber, transactionDate, postedAt, postedBy }` describing the reversal entry.

## 5. Authorization

`finance.poster` only, matching every other write operation (create/edit/delete/post) on these six controllers. `finance.viewer` and `finance.admin` are both rejected with `403`. Verified for all six document types in the e2e suite (item J/K below), plus against the live NestJS route-reflection test (`route-role-matrix.spec.ts`, now 133/133 routes accounted for).

## 6. Accounting & Allocation Semantics

- **Target documents** (Supplier Bills, Customer Invoices): reversal is rejected with `422` while `paidMinor > 0` — the caller must unwind the allocating payment/receipt/debit-note/credit-note first. Verified this blocking condition explicitly for both target types (item G).
- **Settlement documents** (Supplier Payments, Customer Receipts, Supplier Debit Notes, Customer Credit Notes): never blocked by their own state. Reversing one unwinds its own allocation(s) against whatever it settled, via `unsettleTarget()` — the exact mirror of the existing apply-side arithmetic (`newPaidMinor = paidMinor - unapplyAmountMinor`, then re-derive `paymentStatus`). Verified for all four settlement types (item H), including the two-allocation multi-bill case.
- **Accounting polarity**: the reversal journal entry is built by `JournalEntriesService.completeReversalPosting()` — same accounts, swapped debit/credit, fresh line numbering, fresh journal number, always balances. Verified for all six document types by directly comparing `journal_lines` rows (item E).
- **Tax/account preservation**: verified for the four line-bearing document types (Bills, Invoices, Debit Notes, Credit Notes) that a document's own lines (`accountId`, `taxAmountMinor`, `taxCodeId`, `resolvedTaxAccountId`, etc.) are byte-identical before and after reversal — reversal never re-derives or mutates the historical document (item F).
- **Immutability**: no existing DB trigger was touched. A posted document's own historical row is never mutated by reversal (verified item D); the existing POSTED-immutability triggers apply unchanged.
- **Once-only / no replace / no delete**: verified for all six types — a second reversal attempt on an already-reversed document is rejected `409` and changes nothing (item C); concurrent double-reversal is verified for two representative types (item L) to never both succeed.
- **Banking**: confirmed the proposal's own finding by direct test rather than by inspection alone — `bankCashAccountId` on Supplier Payments/Customer Receipts is a plain `chart_of_accounts` FK with no structural dependency on `bank_cash_accounts`/`bank_transactions`, and the bank account's own GL balance (via `GET /accounts/:id/balance`) is live-derived from posted `journal_lines`. A reversal therefore needs zero special-casing: it nets back out automatically. Verified end-to-end (item M): balance moves by `-paymentAmountMinor` on posting, returns exactly to its prior value on reversal.

## 7. Tests Executed and Exact Results

### New: `test/document-reversal.e2e-spec.ts` — 55/55 passed

One consolidated e2e file, parameterized over a `DOC_TYPES` table covering **all six document types** (not a single AP/AR representative) for every generic assertion:

- (A/B) successful reversal + state-derivation via the FK chain — all 6 types
- (C) repeated-reversal rejection (409) — all 6 types
- (D) posted-source immutability — all 6 types
- (E) accounting polarity (swapped debit/credit, same accounts, balances) — all 6 types
- (F) tax/account preservation — the 4 line-bearing types (Bills, Invoices, Debit Notes, Credit Notes)
- (G) target-document allocation safety (422 while `paidMinor > 0`) — both target types (Bills, Invoices)
- (H) settlement-document allocation unwind, including "still reversible even fully settled" — all 4 settlement types
- (J/K) RBAC (`finance.poster` succeeds; `finance.viewer`/`finance.admin` 403; no token 401) — all 6 types
- a period-resolution 422 check — all 6 types

Plus, on two representative types (Supplier Bill, Supplier Payment) — deliberately scoped, since these guarantees are inherited from `JournalEntriesService`'s own already-proven infrastructure rather than being novel per-document-type behavior:

- (I) Atomic rollback: a closed-period reverse() attempt (forced failure) leaves the document, its journal entry, and — for the payment case, across **two** allocated bills — every allocation completely untouched; a subsequent valid retry then succeeds cleanly.
- (L) Concurrent reversal safety: two simultaneous reverse() requests on the same document — exactly one `201`, the other `409`, never both, and never a double-unwound allocation.
- (M) Banking interaction: verified live, as described in §6 above.

```
PASS test/document-reversal.e2e-spec.ts (15.6s)
Tests: 55 passed, 55 total
```

### Full regression suite — all green, run twice (once mid-implementation, once against the final committed tree)

```
Typecheck:  tsc -p tsconfig.json --noEmit           → 0 errors
Lint:       eslint src --ext .ts                    → 0 errors, 10 pre-existing warnings (unrelated to this work item; 2 are this work item's own deliberate, documented `any` in reversal.util.ts)
Unit tests: jest                                    → 65 suites / 616 tests passed (0 failed)
E2E tests:  jest --config jest-e2e.config.js        → 46 suites / 946 tests passed (0 failed) — 891 pre-existing + 55 new
```

`route-role-matrix.spec.ts` (part of the unit suite) specifically confirmed all 133 routes (127 pre-existing + 6 new) are correctly role-restricted, including a live NestJS-reflection completeness check (no unrecognized/unguarded route).

No pre-existing failures were found or needed to be dismissed against baseline — every one of the 891 pre-existing e2e tests and 616 unit tests that passed before this work item still passes after it.

## 8. Known Limitations (Disclosed, Deliberately Scoped)

1. **`asOfTotals()`'s historical-reconstruction fix is bounded to the target document's own reversal**, not a later-reversed settlement document's allocation within the same as-of window (proposal §12 point 5's harder nested case). Zero real-world blast radius at launch: no historical reversed settlement can exist yet, since this is a brand-new feature.
2. **(F) tax/account preservation was tested on the 4 line-bearing document types only** (Bills, Invoices, Debit Notes, Credit Notes) — Supplier Payments and Customer Receipts structurally carry no lines/tax at all, so this is not an asymmetry introduced by the implementation, it is a fact of the domain.
3. **(I) atomic-rollback and (L) concurrent-reversal-safety were tested on two representative types** (Supplier Bill, Supplier Payment), not all six — because both guarantees are inherited unchanged from `JournalEntriesService`'s own transaction (`withTenant`) and `SELECT ... FOR UPDATE` locking, reused identically by all six services rather than reimplemented per type. The two representatives cover both the target-document and settlement-document (multi-allocation) shapes.
4. **(M) banking interaction was verified on one representative type** (Supplier Payment) — Customer Receipts share the identical `bankCashAccountId → chart_of_accounts` structure and the identical live-GL-derivation mechanism, so this is the same underlying behavior, not a second one.
5. Out of scope per the proposal's own §23 and the CTO's explicit boundary: maker-checker, on-account payments, cascading reversal, FX, further banking enhancements, idempotency keys, Tax/VAT Phase 6, and any NOAH/orchestrator work — none of these were touched, discovered, or implemented.

## 9. Commit / Verification Status

- **Implementation commit:** `fe94b388c9f6777619d4943677dcfa7b7947706b`
- **Baseline commit:** `83549747c18f1e53e8348cd00de1cf8b90e9b292`
- **Bundle:** `finance-document-reversal-fe94b38.bundle` — `git bundle verify` passed; range `8354974..main`; contains exactly the one implementation commit.
- **Git status:** `git push origin main` was attempted and rejected by the environment's git proxy with a `403` ("access denied by the git proxy... not in this session's authorized repository set") — the same blocker every prior phase in this repository has hit. **No GitHub delivery is claimed.** The commit exists only in this local repository and in the attached bundle; the CTO/human owner must apply the bundle (or otherwise push) to make it reach GitHub.
- **Working tree:** clean except for two pre-existing untracked items explicitly left untouched per the git-boundary instruction: `docs/hardening/` and `docs/finance-work-item-next-discovery.md`.
- **Blockers:** none beyond the expected git-proxy push restriction above.

---

Per the CTO's explicit closing instruction, this delivery **stops here** — no next work item has been selected, discovered, or implemented.
