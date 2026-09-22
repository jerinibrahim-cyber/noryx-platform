# Generic Deferral Recognition Engine — Implementation Contract

**Work item status:** Phase 2 (Implementation Readiness) complete. Implementation NOT yet authorized to merge/deliver.
**Baseline:** `7060c676080352de57a5a43341525d9bc55c44c4`
**Branch:** `discovery/accrual-deferral-engine-2026-09`
**Precedes from:** `docs/work-items/accrual-deferral-engine-discovery/DISCOVERY.md` (targeted discovery) and the CTO-approved Phase 1 architecture resolution (this session).

This document is the authoritative technical contract for the capability actually being built: **Deferral Recognition only.** Accrual, Fixed Assets, Multi-Currency, WIP, event-driven triggers, scheduler infrastructure, and a new RBAC role are explicitly out of scope (see §9).

A naming refinement from the discovery is made here and carried through: the discovery used the generic names `recognition_schedules`/`recognition_executions` while reasoning about future reuse. That reasoning concluded future capabilities (Fixed Assets, Multi-Currency) would reuse the **execution pattern and `postSystemGeneratedEntry()`**, not literally share these tables — sharing the literal table would be speculative (a depreciation schedule needs asset-specific columns that don't belong here). This contract therefore uses capability-specific names: **`deferral_schedules`** and **`deferral_recognitions`**, with no discriminator/"type" column anticipating other capabilities.

---

## 1. Domain Model

### `deferral_schedules` (header)

| Column                                                | Type                                                                                  | Notes                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                  | uuid PK                                                                               | `gen_random_uuid()`                                                                                                                                                              |
| `tenant_id`                                           | uuid NOT NULL                                                                         |                                                                                                                                                                                  |
| `legal_entity_id`                                     | uuid NOT NULL                                                                         |                                                                                                                                                                                  |
| `memo`                                                | text NOT NULL                                                                         | e.g. "Prepaid insurance FY26"                                                                                                                                                    |
| `total_amount_minor`                                  | integer NOT NULL                                                                      | same minor-unit convention as `journal_lines.debit_minor`/`credit_minor`; `CHECK (total_amount_minor > 0)`                                                                       |
| `currency_code`                                       | varchar NOT NULL                                                                      | resolved server-side from the legal entity's functional currency via the existing `resolveCurrency()` — never client-supplied, same convention as `journal_entries.currencyCode` |
| `deferred_account_id`                                 | uuid NOT NULL, FK → `chart_of_accounts.id`                                            | the account holding the unrecognized balance (e.g. prepaid asset, unearned-revenue liability)                                                                                    |
| `recognition_account_id`                              | uuid NOT NULL, FK → `chart_of_accounts.id`                                            | the account each occurrence recognizes into (e.g. expense, revenue)                                                                                                              |
| `status`                                              | `deferral_schedule_status` enum: `ACTIVE \| COMPLETED \| CANCELLED`, default `ACTIVE` |                                                                                                                                                                                  |
| `cancelled_at`, `cancelled_by`, `cancellation_reason` | nullable                                                                              | populated only when `CANCELLED`                                                                                                                                                  |
| `created_by`, `created_at`, `updated_at`              |                                                                                       |                                                                                                                                                                                  |

Constraints: `CHECK (deferred_account_id <> recognition_account_id)` (a schedule recognizing into itself is never valid accounting); `CHECK (total_amount_minor > 0)`; a terminal-fields-consistency `CHECK` mirroring `scheduled_reversals_terminal_fields_consistent`'s discipline, adapted to this table's three-state shape.

### `deferral_recognitions` (occurrences)

| Column                         | Type                                                                                                    | Notes                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | uuid PK                                                                                                 |                                                                                                                                                                           |
| `schedule_id`                  | uuid NOT NULL, FK → `deferral_schedules.id`                                                             |                                                                                                                                                                           |
| `tenant_id`, `legal_entity_id` | uuid NOT NULL                                                                                           | denormalized onto the occurrence, exactly as `scheduled_reversals` denormalizes rather than requiring a join — enables direct RLS and the due-lookup index without a join |
| `sequence_number`              | integer NOT NULL                                                                                        | 1-based, for deterministic ordering/display ("occurrence 3 of 12")                                                                                                        |
| `target_date`                  | date NOT NULL                                                                                           |                                                                                                                                                                           |
| `amount_minor`                 | integer NOT NULL                                                                                        | `CHECK (amount_minor > 0)` — explicit per occurrence, never computed by even division (discovery §7/§9)                                                                   |
| `status`                       | `deferral_recognition_status` enum: `SCHEDULED \| EXECUTED \| FAILED \| CANCELLED`, default `SCHEDULED` | identical shape to `scheduled_reversal_status`                                                                                                                            |
| `resulting_journal_entry_id`   | uuid, FK → `journal_entries.id`, nullable until `EXECUTED`                                              |                                                                                                                                                                           |
| `failure_reason`               | text, nullable                                                                                          |                                                                                                                                                                           |
| `executed_at`, `executed_by`   | nullable                                                                                                |                                                                                                                                                                           |
| `created_at`, `updated_at`     |                                                                                                         |                                                                                                                                                                           |

Constraints: a terminal-fields-consistency `CHECK` — direct copy of `scheduled_reversals_terminal_fields_consistent`'s pattern, four-way status branch; `UNIQUE (schedule_id, sequence_number)`; `UNIQUE (schedule_id, target_date)` (a schedule may not have two occurrences on the same date). A partial due-lookup index `(tenant_id, legal_entity_id, status, target_date, id) WHERE status = 'SCHEDULED'`, a direct copy of `scheduled_reversals_due_lookup`'s shape.

**Correction from the discovery, made during this Phase 2 consistency pass:** the discovery's Section 9 proposed a `(scheduleId, targetPeriodId)` uniqueness constraint as "the idempotency-critical mechanism." On closer analysis this was imprecise. Occurrence rows are generated **once, together, inside the schedule-creation transaction** — there is no "concurrent create of the same occurrence" race analogous to `scheduled_reversals`' `create()` (which allows independent, concurrent callers to race to schedule a reversal for the same original entry). The actual execution-time exactly-once guarantee comes from two mechanisms that already exist in this design and are proven safe by Phase 0A's evidence: `FOR UPDATE SKIP LOCKED` per-occurrence claiming, and the terminal-immutability trigger blocking any further mutation of an already-`EXECUTED`/`FAILED`/`CANCELLED` row. `UNIQUE (schedule_id, sequence_number)` and `UNIQUE (schedule_id, target_date)` remain as **data-sanity** constraints (preventing a malformed schedule from ever being created with duplicate/colliding occurrences), not as the concurrency-safety mechanism.

### Aggregate invariant: `Σ(deferral_recognitions.amount_minor) = deferral_schedules.total_amount_minor`

Enforced identically to how `journal_lines`' own debit=credit invariant is enforced (`002_balance_invariant_trigger.sql`): validated at the application layer at schedule-creation time (reject a mismatched total before any row is inserted), **and independently backstopped at the database level** via a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `deferral_recognitions`, mirroring `002_balance_invariant_trigger.sql`'s exact pattern — re-checks the owning schedule's sum-vs-total once at transaction commit, closing the same class of gap that trigger closes for journal balance (a transaction that inserts/updates/deletes occurrence rows in a way that leaves the schedule's sum wrong is rejected atomically, regardless of what path produced that state).

---

## 2. State Machines

### `deferral_schedules.status`

`ACTIVE → COMPLETED` — system-transitioned, evaluated at the end of every occurrence-processing transaction: when no occurrence for that schedule remains `SCHEDULED` (i.e., every occurrence has reached `EXECUTED`, `FAILED`, or `CANCELLED` — not only when all are `EXECUTED`, since Phase 1.2 established that one `FAILED` occurrence does not halt the schedule and nothing auto-retries it, so a schedule's natural end state may legitimately be a mix of `EXECUTED` and `FAILED`).

`ACTIVE → CANCELLED` — user action (`finance.poster`), transitions all remaining `SCHEDULED` occurrences to `CANCELLED` in the same transaction.

Both `COMPLETED` and `CANCELLED` are terminal — enforced by a `deferral_schedules_terminal_immutable` trigger, direct copy of `024_scheduled_reversals_immutability_trigger.sql`'s function, adapted to this table's three states.

### `deferral_recognitions.status`

`SCHEDULED → EXECUTED | FAILED | CANCELLED`. All three are terminal, enforced by `deferral_recognitions_terminal_immutable` (direct copy of the same trigger pattern).

**No `PROCESSING` intermediate state.** The master prompt's Phase 2.2 example (`PENDING → PROCESSING → EXECUTED`) is an illustration, not a mandate. A persisted `PROCESSING` state would require committing a separate transaction before the final outcome is known — weakening atomicity rather than strengthening it, and introducing a real, known failure mode with no precedent anywhere in this codebase: a worker that commits `PROCESSING` and then crashes leaves a row stuck in a state nothing else knows how to recover, without a dedicated timeout/reclaim mechanism (which nothing in this codebase has, and building one is scheduler-adjacent infrastructure explicitly out of scope). `scheduled_reversals` has no `PROCESSING` state either, for the same reason: `FOR UPDATE SKIP LOCKED` already provides "claimed by exactly one worker" for the duration of one transaction, and if that transaction never commits, the row is simply still `SCHEDULED` and safely retried by the next `process-due` call — no cleanup needed. Proven by Phase 0A Scenario B/D.

---

## 3. Accounting Invariants and How Each Is Proven

| Invariant                                       | Mechanism                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recognized amount cannot exceed schedule amount | Application check at creation + deferred DB constraint trigger (§1)                                                                                                                                                                                                                                                                  |
| Occurrence amounts explicit                     | `amount_minor NOT NULL`, no computed default                                                                                                                                                                                                                                                                                         |
| One occurrence cannot produce two journals      | `resulting_journal_entry_id` + terminal-immutability trigger + `FOR UPDATE SKIP LOCKED`                                                                                                                                                                                                                                              |
| Executed occurrence cannot execute twice        | Same as above                                                                                                                                                                                                                                                                                                                        |
| Posted journals remain immutable                | Unchanged — relies entirely on the existing, untouched `003_journal_entries_immutability_trigger.sql`                                                                                                                                                                                                                                |
| Journal balances                                | Structural: `postSystemGeneratedEntry()` (§5) always builds exactly 2 lines of equal `amount_minor`, one debit one credit — balanced by construction. Existing `002_balance_invariant_trigger.sql` remains active as defense-in-depth regardless (untouched, still applies to every row in `journal_lines`)                          |
| Canonical accounts                              | `deferred_account_id`/`recognition_account_id` validated (exists, active, same tenant/legal entity) at schedule-creation time **and independently re-validated at each occurrence's execution time** — direct precedent: `journal-entries.service.ts`'s own explicit "never trusts the former" re-validation-at-post-time discipline |
| Canonical numbering                             | Reuses existing `allocateJournalNumber()` unchanged                                                                                                                                                                                                                                                                                  |
| Correct period                                  | Reuses existing `resolvePeriodForDate()` unchanged                                                                                                                                                                                                                                                                                   |
| Correct tenant/legal entity                     | RLS (`SET LOCAL` via `withTenant()`) + explicit `eq()` predicates on every query, identical to the rest of the codebase                                                                                                                                                                                                              |
| Audit/provenance                                | `deferral_recognitions.schedule_id` + `.resulting_journal_entry_id` give the full chain; `audit_logs` rows with `entityType: "deferral_schedule"` / `"deferral_recognition"`, reusing the existing shared, immutable `audit_logs` table — no new audit infrastructure                                                                |

---

## 4. Mutation Paths

- **Create schedule**: validates accounts/currency/amount-sum, inserts the header + all N occurrence rows (explicit dates/amounts from the request — never computed by even division), all in one transaction.
- **Cancel schedule**: bulk-transitions remaining `SCHEDULED` occurrences to `CANCELLED` + header `ACTIVE → CANCELLED`, one transaction. Not reversible (no "uncancel" exists for any entity in this codebase).
- **Process-due** (execute one occurrence): see §6.
- **No amendment endpoint.** Per Phase 1.4 (Model B): amendment is cancel-then-create, composed by the caller from the two paths above — not a dedicated API.
- **No true-up, no retry endpoint.** Per Phase 1.2/1.5: nothing in this codebase auto-generates a correcting entry for anything, and nothing auto-retries a `FAILED` row for anything; building either here would be inventing accounting behavior with zero repository precedent.

---

## 5. Accounting Core Integration — `JournalEntriesService.postSystemGeneratedEntry()`

**CTO-authorized additive method.** Exact composition, built only from primitives `completeReversalPosting()` itself already uses:

```
postSystemGeneratedEntry(tx, tenantId, legalEntityId, actorUserId, lines, period, transactionDate, memo, currencyCode):
  1. insert journal_entries header (status will become POSTED in step 4; no reversalOf/reversedBy linkage — those columns stay null)
  2. insertLines(tx, tenantId, entryId, lines)   — existing private method, reused verbatim
  3. allocateJournalNumber(tx, tenantId, legalEntityId)  — existing private method, reused verbatim
  4. UPDATE journal_entries SET status='POSTED', journalNumber, periodId, postedAt, postedBy
  5. audit_logs: CREATE + POST rows, entityType "journal_entry" — same two rows completeReversalPosting()
     already writes for the entry it creates, so every system-generated entry gets the identical
     audit shape regardless of which caller created it
  6. return the posted entry with lines
```

Zero changes to `completeReversalPosting()`, `reverse()`, `reverseInTx()`, `post()`, `create()`, `lockAndValidateOriginalForReversal()`, `resolvePeriodForDate()`, `resolveAndLockOpenPeriod()`, `insertLines()`, `allocateJournalNumber()` — all reused as-is, none modified. `insertLines()` and `allocateJournalNumber()` change from `private` to package-internal visibility only (the same visibility change already precedented by how `lockAndValidateOriginalForReversal` and `completeReversalPosting` themselves were made non-`private` specifically for `scheduled_reversals` to call) — their bodies are untouched.

The new `RecognitionExecutionsService` (Deferral's own execution logic) calls `postSystemGeneratedEntry()` and then separately writes its own `deferral_recognition`-scoped `EXECUTE` audit row — mirroring exactly how `ScheduledReversalsService.claimAndExecuteOne()` writes its own `EXECUTE` row on top of what `completeReversalPosting()` already wrote for the journal side.

---

## 6. Concurrency Model and Transaction Boundary

Lock order — simpler than `scheduled_reversals`' because there is no "original entry" to lock (this is fresh recognition, not a reversal of something):

1. `deferral_recognitions` row — `FOR UPDATE SKIP LOCKED` (a concurrent claim of the same row skips cleanly, never blocks)
2. Re-validate `deferred_account_id`/`recognition_account_id` (still exist, active, same tenant/entity)
3. `resolvePeriodForDate()` — existing method, unchanged, its own `FOR UPDATE` on the period row

One transaction, per occurrence, exactly mirroring `claimAndExecuteOne()`:

```
1. FOR UPDATE SKIP LOCKED the occurrence row → not SCHEDULED or lost the race → skip
2. re-validate accounts
3. resolvePeriodForDate(targetDate)
   NOT_FOUND → leave SCHEDULED (retried later, not a failure) — no audit row, matches
               scheduled_reversals' identical precedent exactly
   CLOSED    → transition to FAILED with reason, write FAIL audit row, check schedule completion
   OPEN      → build 2 balanced lines (debit/credit determined by the schedule's configured
               direction) → postSystemGeneratedEntry() → set resulting_journal_entry_id,
               transition to EXECUTED → write EXECUTE audit row → check schedule completion
               (transition ACTIVE→COMPLETED if no SCHEDULED occurrences remain for this schedule)
4. commit
```

Candidate selection (`processDue()`) is a lock-free read in its own short transaction; each candidate is claimed and executed in a **separate** subsequent transaction, one at a time — identical to `scheduled_reversals.processDue()`.

Schedule-cancel vs. occurrence-claim race: the header row's own `FOR UPDATE` lock during cancel, vs. the occurrence row's own `FOR UPDATE SKIP LOCKED` during claim — whichever transaction commits first wins, structurally identical to `scheduled_reversals`' documented and 50-repetition-tested race resolution (Phase 0A Scenario D). No new locking primitive is introduced.

---

## 7. Authorization

`finance.poster`: create schedule, cancel schedule, process-due. `finance.viewer` / `finance.poster` / `finance.admin`: read/list/reporting routes. No new role — matches the existing `scheduled_reversals` precedent exactly and the Phase 1 RBAC resolution; no repository evidence supports a new role specifically for this capability.

---

## 8. Migration Plan

- New migration `0025_deferral_recognition_engine.sql`: `deferral_schedule_status`, `deferral_recognition_status` enums; `deferral_schedules`, `deferral_recognitions` tables with all constraints/indexes from §1; FKs to `chart_of_accounts`, `journal_entries`, and each other.
- New constraint files (next available: `028`, `029`, `030`): `deferral_schedules_terminal_immutability_trigger.sql`, `deferral_recognitions_terminal_immutability_trigger.sql`, `deferral_schedules_amount_reconciled_trigger.sql` (the deferred constraint trigger from §1/§3).
- New RLS file (next available: `018_deferral_recognition_rls.sql`): standard `tenant_isolation` policy on both new tables, same pattern as every prior RLS file.
- **No `ALTER TABLE` on any existing table.** `journal_entries`, `accounting_periods`, `chart_of_accounts`, `scheduled_reversals` are all untouched structurally. The only existing-file change anywhere is the additive method in `journal-entries.service.ts` (§5) plus the two `private → package-internal` visibility changes it depends on.

---

## 9. Explicitly Out of Scope

Fixed Assets, depreciation, Multi-Currency/FX revaluation, Project WIP, Projects, scheduler/queue/worker infrastructure, event-driven/settlement-triggered Accrual reversal, a new approval/RBAC role, true-up generation, automatic retry of `FAILED` occurrences, an "amend" API, remediation of the Category B baseline regression (`drizzle-orm` error-wrapping — tracked separately, not touched here).

---

## 10. Fixed Assets / Multi-Currency Reuse — sharpened from the discovery

The genuinely reusable asset is **`postSystemGeneratedEntry()` itself (literal code reuse, capability-agnostic) plus the claim/lock/period/audit algorithm and terminal-immutability-trigger convention (a design template)** — not the `deferral_schedules`/`deferral_recognitions` tables themselves, which are appropriately capability-specific (a depreciation schedule needs asset-specific columns; an FX revaluation schedule needs rate-resolution logic) and were deliberately _not_ given a shared discriminator column, per Governing Principle 15. A future Fixed Assets or Multi-Currency capability would get its own dedicated table pair, its own domain-specific validation, and would call `postSystemGeneratedEntry()` directly and follow the identical claim/lock/period/audit transaction shape — without requiring any change to it, `journal_entries`, `deferral_schedules`, or `deferral_recognitions`. **PASS** for both, on this corrected, more precise basis.
