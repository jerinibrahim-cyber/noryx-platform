# Generic Accrual & Deferral Recognition Engine — Targeted Engineering Discovery

**Discovery type:** Targeted Engineering / Architecture Discovery
**Candidate:** D (from `finance-next-capability-discovery/DISCOVERY.md`) — project-scoped WIP explicitly excluded
**Implementation status:** NOT AUTHORIZED
**Delivery status:** NOT AUTHORIZED
**Date:** 2026-09-22

---

## 1. Executive Summary

This discovery answers the CTO's core architectural question — what reusable, transactionally safe, period-driven posting primitive NoryX should build for Generic Accrual & Deferral Recognition — using only repository evidence at baseline `7060c676080352de57a5a43341525d9bc55c44c4`.

Headline findings:

1. **Baseline verified.** `origin/main` HEAD matches the stated canonical baseline exactly. A new discovery branch (`discovery/accrual-deferral-engine-2026-09`) was created from it, not from the prior `discovery/finance-next-capability-2026-09` branch, per the authorization's explicit instruction not to assume that branch is current.

2. **No repository evidence of a prior Fixed Assets implementation was found.** The authorization's §2 describes historical Fixed Assets implementation work that was reviewed and postponed/cancelled for architectural reasons. An exhaustive search — `git log --all` across every reachable local and remote branch, commit-message grep, file-name grep, an `origin/main` PR listing attempt, and a full-text search of the working tree and `docs/archive/` — found no Fixed Assets schema, migration, service, controller, test, branch, or archived proposal anywhere in this repository's reachable history. `docs/archive/` contains only `orchestrator-abandoned/`. The only appearances of "Fixed Assets" anywhere in the repository are a single `roadmap.md` capability-tree line marked `(PLANNED)` and passing mentions in unrelated work-item documents (e.g. listing it as a sibling roadmap item). **This is reported as a discrepancy, not silently assumed away and not treated as a STOP condition** (it matches none of the ten literal STOP conditions in §32) — §2's "learn from history" instruction could not be executed against actual prior code because no such code is reachable from this repository. Section 20 (Fixed Assets Reuse Test) is therefore a structural/architectural reuse test only, not a validation against real prior implementation evidence.

3. **`scheduled_reversals` (migration `0016`, service commit `e04dd58`) is a proven, single-occurrence, date-driven posting primitive** — not a recurring/multi-period engine, and it has not been touched by any commit since its introduction. Its `claimAndExecuteOne()` algorithm (`FOR UPDATE SKIP LOCKED` claim → lock the original entry → lock/resolve the period → post via the *same, unmodified* `JournalEntriesService.completeReversalPosting()` → transition to a terminal status → write to the shared `audit_logs` table, all in one transaction) is exactly the shape of primitive the CTO's core question asks for, and is reused here as the direct architectural model — not copied, not extended, not modified.

4. **Accrual and Deferral are structurally asymmetric, and this changes the shape of what needs to be built.** A "recognize now, reverse automatically on a fixed future date" Accrual is **already fully expressible today** by composing two existing, unmodified capabilities — a manual journal entry (`create()` + `post()`) and `scheduled_reversals` — with no new schema and no new posting primitive. Deferral is fundamentally different: it requires **N system-generated journal entries from one schedule, one per recognition period**, which nothing in this codebase can produce today (`scheduled_reversals` produces exactly one journal entry per row, ever). The genuinely new primitive this discovery proposes is scoped to that multi-occurrence need, not to Accrual.

5. **No scheduling/queue/worker infrastructure exists anywhere in this codebase** (`package.json` dependency audit and full source grep both confirm — no `@nestjs/schedule`, no cron, no queue, no worker library). `scheduled_reversals`' own due-processing is exposed as an on-demand API route (`POST /scheduled-reversals/process-due`), not an automatic timer. Building scheduler infrastructure is explicitly out of scope (§30/§31 of the authorization); the proposed execution model reuses the identical on-demand-route pattern.

6. **The proposed primitive is two new tables, one new service reusing existing Accounting Core/period/audit machinery, and one new on-demand route** — no new role, no new audit system, no new account-type taxonomy, no scheduler, no queue, and no change to any existing table (`scheduled_reversals` included). The Rework/Over-Engineering Test (§26 of the authorization, Section "Rework / Over-Engineering Test" below) is answered explicitly against all seven of the CTO's questions.

7. Several genuine open decisions surfaced during this discovery — most significantly whether "settlement-triggered" (rather than fixed-date) Accrual reversal is actually required, and how a Deferral occurrence that falls due in a period that later closes before execution should be handled — are recorded in Section 25 and are explicitly **not** resolved here, per the authorization's prohibition on inventing accounting behavior.

No production code, schema, test, or governance-document changes were made. Only the discovery artifact was created and committed, on the new discovery branch, per §30.

---

## 2. Repository Baseline

| Item | Value |
|---|---|
| Repository | `jerinibrahim-cyber/noryx-platform` |
| Stated canonical baseline | `7060c676080352de57a5a43341525d9bc55c44c4` |
| Verified `origin/main` HEAD (fresh `git fetch origin main`) | `7060c676080352de57a5a43341525d9bc55c44c4` — **exact match** |
| Discovery branch | `discovery/accrual-deferral-engine-2026-09`, created via `git worktree add -b ... 7060c676080352de57a5a43341525d9bc55c44c4` |
| Working tree at branch creation | CLEAN |
| Prior discovery branch (`discovery/finance-next-capability-2026-09`) | Present locally at commit `c978d68`, **not reused as a base** — a fresh branch was cut from `origin/main`, per the authorization's explicit instruction |
| Prior discovery commit | `c978d686e47aa5c19a0e8519e8cc2e4e2c903321` (parent `7060c676080352de57a5a43341525d9bc55c44c4`) — confirmed as an ancestor-adjacent, non-conflicting sibling of this discovery, not built upon |
| Unrelated stale workspace | `/root/noryx-platform` (a separate, pre-existing checkout) is on branch `feat/tax-vat-phase-6-manual-journal-tax-coverage` at `ac16fa0e...`, with uncommitted changes left over from earlier session work. It is **not** part of `main`'s history reachable from this baseline and was not used for this discovery — this mirrors the same distinction made in the prior Finance Next Capability Discovery. It is noted for completeness, not as a STOP condition. |

### Relevant Finance commit history (established via `git log --oneline --follow`)

| Area | Commit(s) |
|---|---|
| Accounting periods + journal draft CRUD (2c-1) | `383004d` |
| Journal posting, numbering, reversal (2c-2) | `9f9fb05` |
| Scheduled Reversal for Accruals and Other Timing Adjustments (Revision 2) | `e04dd58` — the **only** commit that has ever touched `services/sphere-finance/src/scheduled-reversals/` |
| Tax/VAT Phase 6 (touched `journal-entries.service.ts` for tax-line reversal carry-through, not the posting/locking logic itself) | `908b930` |
| Full migration sequence | `0000`–`0024` (25 files), all present and in order; `0016_scheduled_reversals.sql` is the only migration that created `scheduled_reversals` |

### Unmerged / historical branches relevant to this capability

`git fetch origin --prune` plus `git branch -r` and `git log --all --oneline -i --grep="fixed.asset\|asset"` were used to enumerate every reachable remote branch and every commit message mentioning "asset" on any branch. Result: **no branch, and no commit beyond passing roadmap/discovery-document references, relates to Fixed Assets.** Live remote branches are limited to `main`, two `chore/*` governance branches, several `dependabot/*` dependency-bump branches, one already-delivered `feat/tax-vat-phase-7-...` branch, and three historical `docs/noah-*`/`chore/noah-*`/`chore/orchestrator-*` branches related to the abandoned orchestrator project (per `DEC-009`). None relate to Accrual, Deferral, or Fixed Assets. GitHub PR history could not be queried directly (no `gh` CLI, and the session's GitHub API access is not scoped to this repository for arbitrary PR search) — the git-level search above is the full extent of independently verifiable evidence.

---

## 3. Governance Verification

Read fresh from this baseline (identical content to what was independently verified during the immediately prior Finance Next Capability Discovery, since both discoveries share the same `7060c67` baseline):

- `docs/project/PROJECT_STATE.md` — confirms the manual governance model, Orchestrator/NOAH permanent abandonment, and the full Repository Implementation State through Tax/VAT Phase 7. **Read only — not modified.**
- `docs/project/DECISIONS.md` — DEC-001 through DEC-010 read in full. DEC-004 ("Finance-First; No Invented Next Feature") and DEC-009/DEC-010 (manual governance model, Orchestrator abandonment) are active and were respected throughout: this discovery does not select or implement a next feature, and treats Claude strictly as "Senior Engineer / primary coder" performing discovery only, per DEC-010's role boundaries. **Read only — not modified.**
- `docs/roadmap.md` — confirms Fixed Assets is listed only as `(PLANNED)` in the capability tree (line 107 in this baseline), consistent with Finding 2 above (no implementation evidence exists despite the roadmap placeholder). **Read only — not modified.**
- `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md`, `CLAUDE_ENGINEERING_PROTOCOL.md`, `NORYX_CTO_COPILOT_PROTOCOL.md`, `NORYX_ANTIGRAVITY_DELIVERY_PROTOCOL.md`, `CLAUDE.md` — all consistent with the manual serialized model; no orchestrator/autonomous-runtime language in active force. **Read only — not modified.**

**Governance Verification: PASS.** No conflict between this authorization and current governance was found.

---

## 4. Existing Accounting Core Analysis

Read in full: `services/sphere-finance/src/journal-entries/journal-entries.service.ts` (1,054 lines).

The canonical path every accounting entry in this codebase must use:

- **`create()`** — inserts a `DRAFT` journal entry + lines. Not used by system-generated recognition postings (see Section 8 — recognition entries are never editable drafts, the same reasoning `completeReversalPosting()` already applies to reversals).
- **`post()`** — the four-gate transition DRAFT → POSTED: (1) `SELECT ... FOR UPDATE` on the entry as the *first* statement via `findByIdInTx(..., { forUpdate: true })`; (2) status must be DRAFT; (3) ≥ 2 lines; (4) debits === credits (backed by a DB-level deferred balance trigger regardless); (5) every line's account is **re-validated** at posting time, independent of create-time validation; (6) the covering **OPEN** accounting period is resolved and locked (`resolveAndLockOpenPeriod`); (7) the journal number is allocated atomically (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, never `MAX(...)+1`); (8) the transition is committed touching only the intended columns; (9) an `audit_logs` row is written in the same transaction.
- **`reverse()` / `reverseInTx()` / `lockAndValidateOriginalForReversal()` / `completeReversalPosting()`** — the decomposition `scheduled_reversals` was built to reuse. `completeReversalPosting()` is explicitly documented as **"the ONLY place a reversal is ever built or posted anywhere in this codebase — never duplicated, never a second posting engine."** It takes an *already-locked* original and an *already-resolved-OPEN* period, builds lines, inserts, allocates a number, posts, links the original via exactly one column (enforced narrowly by `003_journal_entries_immutability_trigger.sql`), and writes three audit rows (REVERSE on the original, CREATE + POST on the new entry) — all as one atomic sequence with no intermediate DRAFT state.
- **`resolvePeriodForDate()`** — the non-throwing, `{kind: "OPEN"|"CLOSED"|"NOT_FOUND"}` period-resolution primitive introduced specifically for `scheduled_reversals` to branch on without throwing (its throwing wrapper, `resolveAndLockOpenPeriod()`, is what `post()`/`reverse()` use). This is already a generically reusable building block, not capability-specific.
- **`allocateJournalNumber()`** — race-free, scoped per legal entity, inside the same transaction as posting (so a failed post never burns a number).

**Tenant/legal-entity isolation:** every method threads `tenantId`/`legalEntityId` explicitly through `withTenant()` (Postgres `SET LOCAL`-based RLS scoping, `packages/db-core`'s `withTenantScoped()`), plus an explicit `eq(...)` predicate on every query — belt-and-braces, not RLS alone.

**Immutability:** `003_journal_entries_immutability_trigger.sql` blocks mutation of a POSTED entry except the one narrow `reversedByJournalEntryId` linkage column.

**Conclusion:** any new recognition posting mechanism must call into this exact `completeReversalPosting()`-shaped sequence (build lines → insert → allocate number → post → audit), reusing `resolvePeriodForDate()` for period handling — never re-implement balance validation, numbering, or period locking independently. This is a hard constraint, not a design option.

---

## 5. Existing Scheduled Reversal Analysis

Full inspection: `services/sphere-finance/src/scheduled-reversals/scheduled-reversals.service.ts` (551 lines), `scheduled-reversals.controller.ts` (137 lines), migration `0016_scheduled_reversals.sql`, constraint `024_scheduled_reversals_immutability_trigger.sql`, and both e2e spec files (`scheduled-reversals.e2e-spec.ts`, `scheduled-reversals-concurrency.e2e-spec.ts`).

### What it already solves

- A single, date-driven, future reversal of an already-posted journal entry.
- Exactly-once execution under concurrency: `claimAndExecuteOne()` runs entirely in one transaction, acquiring locks in a strict, documented order — (1) the `scheduled_reversals` row via `FOR UPDATE SKIP LOCKED` (a concurrent claim of the same row skips, never blocks), (2) the original `journal_entries` row via the *same* `lockAndValidateOriginalForReversal()` the manual `reverse()` path uses (so manual-reverse-vs-scheduled-process-due races are deadlock-free and resolve to exactly one reversal, whichever transaction commits first), (3) the accounting period, only after (2) succeeds.
- Candidate selection (`processDue()`) is a lock-free read in its own short transaction; each candidate is then claimed and executed in a **separate** subsequent transaction, one at a time — one candidate's work/locks can never block or extend another's.
- Four terminal-consistent statuses (`SCHEDULED`, `EXECUTED`, `FAILED`, `CANCELLED`), enforced by a DB `CHECK` constraint (`scheduled_reversals_terminal_fields_consistent`) tying status to which of `resultingReversalJournalEntryId`/`failureReason`/`executedAt` may be non-null.
- Terminal-state immutability via a dedicated trigger (`024_...`), simpler than `journal_entries`' own trigger because there is no narrow single-column exception to carve out — a terminal row is never touched again.
- A full audit trail (`CREATE`/`CANCEL`/`EXECUTE`/`FAIL` actions) written to the shared, generic, immutable `audit_logs` table (`entityType: "scheduled_reversal"`), not a bespoke audit mechanism.
- A closed-period rejection both at creation time (fail fast) and at execution time (if the period closed in between).
- A `NOT_FOUND` period at execution time is **not** a failure — periods in this codebase are "create, list, close only," so a schedule may legitimately target a not-yet-created period and is simply retried on a later `process-due` call.
- Tenant/legal-entity isolation identical to the rest of Accounting Core.
- Real, repository-proven concurrency verification: `scheduled-reversals-concurrency.e2e-spec.ts` runs 50 repetitions of an actual concurrent race (two simultaneous HTTP requests via `Promise.all` against real PostgreSQL) and asserts no deadlock, ever, and exactly one reversal, always.

### What it does NOT solve

- **Multiple system-generated journal entries from one schedule.** The data model is fundamentally single-occurrence: one `scheduled_reversals` row → at most one `resultingReversalJournalEntryId`. There is no concept of "the 3rd of 12 periods" anywhere in this table or service.
- Recurring/periodic due-date generation of any kind.
- Any notion of a "remaining balance" being drawn down over time.
- Any execution triggered by anything other than a date (no "on settlement of another document" trigger exists).
- Amendment of an in-flight schedule's economics (only full cancellation of a still-`SCHEDULED` row exists).

### Extend, sibling, extract, or other?

**Extraction of a smaller shared execution primitive (option 3), applied as a design pattern reused by a new, sibling table pair — not literal shared code, and not modification of `scheduled_reversals`.** Reasoning:

- Simple **extension** (option 1) is wrong: adding a "type" column or an occurrence count to `scheduled_reversals` would force a single-occurrence table to represent multi-occurrence schedules, breaking its proven unique-index (`scheduled_reversals_one_active_per_original`) and terminal-CHECK-constraint invariants, which are deliberately shaped around "one row, one outcome."
- A **bare sibling copy-paste** (a literal duplicate of the claim/lock/audit code with different table names) is wrong too: it would let the two implementations drift (e.g., a future bug fix to the lock-order discipline applied to one and not the other).
- The correct answer is: `scheduled_reversals` is left **completely untouched** (per §23 of the authorization), and the new capability reuses `JournalEntriesService`'s existing public/reusable methods (`lockAndValidateOriginalForReversal`-equivalent pattern, `resolvePeriodForDate`, the build/insert/allocate/post sequence) exactly as `scheduled_reversals` already does — i.e., the *proven algorithm shape* is the reused asset, expressed against new, purpose-built tables. See Section 8/9 for the concrete design.

---

## 6. Accrual Accounting Model

Per the authorization's explicit instruction not to invent accounting behavior, this section separates what is already supported from what is genuinely new, without presuming an implementation.

- **Recognition + posting (now):** already fully supported — a manual `create()` + `post()` journal entry, no new mechanism.
- **Optional automatic reversal on a fixed future date:** already fully supported, unmodified, via `scheduled_reversals` — this is precisely what `scheduled_reversals` was built for. A caller today can already: post an accrual journal entry, then `POST /scheduled-reversals` targeting the date the accrual should unwind. No new schema or service is required for this half of Accrual.
- **Settlement by a subsequent source document** (i.e., reverse the accrual automatically when the *actual* bill/invoice posts, rather than on a fixed calendar date): **not supported today, and not a small extension.** No document-lifecycle event/hook mechanism exists anywhere in this codebase that lets posting one document trigger an action on another, unrelated document. Building this would mean designing a cross-document event trigger — a materially different and larger mechanism than anything else in this discovery, and its necessity cannot be established from repository evidence alone. **Flagged as an open business decision (Section 25) — not designed here.**
- **Period close interaction:** identical to `scheduled_reversals`' existing, proven closed-period handling (Section 5) — reused unchanged.
- **Amendment/cancellation:** identical to `scheduled_reversals`' existing `cancel()` — reused unchanged (cancel the still-`SCHEDULED` reversal; the original accrual entry itself is amended the same way any posted journal entry is corrected today — a further, separate reversal, since reversal-of-a-reversal is explicitly not supported anywhere in this codebase, `journal-entries.service.ts:524`).
- **Audit trail:** identical to `scheduled_reversals`' existing `audit_logs` writes — reused unchanged.

**Conclusion:** the "fixed-date" flavor of Accrual requires, at most, a thin optional convenience endpoint that packages "create+post a journal entry" and "schedule its reversal" into a single atomic call in place of today's two separate API calls — and even that is a scope decision, not a technical necessity, since both underlying calls already exist and are already atomic individually. **Accrual does not drive the need for any new posting primitive.**

---

## 7. Deferral Accounting Model

- **Initial recognition:** one upfront journal entry (e.g., debit a deferred/prepaid asset account, or credit a deferred/unearned-revenue liability account) — an ordinary journal entry, no new mechanism.
- **Deferred balance:** the *unrecognized remainder* — not a stored running total anywhere in `chart_of_accounts` (there is no dedicated "deferred" account type; `accountTypeEnum` is exactly `ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE`, confirmed in `schema.ts:52`). The deferred balance is a **derived** quantity: `totalAmount − Σ(executed occurrence amounts)`, computed from the new schedule/occurrence rows proposed in Section 9, not from a new GL account type.
- **Recognition schedule:** genuinely new — N future dates/periods, each producing its own system-generated journal entry moving a portion from the deferred account to the recognized (expense/revenue) account. This is the part `scheduled_reversals` cannot express (Section 5).
- **Periodic recognition:** one journal entry per due occurrence, using the *same* build/insert/allocate/post sequence `completeReversalPosting()` already uses (Section 4) — never a second posting engine.
- **Final recognition:** the last occurrence; the schedule's derived remaining balance reaches zero. No special-cased "final" logic is required if each occurrence's amount is stored explicitly (Section 9) rather than computed by even division at execution time — the schedule's creator is responsible for making occurrence amounts sum to the total, exactly as `post()` already requires the *caller* to submit balanced debit/credit lines rather than the system inferring balance.
- **Cancellation:** cancel all not-yet-executed occurrences (mirrors `scheduled_reversals.cancel()`); already-executed occurrences and their posted journal entries are untouched — permanent, per the immutability convention already established everywhere else.
- **Amendment:** per the codebase's established "correction, not mutation, of posted state" convention (the reversal-of-reversal precedent, Section 6) — an amendment to a partially-executed schedule should be modeled as cancelling the schedule's remaining occurrences and creating a new schedule for the remaining balance, not as an in-place edit of executed history. **This is architecturally consistent with existing precedent but is still a business-policy choice, and is recorded as an open decision (Section 25)** since no existing capability has had to make exactly this call before.
- **Early termination:** the same as cancellation with a possible final "true-up" journal entry (e.g., recognizing the entire remaining balance immediately) — **whether early termination should auto-generate a true-up entry, or simply leave the remainder unrecognized until manually handled, is an accounting policy decision not resolvable from repository evidence.** Flagged, not decided.
- **Closed periods, missed periods, partial periods:** see Section 12 (Period-Close Model) — this is where Deferral's multi-occurrence nature introduces a genuinely new question `scheduled_reversals` never had to answer.

---

## 8. Proposed Recognition Execution Model

The core algorithm — **reused, not copied, from `claimAndExecuteOne()`** — applied per occurrence:

```
Recognition Schedule (header)
    │  created with N pre-generated Recognition Execution rows (Section 9)
    ▼
process-due (on-demand route, Section 16) selects due, SCHEDULED executions
    │  lock-free candidate read, its own short transaction
    ▼
For each candidate, in its own transaction:
    1. FOR UPDATE SKIP LOCKED the execution row — losing a race is a clean skip
    2. Resolve the target accounting period (resolvePeriodForDate) — OPEN / CLOSED / NOT_FOUND
    3. If OPEN: build lines, insert, allocate journal number, post
       — via the SAME build/insert/allocate/post sequence completeReversalPosting() uses,
         never a second posting engine
    4. Transition the execution row to EXECUTED (linking the new journal entry) —
       or FAILED / left SCHEDULED (retry later), per Section 12
    5. Write an audit_logs row (shared, generic, immutable — Section 14)
    — all five steps in ONE transaction, so a crash between steps 3 and 4
      rolls back atomically (Section 10/11)
```

This is not a new algorithm — it is `scheduled_reversals`' proven five-step shape, applied once per occurrence instead of once per schedule.

---

## 9. Schedule/Data Model

**Option B — schedule header plus persisted execution/occurrence records — is proposed**, evaluated against the authorization's own criteria:

| Criterion | Option A (calculated occurrences) | Option B (persisted occurrences) |
|---|---|---|
| Auditability | Weak — "what was due when" is reconstructed, not recorded | Strong — every occurrence's planned amount/date/status is a durable row, matching how `scheduled_reversals` itself is auditable |
| Idempotency | Requires inventing a new occurrence-identity scheme | Direct — a unique constraint on `(scheduleId, targetPeriodId)` for non-cancelled rows is the DB-level backstop, same shape as `scheduled_reversals_one_active_per_original` |
| Retry/concurrency | Cannot use `FOR UPDATE SKIP LOCKED` on something that doesn't exist as a row yet | Directly reuses the proven per-row claim pattern |
| Amendment | Ambiguous what "amend" even touches | Clear — cancel remaining rows, create new ones |
| Reporting | Requires a calculation engine just to answer "what's outstanding" | A simple filtered query, consistent with every other Finance report in this codebase |
| Migration complexity | Lower row count | Slightly higher row count (bounded — one row per period, not unbounded) |

Reporting, auditability, idempotency, and consistency with the one proven precedent this codebase has all favor Option B; the only cost (row count) is bounded by the schedule's own explicit length and is not a real concern at Finance-report scale.

### Proposed tables (schema only — not created; no migration authorized)

`recognition_schedules` (header): `id`, `tenantId`, `legalEntityId`, `scheduleType` (`DEFERRAL` only — Accrual does not need a header row per Section 6), `memo`, `totalAmountMinor`, `currencyCode` (resolved from the legal entity's functional currency, same convention `resolveCurrency()` already uses), a debit/credit account pair (the deferred account and the recognized account — ordinary `chart_of_accounts` rows, no new account type), `status` (`ACTIVE | COMPLETED | CANCELLED`), `createdBy`, `createdAt`, `updatedAt`.

`recognition_executions` (occurrences): `id`, `scheduleId` (FK), `tenantId`, `legalEntityId`, `targetDate`, `amountMinor` (this occurrence's own recognized amount — explicit, not computed, so uneven/partial periods are simply expressed as uneven stored amounts, never invented arithmetic), `status` (`SCHEDULED | EXECUTED | FAILED | CANCELLED` — the identical enum shape `scheduled_reversals` already uses), `resultingJournalEntryId` (FK, nullable until executed), `failureReason`, `executedAt`, `executedBy`, `createdAt`, `updatedAt`.

Both tables gain a terminal-immutability trigger modeled directly on `024_scheduled_reversals_immutability_trigger.sql`, and `recognition_executions` gains a terminal-fields-consistency `CHECK` modeled on `scheduled_reversals_terminal_fields_consistent`.

Occurrence rows are **pre-generated in full at schedule-creation time** (all N rows created `SCHEDULED` up front), not computed lazily — this is what makes "5 of 12 recognized" a direct query rather than a calculation, and is what lets the exact same claim algorithm (Section 8) operate identically to `scheduled_reversals`' own.

---

## 10. Concurrency Model

All six races from the authorization, resolved by directly reusing `scheduled_reversals`' proven mechanisms:

- **Race A (two workers, same period):** `FOR UPDATE SKIP LOCKED` on the specific `recognition_executions` row — the loser's `SKIP LOCKED` returns nothing and skips, exactly as `claimAndExecuteOne()` does today. No blocking, no deadlock.
- **Race B (crash after journal creation, before status update):** both happen inside the *same* transaction (Section 8, step 3+4 together) — a crash before commit means neither persists; the journal-number counter increment (also inside that transaction) rolls back too, so no burned numbers, per the existing `allocateJournalNumber()` guarantee. On restart the occurrence is still `SCHEDULED` and is correctly retried.
- **Race C (ambiguous-commit retry):** the DB-level unique constraint on `(scheduleId, targetPeriodId)` for non-cancelled rows is the backstop the authorization explicitly requires beyond application checks — a blind retry cannot create a second journal entry for the same occurrence.
- **Race D (period closes mid-processing):** identical to `scheduled_reversals`' `CLOSED` branch — the occurrence transitions to `FAILED` with a reason, never partially posts.
- **Race E (schedule cancelled during execution attempt):** cancelling the header transitions all still-`SCHEDULED` occurrence rows to `CANCELLED` in one transaction; a concurrent `claimAndExecuteOne`-equivalent on one specific occurrence either wins its own row lock and completes normally (an already-`EXECUTED` occurrence is immutable and cannot be retroactively cancelled, matching `scheduled_reversals`' own terminal-state model) or loses it and observes `CANCELLED` already, exiting cleanly — same "whichever commits first wins" resolution `scheduled_reversals`' documented Revision-2 race proof already relies on.
- **Race F (two admins cancel/modify concurrently):** the header row's own `FOR UPDATE` lock (identical to `scheduled_reversals.cancel()`'s existing pattern) — the second caller's lock wait ends after the first commits, re-reads current status, and gets the same "already CANCELLED" 409 pattern already in production.

No new locking primitive, isolation level, or database feature is proposed — every race is closed by the same mechanisms `scheduled_reversals` already uses and has 50-repetition, real-PostgreSQL concurrency test coverage for.

---

## 11. Idempotency Model

- **Database-level, not application-level-alone** (per the authorization's explicit requirement): the unique constraint on `(scheduleId, targetPeriodId)` for non-cancelled `recognition_executions` rows guarantees at most one non-cancelled execution — and therefore at most one journal entry — per occurrence, regardless of how many times a caller (or a retried HTTP request) invokes `process-due`.
- Combined with `FOR UPDATE SKIP LOCKED` claiming, this directly answers the authorization's DISC-ACC-006 ("how is duplicate execution prevented at database level") without inventing a new mechanism — it is the identical proof `scheduled_reversals_one_active_per_original` already provides for the single-occurrence case, adapted to the per-occurrence case.
- Worker retry and worker crash recovery (DISC-ACC-007/008) require no new mechanism: transaction atomicity (Section 10, Race B) already guarantees a crash mid-execution leaves the occurrence retryable and never double-posted.

---

## 12. Period-Close Model

- An occurrence due in an **open** period posts normally.
- An occurrence due in a **closed** period: reusing `scheduled_reversals`' established policy, it transitions to `FAILED` with a reason — **not** silently skipped, and **not** auto-deferred into a different period. This is a direct, consistent reuse of existing precedent.
- **New question `scheduled_reversals` never had to answer, because it is single-occurrence:** when one occurrence of a multi-occurrence Deferral schedule fails due to a closed period, should the *remaining, still-future* occurrences continue processing normally on their own schedule (independent per-occurrence outcomes), or should the entire schedule halt? Reusing per-row independence (Section 8's per-candidate separate transactions) argues for "remaining occurrences are unaffected" — but whether a failed occurrence's amount should ever be recoverable (re-attempted into a later period once it's reopened, or via a brand-new manually-created catch-up occurrence) is **not resolvable from repository evidence** — `scheduled_reversals` has no "retry into a different period" behavior to draw on, since its one occurrence failing simply means the whole schedule is done, `FAILED`. **Flagged as an open business/accounting decision (Section 25).**
- Multiple overdue occurrences becoming due at once, or a schedule spanning a period close: each occurrence is evaluated independently against its own `targetDate`, exactly as each `scheduled_reversals` candidate is today — no batch-level period logic is introduced.

---

## 13. Failure/Retry Model

| Failure | Classification | Handling |
|---|---|---|
| Transient DB failure mid-transaction | Retryable | Transaction rolls back; occurrence stays `SCHEDULED`; next `process-due` call retries it — identical to `scheduled_reversals` |
| Journal validation failure (e.g. account deactivated between schedule creation and execution) | Terminal (this occurrence) | Occurrence → `FAILED` with reason, mirroring `scheduled_reversals`' `UnprocessableEntityException` → `FAILED` mapping |
| Closed period | Terminal (this occurrence), open question for the schedule (Section 12) | → `FAILED` |
| Missing/deleted GL account configuration | Terminal, operator-action-required | → `FAILED`; requires a human to fix the underlying configuration before any retry can succeed — no automatic remediation, consistent with this codebase never auto-correcting configuration |
| Duplicate execution attempt | Not an error — benign race outcome | `SKIP LOCKED` skip, or unique-constraint-backed no-op, exactly as `scheduled_reversals` treats a lost race as `skipped`/`cancelled`, not a 500 |
| Worker crash mid-execution | Retryable | Transaction atomicity (Section 10) |

No failure is ever silent — every terminal outcome writes a `failureReason` and an `audit_logs` row, per existing convention.

---

## 14. Provenance/Audit Model

```
recognition_schedules
        │  (FK)
        ▼
recognition_executions
        │  (FK: resultingJournalEntryId)
        ▼
journal_entries
        │
        ▼
journal_lines
```

This is the same two/three-hop shape `scheduled_reversals → resultingReversalJournalEntryId → journal_entries` already uses, with one header/occurrence split inserted. An auditor asks "why was this journal entry created" by joining `journal_entries` back through `recognition_executions.resultingJournalEntryId`; "which schedule generated it" is the same join one level further, to `recognition_executions.scheduleId`.

**The existing, shared, generic, immutable `audit_logs` table (`packages/db-core/src/schema.ts:218`, enforced append-only by `drizzle/rls/002_immutable_audit_log.sql`) fully supports this lifecycle without any new audit infrastructure** — this directly answers the authorization's explicit question. `entityType: "recognition_schedule"` / `"recognition_execution"` rows, with `CREATE`/`CANCEL`/`EXECUTE`/`FAIL` actions, are written exactly as `scheduled_reversals` already writes its own four action types to the same table.

No new column on `journal_entries` is proposed. Precedent: `journal_entries` carries no "was this a scheduled reversal" flag either — provenance for reversals is established entirely from the `scheduled_reversals` side via its own FK. The same pattern is proposed here, for consistency, not because it was the only option.

---

## 15. RBAC Model

The current Finance RBAC model is exactly three roles system-wide (`finance.viewer`, `finance.poster`, `finance.admin`), confirmed by an exhaustive `@Roles(` grep across every controller. No approval-actor or segregation-of-duties role exists anywhere in this codebase — `scheduled-reversals.controller.ts` uses `finance.poster` for all three mutating routes (create, cancel, process-due), including the automated-sounding `process-due`, with the explicit doc-comment rationale that it "creates journal entries via the same posting path `/reverse` does, so it carries the same role as `/reverse`, not a separate operational role that doesn't exist in this codebase's route-role-matrix."

**Proposed, directly reusing this precedent:** `finance.poster` for create/cancel/process-due on the new routes; `finance.viewer`/`finance.poster`/`finance.admin` for read routes. No new role is proposed, because none is evidenced as required specifically by this capability — introducing one here would be exactly the kind of unjustified new authorization framework §17 of the authorization warns against. Whether recognition schedules above a materiality threshold should require a distinct approval actor is the same open RBAC gap already flagged (unresolved) for Expense Management and Audit & Compliance in the prior Finance Next Capability Discovery — **not re-decided here, and not specific to this capability.**

Human actor vs. system-generated actor/process: identical to `scheduled_reversals` — `process-due` is invoked by whatever caller holds a valid `finance.poster` token (human or an external, out-of-repo scheduler acting via the API); there is no distinct "system" identity anywhere in this codebase's auth model, and inventing one here is out of scope.

---

## 16. Execution/Worker Model

**No scheduled-job, queue, worker, or cron infrastructure exists anywhere in this repository.** Verified by: (a) `services/sphere-finance/package.json` dependency listing — no `@nestjs/schedule`, no `bullmq`/`bull`, no queue/cron library of any kind; (b) a full source grep for `cron|@nestjs/schedule|bullmq|bull\b|queue|worker` across `services/sphere-finance/src`, whose only matches are incidental words in unrelated controller comments, not actual infrastructure.

**What actually triggers `scheduled_reversals`' own due-processing today: nothing automatic.** `POST /scheduled-reversals/process-due` is an on-demand HTTP route; something outside this codebase (a human, or an external ops scheduler/cron hitting the API) must call it. This is a pre-existing platform-wide gap, not something introduced or worsened by this discovery.

**Proposed execution mechanism, directly mirroring the only precedent that exists:** a new on-demand route, `POST /recognition-schedules/process-due`, with the identical shape and RBAC as `scheduled_reversals`' own — no new infrastructure category. Building an actual scheduler/queue is explicitly out of scope per §30/§31 of the authorization, and this discovery does not propose one; if NoryX later needs *automatic* (not on-demand) execution, that is a separate, platform-wide infrastructure decision (affecting `scheduled_reversals` too, not just this capability) and is recorded as an open decision (Section 25), not designed here.

---

## 17. Reporting Boundary

Reusing existing Finance reporting conventions (`REPORT_TX_CONFIG` — `REPEATABLE READ`, `READ ONLY`, `general-ledger.service.ts:37` — already the standard for every report in this codebase):

- Active schedules (list, filterable by status — mirrors `scheduled-reversals.controller.ts`'s existing `list()` + status filter).
- Upcoming/due recognition executions.
- Executed recognition history.
- Failed recognition, with reasons.
- Cancelled schedules/executions.
- Schedule → journal drill-down (join `recognition_executions.resultingJournalEntryId`).
- Journal → schedule reverse lookup (filter `recognition_executions` by `resultingJournalEntryId` — the same minimal approach `scheduled_reversals` uses today; it has no dedicated reverse-lookup route either, only the FK to filter by).
- Remaining deferred balance (derived: `totalAmountMinor − Σ(executed occurrence amountMinor)`, per Section 7 — no stored running-balance column).

No large reporting suite is proposed beyond this — consistent with the authorization's explicit "do not create a large reporting suite unless evidence requires it."

---

## 18. Multi-Tenant / Legal Entity Isolation

Identical, unmodified mechanism to every other table in this codebase: `tenantId`/`legalEntityId` columns on both new tables, `withTenant()` (RLS `SET LOCAL` scoping via `packages/db-core`) plus explicit `eq()` predicates on every query — the same belt-and-braces pattern `journal-entries.service.ts` and `scheduled-reversals.service.ts` both use. All new indexes and unique constraints are proposed tenant/legal-entity-scoped (e.g. the due-lookup index mirrors `scheduled_reversals_due_lookup`'s `(tenant_id, legal_entity_id, status, target_date, id)` shape). No new isolation mechanism is required or proposed.

---

## 19. Migration Considerations

- **Two new tables** (`recognition_schedules`, `recognition_executions`), two new status enums (mirroring `scheduled_reversal_status`), one new partial due-lookup index (mirroring `scheduled_reversals_due_lookup`), one new partial/composite unique index for occurrence idempotency (mirroring `scheduled_reversals_one_active_per_original`'s shape, adapted to `(scheduleId, targetPeriodId)`), and two new terminal-immutability triggers (mirroring `024_...`) in the separate `drizzle/constraints/` layer this codebase already uses for that purpose.
- **No `ALTER TABLE` on any existing table** — `journal_entries`, `accounting_periods`, `chart_of_accounts`, and `scheduled_reversals` are all untouched, per §23's explicit requirement. `scheduled_reversals`' own behavior is provably unaffected since nothing proposed here references or modifies it.
- **No existing data is affected** — purely additive.
- **No weakening of any existing accounting invariant** — the proposed triggers/constraints are net-new restrictions on net-new tables, modeled on the strictest existing precedent (`scheduled_reversals`' own terminal-immutability + CHECK-constraint pair), not a relaxation of anything.

---

## 20. Fixed Assets Reuse Test

**Caveat, restated from Section 1/Finding 2:** no repository evidence of a prior Fixed Assets implementation exists to test against. This is therefore a structural/architectural reasoning test, not a validation against real prior code, and is reported as such rather than silently upgraded to a stronger claim than the evidence supports.

**Structural test:** depreciation is, in shape, "N periodic system-generated postings against a schedule, exactly-once per period, until a balance is exhausted" — the *identical* shape Deferral recognition solves (Section 7/9). A future Fixed Assets depreciation run could plausibly reuse `recognition_schedules`/`recognition_executions` (with `scheduleType: 'DEPRECIATION'` alongside `'DEFERRAL'`, and an asset-specific header extension) and the entire claim/execute/period/audit machinery in Sections 8–14, **without changing that machinery's accounting-correctness guarantees** — those guarantees (exactly-once execution, period validity, tenant isolation, audit trail, atomicity via the unmodified Accounting Core posting path) are generic to "system-generated periodic posting" and encode nothing Deferral-specific. Only the schedule header's domain fields (an asset-class → GL-account mapping, directly precedented by Tax/VAT Phase 5's per-tax-code GL account mapping, per `PROJECT_STATE.md`) would be Fixed-Assets-specific, layered on top rather than baked into the shared primitive.

**Verdict: PASS (architectural reasoning only — no historical implementation evidence available to corroborate against).**

---

## 21. Multi-Currency Reuse Test

Multi-Currency periodic FX revaluation is the same shape: recognize FX gain/loss postings on a period-driven schedule. It would reuse the same execution/claim/period/audit machinery, with its own schedule "type" and its own rate-resolution logic (directly precedented by the Tax/VAT effective-dated `tax_rates`/`taxRateId` FK-snapshot pattern, per the prior Finance Next Capability Discovery) layered on top — again, not baked into the shared primitive.

**Verdict: PASS**, for the same reason as Section 20 — the shared machinery's correctness guarantees are generic to periodic system-generated posting, not Deferral-specific, and Multi-Currency's domain-specific logic (rate resolution) is cleanly separable from it.

---

## 22. Implementation Boundary

### In Scope (if and when implementation is separately authorized)

- `recognition_schedules` + `recognition_executions` tables, enums, indexes, constraints, immutability triggers (Section 9/19).
- A `RecognitionSchedulesService` reusing `JournalEntriesService`'s existing period-resolution and posting-sequence methods (Section 4/8) — never a second posting engine.
- Create / cancel / list / findOne / process-due routes, RBAC per Section 15.
- Deferral only, per the authorization's own scoping (§3) — a scheduleType enum value structured so it does not preclude a later, separately-authorized `ACCRUAL`-convenience or `DEPRECIATION` value, but only `DEFERRAL` is in scope now.
- Reporting per Section 17.

### Out of Scope (explicit, per §25 of the authorization)

- Fixed Assets, depreciation, asset register, asset disposal, impairment.
- Multi-Currency, FX revaluation.
- Project WIP, Projects module.
- Procurement, Inventory, HRMS/Payroll.
- A generic approval platform / new RBAC role.
- Any reporting expansion beyond Section 17.
- Any scheduler/queue/worker infrastructure (Section 16).
- Settlement-triggered (event-driven) Accrual reversal (Section 6) — remains a fixed-date-only capability unless a separate, future discovery authorizes the larger event-trigger mechanism it would require.
- Any modification to `scheduled_reversals`, `journal_entries`, `accounting_periods`, or `chart_of_accounts`.

---

## 23. Out-of-Scope Items

(Consolidated list — see Section 22 for the authoritative, reasoned boundary. Restated here per the mandated artifact structure.)

Fixed Assets · depreciation · asset register/disposal/impairment · Multi-Currency/FX revaluation · Project WIP/Projects module · Procurement · Inventory · HRMS/Payroll · a generic approval platform · unrelated reporting expansion · any scheduler/queue/worker infrastructure · settlement/event-triggered Accrual reversal · resumption or modification of any historical Fixed Assets code (none was found to resume, per Section 1/Finding 2).

---

## 24. Testing / Acceptance Matrix

No tests are implemented in this discovery. The following is the acceptance architecture a future implementation must satisfy, directly modeled on `scheduled_reversals`' own proven test suite (`scheduled-reversals.e2e-spec.ts`, `scheduled-reversals-concurrency.e2e-spec.ts`):

**Functional:** create a Deferral schedule (201, N `SCHEDULED` occurrences generated) · reject a schedule whose occurrence amounts don't sum to the total · cancel a schedule with no executed occurrences (all occurrences → `CANCELLED`) · cancel a partially-executed schedule (only remaining `SCHEDULED` occurrences → `CANCELLED`, executed ones untouched) · reject cancelling an already-`COMPLETED`/`CANCELLED` schedule.

**Accounting:** every generated journal entry is balanced · posts to the correct configured accounts · posts into the correct period · occurrence amount matches the posted line amount exactly · `resultingJournalEntryId` correctly links back.

**Concurrency:** two simultaneous `process-due` calls never double-execute the same occurrence (mirror the existing 50-repetition real-PostgreSQL race test pattern) · a crash/interrupted transaction mid-execution leaves the occurrence retryable, never double-posted · simultaneous schedule-cancel + occurrence-claim resolves deterministically (Section 10, Race E).

**Period close:** an occurrence due in a `CLOSED` period → `FAILED`, never partially posts · an occurrence with `NOT_FOUND` period stays `SCHEDULED`, retried later · overdue/multiple-due occurrences processed independently.

**Isolation:** tenant B never sees or can claim tenant A's schedules/occurrences (mirror the existing `scheduled-reversals` tenant-isolation tests verbatim in shape).

**Immutability:** a raw `UPDATE`/`DELETE` against an `EXECUTED`/`FAILED`/`CANCELLED` occurrence row is rejected at the trigger level, tested via direct SQL exactly as `scheduled-reversals.e2e-spec.ts`'s "database-level enforcement — direct psql, no service code" block already does.

**Audit:** every lifecycle transition (create/cancel/execute/fail) writes the expected `audit_logs` row.

**Regression (mandatory, per §24 of the authorization):** the full existing `scheduled_reversals` e2e and concurrency suites remain green, unmodified · the full existing Accounting Core (`journal-entries`) test suite remains green, unmodified · the full existing Finance e2e suite remains green.

---

## 25. Open Decisions

These are explicitly **not resolved** by this discovery, per the authorization's prohibition on inventing accounting/business behavior:

1. **Is settlement-triggered (event-driven) Accrual reversal actually required**, or is fixed-date reversal (already fully supported today, Section 6) sufficient? This determines whether a materially larger, separate discovery (cross-document event triggers) is ever needed.
2. **When a Deferral occurrence fails because its period is closed, should the remaining schedule continue independently, and should the failed occurrence ever be retryable into a different period, or does it require a brand-new manually-created catch-up occurrence?** (Section 12 — no existing precedent answers this, because `scheduled_reversals` is single-occurrence.)
3. **Should amending a partially-executed Deferral schedule be "cancel remainder + new schedule" (the architecturally consistent default proposed in Section 7), or does the business require true in-place amendment of unexecuted occurrences?**
4. **Should early termination auto-generate a "true-up" journal entry** recognizing the full remaining balance immediately, or leave it unrecognized until a separate manual action? (Section 7.)
5. **Should recognition schedules above a materiality threshold require a distinct approval role/actor** — the same open RBAC gap already flagged, unresolved, for Expense Management and Audit & Compliance in the prior Finance Next Capability Discovery. Not specific to this capability; not decided here.
6. **Is a thin "create accrual + schedule its reversal in one call" convenience endpoint in scope**, or is composing the two already-existing API calls (manual journal entry + `scheduled_reversals`) sufficient? (Section 6 — a scope decision, not a technical blocker either way.)
7. **Does NoryX need genuine automatic (timer-driven) execution of due schedules** — for this capability, for `scheduled_reversals`, or both — versus the on-demand-route model both rely on today? This is a platform-wide infrastructure question, not specific to Accrual/Deferral, and is explicitly out of this discovery's scope to answer (Section 16).
8. **The §2 discrepancy itself** (Section 1, Finding 2): no historical Fixed Assets implementation evidence could be found in this repository, contradicting the authorization's stated historical context. This is reported for the CTO's awareness; correcting or reconciling that historical record is not within this discovery's authority.
9. **The pre-existing `roadmap.md` "Fixed Assets (PLANNED)" line** (Section 3) is consistent with Finding 2 (no implementation exists) and requires no correction — noted only for completeness, not as an action item, since `roadmap.md` was not and may not be modified by this discovery.

---

## Rework / Over-Engineering Test (§26 of the authorization)

1. **Are we building a capability-specific Accrual engine Fixed Assets will later have to replace?** No — Accrual needs no new engine at all (Section 6); the one new primitive built is Deferral-driven, and its claim/execute/period/audit machinery is generic to periodic system-generated posting, not Accrual- or Deferral-specific.
2. **Are we building a speculative generic workflow/scheduler framework with no current evidence?** No — no queue, no cron, no generic "workflow" abstraction is proposed; the trigger mechanism is the identical on-demand route pattern already in production (Section 16).
3. **Are we duplicating Accounting Core posting logic?** No — the design explicitly reuses `JournalEntriesService`'s existing build/insert/allocate-number/post sequence and `resolvePeriodForDate()` (Section 4/8); no second posting engine is proposed.
4. **Are we duplicating `scheduled_reversals`?** No — `scheduled_reversals` is untouched (Section 19); the proven *algorithm shape* is reused as a design pattern against new, purpose-built tables, not copy-pasted code.
5. **Are we introducing an abstraction whose only justification is a hypothetical future module?** No — the primitive is justified by Deferral's own immediate, evidenced requirement (Section 7); Fixed Assets/Multi-Currency reuse (Sections 20/21) is a secondary property, not the primary justification.
6. **Could the proposed primitive support Fixed Assets and Multi-Currency later without changing its accounting-correctness model?** Yes (Sections 20/21) — its correctness guarantees are generic to periodic system-generated posting and encode nothing Deferral-specific.
7. **What is the smallest architecture that passes all of the above?** Two new tables, one new service reusing existing Accounting Core/period/audit primitives, one new controller with the existing RBAC convention, and one new on-demand `process-due` route — no new infrastructure category (no queue, no scheduler, no new role, no new audit system, no new account-type taxonomy), and zero changes to any existing table or service.

---

## Discovery Acceptance Conditions (DISC-ACC-001 – DISC-ACC-031)

| # | Question | Verdict | Evidence |
|---|---|---|---|
| DISC-ACC-001 | What exactly is an Accrual in NoryX? | PASS | Section 6 — recognition now + optional fixed-date reversal, already expressible with existing primitives; settlement-triggered variant explicitly unresolved (Open Decision 1) |
| DISC-ACC-002 | What exactly is a Deferral in NoryX? | PASS | Section 7 — upfront recognition + N future periodic recognition entries against a stored, explicit-amount schedule |
| DISC-ACC-003 | What does `scheduled_reversals` already solve? | PASS | Section 5 |
| DISC-ACC-004 | What capability is genuinely missing? | PASS | Section 1/7 — multi-occurrence, period-driven recognition |
| DISC-ACC-005 | What is the smallest reusable period-driven posting primitive? | PASS | Sections 8/9 |
| DISC-ACC-006 | How is duplicate execution prevented at database level? | PASS | Section 11 — unique constraint on `(scheduleId, targetPeriodId)` |
| DISC-ACC-007 | How is worker retry handled? | PASS | Section 13 |
| DISC-ACC-008 | How is worker crash recovery handled? | PASS | Section 10, Race B |
| DISC-ACC-009 | How is period close handled? | PASS | Section 12 (with one open sub-question, Open Decision 2) |
| DISC-ACC-010 | How is generated journal provenance stored? | PASS | Section 14 |
| DISC-ACC-011 | How does audit logging work? | PASS | Section 14 — existing shared `audit_logs` table, no new infrastructure |
| DISC-ACC-012 | How is tenant/legal-entity isolation enforced? | PASS | Section 18 |
| DISC-ACC-013 | How are schedule mutations controlled? | PASS | Section 7/9, with amendment policy flagged as Open Decision 3 |
| DISC-ACC-014 | How are failed schedules handled? | PASS | Section 13 |
| DISC-ACC-015 | What actually triggers execution? | PASS | Section 16 — on-demand route, no scheduler exists anywhere in this codebase |
| DISC-ACC-016 | Does the design reuse Accounting Core rather than duplicate posting logic? | PASS | Section 4/8 |
| DISC-ACC-017 | Does the design preserve existing `scheduled_reversals`? | PASS | Section 19 — zero modification |
| DISC-ACC-018 | Can Fixed Assets later consume the same primitive? | PASS (architectural reasoning only — no prior implementation evidence exists to corroborate against, Section 1/Finding 2) | Section 20 |
| DISC-ACC-019 | Can Multi-Currency later consume the same primitive? | PASS | Section 21 |
| DISC-ACC-020 | What is explicitly out of scope? | PASS | Sections 22/23 |
| DISC-ACC-021 | What business/accounting decisions remain unresolved? | PASS | Section 25 (9 items) |
| DISC-ACC-022 | What exact implementation files/modules would likely be affected? | PASS | New: `recognition-schedules/*` (service, controller, module, DTOs); modified: none (Section 19) |
| DISC-ACC-023 | What database migrations would likely be required? | PASS | Section 19 — two new tables/enums/indexes/triggers, no `ALTER` on any existing table |
| DISC-ACC-024 | What acceptance tests must exist before production readiness? | PASS | Section 24 |
| DISC-ACC-025 | What architectural risks remain? | PASS | Open Decisions 1–4, 6–7 (Section 25) are the material risks — none are technical/concurrency risks, all are accounting-policy or scope decisions |
| DISC-ACC-026 | What would constitute an unsafe implementation? | PASS | Building a second posting engine instead of reusing `completeReversalPosting()`'s sequence; skipping the DB-level unique constraint and relying on application checks alone; modifying `scheduled_reversals`; inventing automatic scheduling infrastructure not authorized by this discovery |
| DISC-ACC-027 | What is the smallest viable implementation boundary? | PASS | Section 22 |
| DISC-ACC-028 | Does the design introduce speculative infrastructure? | PASS (no) | Rework Test Q2 |
| DISC-ACC-029 | Does the design create avoidable rework for Fixed Assets? | PASS (no) | Rework Test Q1/Q6 |
| DISC-ACC-030 | Does the design create avoidable rework for Multi-Currency? | PASS (no) | Rework Test Q6, Section 21 |
| DISC-ACC-031 | Is the proposed architecture internally consistent with existing NoryX governance and Accounting Core invariants? | PASS | Sections 3/4 — no invariant is relaxed, no governance document is modified |

**31/31 PASS. 0 FAIL. 0 BLOCKED.**

---

## 26. CTO Decision Required

```text
CTO DECISION REQUIRED

This discovery does not authorize implementation.

The CTO must separately approve:

1. the accounting model;
2. the recognition execution architecture;
3. the schedule model;
4. the concurrency/idempotency model;
5. the execution mechanism;
6. the implementation scope;
7. implementation authorization.
```

Implementation is **NOT** authorized by this document. Delivery is **NOT** authorized by this document.

**FINAL STATE: TARGETED DISCOVERY COMPLETE — AWAITING CTO REVIEW**
