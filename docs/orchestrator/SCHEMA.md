# Task-record schema (Stage 1B, `schema_version: 1`)

This document describes the shape of a task-record file's YAML front
matter and its `history` array. It deliberately does **not** reprint the
state-transition/decision-gate table — that lives exactly once, in code,
at
[`packages/orchestrator-validator/src/state-machine.ts`](../../packages/orchestrator-validator/src/state-machine.ts)
(`STATES`, `TRANSITIONS`, derived `TERMINAL_STATES`, `isTerminal()`,
`deriveStatus()`), per `docs/orchestrator/proposals/1B-implementation-plan.md`
§6's locked "single authoritative representation" requirement.

## File shape

A task-record file is Markdown with a `---`-fenced YAML front-matter
block, parsed with `js-yaml`'s strict `JSON_SCHEMA` (disabling YAML 1.1's
implicit-typing footguns — unquoted `yes`/`no`/`on`/`off`, native date
coercion). Unknown top-level keys are rejected, not ignored.

## Front matter

| Field               | Type                                     | Mutability                                                |
| ------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `schema_version`    | integer                                  | immutable once set                                        |
| `task_id`           | string, `<stage>-<slug>-<4-hex>`         | immutable                                                 |
| `title`             | string                                   | mutable only via a new history entry                      |
| `stage`             | string                                   | immutable                                                 |
| `owner_role`        | `NOAH \| CLAUDE \| ANTIGRAVITY \| HUMAN` | mutable only via a new history entry                      |
| `status`            | one of the 14 canonical states           | **derived** from `history` — never hand-set independently |
| `revision`          | integer                                  | derived from the count of `PROPOSAL_SUBMITTED` entries    |
| `retry_of`          | string \| null                           | set only at creation, then immutable                      |
| `resumes_cancelled` | string \| null                           | set only at creation, then immutable                      |
| `history`           | array (see below)                        | append-only                                               |

`task_id` format: `<stage>-<slug>-<suffix>` — `<suffix>` a 4-character
random hex string generated locally at creation
(`crypto.randomBytes(2).toString("hex")`, see
`packages/orchestrator-validator/src/task-id.ts`) — no external ID
service, no registry, no network call.

## History entries

Every element of `history` is one of two shapes, discriminated by `type`:

**Plain lifecycle entry** — `type`, `actor`, `timestamp` (ISO-8601 UTC,
strictly increasing across the array), plus `reason` (required for
`BLOCKED`/`DEFERRED`/`CANCELLED`), `resumed_to` (required, a valid state,
only on `RESUMED`), and `artifact_ref` (required on `PROPOSAL_SUBMITTED`).

**Decision entry** — one of the five approval-semantics types below, plus
`actor`, `decision`, `artifact_ref` (required), `scope` (required,
non-empty, specific — the validator rejects generic values like `"all"`/
`"everything"`/`"task"`), `timestamp`, `supersedes` (index of an earlier
entry of the same type, if this revises it), `reviewed_revision`
(required on `PROPOSAL_REVIEW`), and `target_state` (see "Implementation
notes" below).

### Decision types and allowed values

| Type                           | Allowed `decision` values                  |
| ------------------------------ | ------------------------------------------ |
| `PROPOSAL_REVIEW`              | `APPROVED`, `CHANGES_REQUIRED`, `REJECTED` |
| `IMPLEMENTATION_AUTHORIZATION` | `AUTHORIZED`, `WITHHELD`                   |
| `VERIFICATION_RESULT`          | `PASSED`, `FAILED`                         |
| `CODE_REVIEW_RESULT`           | `APPROVED`, `CHANGES_REQUESTED`            |
| `CTO_FINAL_APPROVAL`           | `APPROVED`, `REJECTED`                     |

Each type gates a specific transition in `TRANSITIONS`; the five are
never interchangeable. History is append-only: a decision is never
edited — a later decision of the same type revising an earlier one is a
new entry with `supersedes` pointing at that entry's index.

### `artifact_ref`

```yaml
artifact_ref:
  path: "docs/orchestrator/proposals/..." # nullable — null when not yet committed
  commit_sha: null # nullable — null WITH a note when not yet committed; never a silent omission
  revision: 1 # present on PROPOSAL_SUBMITTED / PROPOSAL_REVIEW entries
  pr_url: null
  ci_run_ref: null # set only on VERIFICATION_RESULT entries
  checks: [] # set only on VERIFICATION_RESULT entries — real CI job names from ci.yml
  note: "delivered, not yet committed" # required whenever commit_sha is null
```

Every non-null `commit_sha` must resolve to a commit that is an ancestor
of (or equal to) the reviewing PR's base commit.

## Implementation notes — gaps the approved plan left open

The approved plan
(`docs/orchestrator/proposals/1B-implementation-plan.md`) specifies the
state model, decision-gate semantics, and append-only invariant
precisely, but a small number of mechanical details were left as prose
rather than a structured rule. Implementing a single deterministic
`deriveStatus()` required completing these; each is a narrow, additive
completion, not an architectural change, and each is called out here
for CTO awareness:

1. **Unnamed "plain entry" transitions.** §5.2 describes
   `AUTHORIZED -> IN_PROGRESS` and `IN_PROGRESS -> VERIFICATION` as
   "plain entry" without naming the history-entry `type` that triggers
   them (only `DEFINED -> DISCOVERY`'s `DISCOVERY_STARTED` was named).
   `IMPLEMENTATION_STARTED` and `VERIFICATION_STARTED` were added,
   following that same naming pattern.
2. **Ambiguous decision branches.** Two rows in §5.2 gate on the same
   (state, decision) pair but allow two different destinations:
   `VERIFICATION_RESULT: PASSED` from `VERIFICATION` (`CODE_REVIEW` or
   `FINAL_REVIEW`, "review warranted" in prose) and
   `CODE_REVIEW_RESULT: CHANGES_REQUESTED` from `CODE_REVIEW`
   (loop back to `CODE_REVIEW`, or `FAILED` — "unsalvageable" in prose).
   An optional `target_state` field on decision entries makes the choice
   explicit and machine-checkable, validated against the single
   `TRANSITIONS` table (required only when genuinely ambiguous).
3. **Unwired decision values.** `PROPOSAL_REVIEW: REJECTED` and
   `IMPLEMENTATION_AUTHORIZATION: WITHHELD` have no destination listed in
   §5.2. `REJECTED` is treated as a hard stop (`PROPOSED -> CANCELLED`),
   consistent with how `CTO_FINAL_APPROVAL: REJECTED` maps to a terminal
   state elsewhere in the same table. `WITHHELD` is treated as a
   recorded decision that leaves `status` unchanged (`APPROVED ->
APPROVED`), the same pattern §5.6 already establishes for
   `PROPOSAL_REVIEW: CHANGES_REQUIRED`.
4. **Resubmission after `CHANGES_REQUIRED`.** §5.6 describes "the next
   `PROPOSAL_SUBMITTED` entry's revision incrementing" after a
   `CHANGES_REQUIRED` cycle, but §5.2's table has no row for it. A
   `PROPOSED -> PROPOSED` row via `PROPOSAL_SUBMITTED` was added,
   mirroring the `CHANGES_REQUIRED` self-loop immediately above it.

None of these change the locked architecture, the 14-state model, the
approval-semantics types, or the append-only invariant — they complete
the transition table `TRANSITIONS` needs to be a total, deterministic
function, per §6's own requirement that it be exactly one authoritative
representation. See `packages/orchestrator-validator/src/state-machine.ts`
and `src/types.ts` for the exact code.
