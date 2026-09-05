# Stage 1B — Implementation Plan (V2, CTO-Approved)

**Status:** Design/content approved by NOAH (CTO). This document is the approved artifact for Stage 1B's implementation. It does **not**, by itself, authorize implementation — see §12 ("Implementation sequence") below and `docs/project/DECISIONS.md` DEC-007 for the explicit approval-vs-authorization distinction.

This document merges the original Stage 1B implementation-preparation proposal with its CTO-requested correction (V2: state count fixed to 14; implementation sequence corrected for artifact-SHA pinning; single-source-of-truth requirement for the validator's state machine) into one self-contained record.

---

## Locked boundaries (CTO-approved)

- Canonical architecture: **Git-native Option A** — no new orchestrator service, no new database.
- Canonical format: **Markdown + strict YAML front matter + structured, append-only history.**
- Canonical documentation path: **`docs/orchestrator/`**.
- Task records: **`docs/orchestrator/tasks/`**.
- Proposal artifacts: **`docs/orchestrator/proposals/`**.
- Validator package: **`packages/orchestrator-validator`** (a library/tooling package — no Dockerfile, no port, no `noryx.module.json`, no `docker-compose.yml` entry; not a deployable service).
- YAML parser: **`js-yaml`**, using strict `JSON_SCHEMA` load behavior.
- Test convention: **`*.test.ts`**.
- Canonical state model: **14 states** (listed in full below), with transitions, decision gates, and terminal-state derivation represented **exactly once**, in code, as `STATES` + `TRANSITIONS` + derived terminal states + `deriveStatus()` in `state-machine.ts` — no independently maintained duplicate anywhere else, including in documentation.
- **CODEOWNERS: no change.** The existing default approval rule (`* @jerinibrahim-cyber`, one approval) applies to every new path this plan introduces.
- **CI: no change in this stage.** CI wiring to actually run the validator against real PRs is a separate, later, independently-reviewed PR.
- **Explicitly out of scope:** n8n (in any role beyond a possible future external-automation boundary — never as the control plane or source of truth); RAG or vector database implementation; autonomous agent loops; automatic task selection; automatic merges or direct pushes to `main`; any new deployable service; any new database; any application/product behavior change.

---

## 1. Repository inspection findings (as of baseline `8021c367c222b6b09059b4be61ada7bf1737a09b`)

1. **Project-memory files** — `CLAUDE.md`, `docs/project/{PROJECT_STATE,CURRENT_PHASE,NEXT_TASK,DECISIONS}.md` — read in full during discovery; their content and the process by which this plan updates them are described throughout this document.
2. **CI structure** — `.github/workflows/ci.yml`: `secrets-scan` (gitleaks) → `lint-typecheck` / `test` / `test-e2e` (real Postgres 16, RLS-bypass guard) / `sast` (Semgrep) / `sca` (`pnpm audit` + OSV-Scanner) / `iac-scan` (Checkov) → `build` → `docker-build-scan` (Trivy, cosign, SBOM) on `main` pushes only. `build`/`lint`/`test`/`typecheck` all run as `turbo run <task>`, which sweeps every `pnpm-workspace.yaml` member (`apps/*`, `services/*`, `packages/*`) automatically — a new `packages/*` member's own lint/typecheck/build/unit-tests are covered by the existing pipeline with **zero** edits to `ci.yml`.
3. **Test framework/conventions** — Jest `^29.7.0` uniformly across every package/service; `ts-jest` preset confirmed in `packages/event-bus-client`. Two file-naming conventions coexist (`*.test.ts` in `packages/db-core`/`packages/event-bus-client`; `*.spec.ts` in `packages/auth-core`/`services/sphere-finance`) with no repo-wide rule favoring either — `*.test.ts` is adopted here to match the closer structural sibling (`packages/event-bus-client`, another dependency-light shared library, not a service).
4. **CODEOWNERS** — `* @jerinibrahim-cyber` default (one approval); two-approval surfaces limited to `services/identity/`, `packages/db-core/drizzle/rls/`, `services/sphere-finance/`, `services/sphere-hrms/`. No entry matches `docs/` or a new `packages/orchestrator-validator/`. No change proposed.
5. **Documentation conventions** — numbered-§-section proposal docs; condensed reference docs (`architecture.md`, `security.md`, `plug-and-play-modules.md`); `docs/project/*.md` as the five Stage-1A memory files. `docs/orchestrator/` did not exist prior to this PR.
6. **Existing schema/validation utilities** — no YAML parsing library exists anywhere in the repository prior to this plan (confirmed by search across every `package.json`) — `js-yaml` is therefore the one genuinely new dependency this design requires. `class-validator` (`^0.14.1`) and `class-transformer` (`^0.5.1`) already exist in `services/identity` and `services/sphere-finance` and are reused for validating the parsed front-matter object, avoiding a third-party schema library (`zod`/`ajv`/`joi`) with no precedent in this codebase. No front-matter-extraction library is needed — the format is fully our own.

---

## 2. Proposed file tree under `docs/orchestrator/`

```
docs/orchestrator/
├── README.md                          # what this directory is, links to SCHEMA.md
├── SCHEMA.md                          # front-matter + history shapes; does NOT reprint the transition
│                                       # table — that lives only in packages/orchestrator-validator/
│                                       # src/state-machine.ts, referenced here by path, to guarantee
│                                       # there is exactly one place it can ever be edited (see §6).
├── proposals/
│   └── 1B-implementation-plan.md      # this document
└── tasks/
    └── 1B-orchestrator-foundation-<suffix>.md   # the one worked example (§9) — created in a later step
```

---

## 3. Canonical task-record schema

**Required YAML front matter:**

```yaml
schema_version: 1 # int — required, immutable once set
task_id: "1B-orchestrator-foundation-4f2a" # required, immutable (see task-ID rules below)
title: "..." # required, mutable only via a new history entry
stage: "1B" # required, immutable
owner_role: CLAUDE # required, mutable — NOAH | CLAUDE | ANTIGRAVITY | HUMAN
status: DEFINED # required — DERIVED from history, never hand-set independently
revision: 0 # required, int — current proposal revision number
retry_of: null # optional — set only at creation, if this is a retry of a FAILED task
resumes_cancelled: null # optional — set only at creation, if this resumes a CANCELLED task
history: [...] # required, array — see §4
```

**Allowed values:** `owner_role` ∈ `{NOAH, CLAUDE, ANTIGRAVITY, HUMAN}`; `status` ∈ the 14 states in §5; `stage` is a free string matching the existing stage-label convention (`"1A"`, `"1B"`, ...), checked only for presence/non-emptiness.

**Immutable fields** (rejected if changed on an existing file, regardless of `history` state): `task_id`, `stage`, `schema_version`.

**Mutable fields** (change only as a consequence of a new, valid `history` entry): `title`, `owner_role`, `status` (derived), `revision` (derived from the count of `PROPOSAL_SUBMITTED` entries). `retry_of`/`resumes_cancelled` are set once, at creation, then immutable.

**Schema version:** `schema_version: 1` for everything in this document. A future incompatible change ships as `schema_version: 2`; the validator supports both rule sets simultaneously rather than reinterpreting old files.

**Stable task ID rules:** `<stage>-<slug>-<suffix>` — `<stage>` from the existing stage-label convention; `<slug>` a short kebab-case description chosen once by the creator; `<suffix>` a 4-character random hex string generated locally at creation (`crypto.randomBytes(2).toString("hex")`) — no external ID service, no registry, no network call. Immutable once created.

**Artifact reference structure** (used inside `history` entries only, never at the top level):

```yaml
artifact_ref:
  path: "docs/orchestrator/proposals/..." # nullable — null when not yet committed
  commit_sha: null # nullable — null WITH a note when not yet committed; never a silent omission
  revision: 1 # present on PROPOSAL_SUBMITTED / PROPOSAL_REVIEW entries
  pr_url: null # nullable — set once a PR exists
  ci_run_ref: null # nullable — set only on VERIFICATION_RESULT entries
  checks: [] # set only on VERIFICATION_RESULT entries — real CI job names from ci.yml
  note: "delivered, not yet committed" # required whenever commit_sha is null
```

---

## 4. Canonical structured history format

Every element of `history` is one of two shapes, discriminated by `type`:

```yaml
# Plain lifecycle entry
- type: DISCOVERY_STARTED # | PROPOSAL_SUBMITTED | BLOCKED | DEFERRED | RESUMED | CANCELLED
  actor: CLAUDE # NOAH | CLAUDE | ANTIGRAVITY | HUMAN
  timestamp: "2026-09-05T11:02:00Z" # required, ISO-8601 UTC, strictly increasing
  reason: "..." # required for BLOCKED/DEFERRED/CANCELLED
  resumed_to: null # required (a valid state) only on RESUMED entries
  artifact_ref: { ... } # required on PROPOSAL_SUBMITTED, omitted otherwise

# Decision entry — one of the five approval-semantics types
- type: PROPOSAL_REVIEW # | IMPLEMENTATION_AUTHORIZATION | VERIFICATION_RESULT | CODE_REVIEW_RESULT | CTO_FINAL_APPROVAL
  actor: NOAH
  decision: CHANGES_REQUIRED # allowed values are per-type — table below
  reviewed_revision: 0 # required on PROPOSAL_REVIEW entries
  artifact_ref: { ... } # required — the exact thing being decided on
  scope: "..." # required, non-empty, specific — see rules below
  timestamp: "2026-09-05T11:10:00Z"
  supersedes: null # index of an earlier entry of the SAME type, if this revises it
```

**Actors:** exactly `NOAH | CLAUDE | ANTIGRAVITY | HUMAN` — the four role strings already established across every project-memory file.

**Decision types and allowed values** (five distinct, non-conflatable types — the core fix that made proposal-approval and implementation-authorization separable, which is exactly what this Step-A/Step-B split exercises for real):

| Type                           | Allowed `decision` values                  | Gates transition                                     |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| `PROPOSAL_REVIEW`              | `APPROVED`, `CHANGES_REQUIRED`, `REJECTED` | `PROPOSED → APPROVED`                                |
| `IMPLEMENTATION_AUTHORIZATION` | `AUTHORIZED`, `WITHHELD`                   | `APPROVED → AUTHORIZED`                              |
| `VERIFICATION_RESULT`          | `PASSED`, `FAILED`                         | `VERIFICATION → CODE_REVIEW`/`FINAL_REVIEW`/`FAILED` |
| `CODE_REVIEW_RESULT`           | `APPROVED`, `CHANGES_REQUESTED`            | `CODE_REVIEW → FINAL_REVIEW`/`FAILED`                |
| `CTO_FINAL_APPROVAL`           | `APPROVED`, `REJECTED`                     | `FINAL_REVIEW → DONE`/`FAILED`                       |

**Timestamps:** ISO-8601 UTC, required, strictly increasing across the array.

**Artifact SHA references:** every `artifact_ref.commit_sha` is either a real, resolvable SHA that is an ancestor of (or equal to) the reviewing PR's base commit, or explicitly `null` with a `note` — never silently absent.

**Approval scope:** required, non-empty, specific free text on every decision entry — the validator rejects empty or single-generic-word values (`"all"`, `"everything"`, `"task"`).

**Supersession/revision handling:** history is append-only — a decision is never edited. A later decision of the same type that revises an earlier one is a new entry with `supersedes` pointing at the earlier entry's index. "The current effective decision of a type" is always the latest entry of that type.

---

## 5. Complete state machine

**5.1 Canonical states — 14 total:** `DEFINED`, `DISCOVERY`, `PROPOSED`, `APPROVED`, `AUTHORIZED`, `IN_PROGRESS`, `VERIFICATION`, `CODE_REVIEW`, `FINAL_REVIEW`, `DONE` _(terminal)_, `FAILED` _(terminal)_, `BLOCKED`, `DEFERRED`, `CANCELLED` _(terminal)_.

**5.2 Every allowed transition** (a strict allow-list — anything not listed is forbidden):

| From                 | To                                   | Trigger                                                                    |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `DEFINED`            | `DISCOVERY`                          | plain entry                                                                |
| `DISCOVERY`          | `PROPOSED`                           | `PROPOSAL_SUBMITTED`                                                       |
| `DISCOVERY`          | `BLOCKED`                            | `BLOCKED`                                                                  |
| `PROPOSED`           | `PROPOSED`                           | `PROPOSAL_REVIEW: CHANGES_REQUIRED`                                        |
| `PROPOSED`           | `APPROVED`                           | `PROPOSAL_REVIEW: APPROVED`                                                |
| `PROPOSED`           | `CANCELLED`                          | `CANCELLED`                                                                |
| `APPROVED`           | `AUTHORIZED`                         | `IMPLEMENTATION_AUTHORIZATION: AUTHORIZED`                                 |
| `APPROVED`           | `DEFERRED`                           | `DEFERRED`                                                                 |
| `APPROVED`           | `CANCELLED`                          | `CANCELLED`                                                                |
| `AUTHORIZED`         | `IN_PROGRESS`                        | plain entry                                                                |
| `IN_PROGRESS`        | `VERIFICATION`                       | plain entry                                                                |
| `IN_PROGRESS`        | `BLOCKED` / `DEFERRED` / `CANCELLED` | respective entry                                                           |
| `VERIFICATION`       | `CODE_REVIEW`                        | `VERIFICATION_RESULT: PASSED` (+ review warranted)                         |
| `VERIFICATION`       | `FINAL_REVIEW`                       | `VERIFICATION_RESULT: PASSED` (+ review not warranted)                     |
| `VERIFICATION`       | `FAILED`                             | `VERIFICATION_RESULT: FAILED`                                              |
| `VERIFICATION`       | `BLOCKED`                            | `BLOCKED`                                                                  |
| `CODE_REVIEW`        | `CODE_REVIEW`                        | `CODE_REVIEW_RESULT: CHANGES_REQUESTED`                                    |
| `CODE_REVIEW`        | `FINAL_REVIEW`                       | `CODE_REVIEW_RESULT: APPROVED`                                             |
| `CODE_REVIEW`        | `FAILED`                             | `CODE_REVIEW_RESULT` marking the work unsalvageable (justified in `scope`) |
| `CODE_REVIEW`        | `BLOCKED`                            | `BLOCKED`                                                                  |
| `FINAL_REVIEW`       | `DONE`                               | `CTO_FINAL_APPROVAL: APPROVED`                                             |
| `FINAL_REVIEW`       | `FAILED`                             | `CTO_FINAL_APPROVAL: REJECTED`                                             |
| `FINAL_REVIEW`       | `BLOCKED`                            | `BLOCKED`                                                                  |
| `BLOCKED`            | _(state blocked from)_               | `RESUMED` with `resumed_to`                                                |
| `BLOCKED`            | `DEFERRED` / `CANCELLED`             | respective entry                                                           |
| `DEFERRED`           | _(state deferred from)_              | `RESUMED` with `resumed_to`                                                |
| `DEFERRED`           | `CANCELLED`                          | `CANCELLED`                                                                |
| _(any non-terminal)_ | `CANCELLED`                          | `CANCELLED` with `reason`                                                  |

**5.3 Forbidden transitions:** anything not in the table above, including every skip (e.g. `PROPOSED → AUTHORIZED` directly) and every exit from a terminal state.

**5.4 Terminal-state rules:** `DONE`, `FAILED`, `CANCELLED` are frozen the instant reached — no further diff to that file of any kind is accepted, not even a metadata-only addition.

**5.5 `FAILED` handling / retry via `retry_of`:** `FAILED` is terminal; the file is never reopened. A retry is a **new task file** with its own new `task_id` and `retry_of: <failed task_id>`, set once at creation. No back-reference is added to the old file — the connection is fully recoverable in the other direction, and an unconditional "terminal means frozen, full stop" rule is easier to trust and enforce than one with a whitelisted exception. `resumes_cancelled` behaves identically for deliberately resuming abandoned work.

**5.6 `CHANGES_REQUIRED` behavior:** a `decision` value on `PROPOSAL_REVIEW`/`CODE_REVIEW_RESULT` entries, never a `status`. Recording it leaves `status` unchanged (`PROPOSED` or `CODE_REVIEW`); the next `PROPOSAL_SUBMITTED` entry's `revision` increments by one.

**5.7 Status derivation from history:** `status` in the front matter is never independently authoritative — it must equal the result of replaying the file's `history` through the table in §5.2, from `DEFINED`. This is implemented as a single function, not a separately hand-checked rule — see §6.

---

## 6. Deterministic validator

**Exact validations:**

1. **Schema validation** — strict front matter (unknown keys rejected, not ignored; required fields/types/enums per §3).
2. **Transition validation**, **approval-gate validation**, and **status derivation** — these are not three separate implementations. They are three names for the outcome of one function call, `deriveStatus(history)`, backed by one exported table (see "Single authoritative representation" below).
3. **Append-only history validation** — given the file's content at the PR's merge-base (`BASE`) and in the PR (`HEAD`): `len(HEAD.history) ≥ len(BASE.history)` and every index in `[0, len(BASE.history))` is deep-equal between `BASE` and `HEAD`. This single invariant is what rejects modification, deletion, reordering, and backdating of any _existing_ entry — a reordered or deleted entry necessarily fails deep-equality at some index, regardless of how the diff is framed.
4. **New-entry ordering** — every newly appended entry's `timestamp` is strictly greater than the one before it.
5. **Terminal freeze** — if `BASE`'s derived status is terminal, any diff to the file at all is rejected (fast-fail, backed by the same derived terminal-state set used everywhere else — see below).
6. **`task_id`/`stage`/`schema_version` immutability** — any diff changing these on a pre-existing file is rejected.
7. **Artifact SHA validation** — any new decision entry's `artifact_ref.commit_sha`, when non-null, must resolve to a commit that is an ancestor of or equal to the PR's base commit.
8. **Secret-pattern lint** — a narrow, deterministic regex check (PEM/key headers, long high-entropy runs) on new history-entry text fields, as defense-in-depth alongside the repository's existing gitleaks CI job.

**Input/output behavior:** input is (a) the list of changed files under `docs/orchestrator/tasks/**` from `git diff --name-only <merge-base> <head>`, and (b) each file's content at both refs via `git show <ref>:<path>` (tolerating non-existence at `<merge-base>` for a new file). No network access, no database. Output is a process exit code (`0`/`1`) plus a structured report naming exactly which check failed and why, per file. The check is atomic per PR — any single file's failure fails the run.

**Malformed-record handling:** fails closed, always — invalid YAML, missing required fields, or an unrecognized enum value is a hard failure (exit `1`), never silently skipped.

**Single authoritative representation (locked requirement):** exactly one data structure — not independently-maintained copies — describes states, transitions, decision gates, and terminality, in `packages/orchestrator-validator/src/state-machine.ts`:

```ts
export const STATES = [
  "DEFINED",
  "DISCOVERY",
  "PROPOSED",
  "APPROVED",
  "AUTHORIZED",
  "IN_PROGRESS",
  "VERIFICATION",
  "CODE_REVIEW",
  "FINAL_REVIEW",
  "DONE",
  "FAILED",
  "BLOCKED",
  "DEFERRED",
  "CANCELLED",
] as const; // length 14 — asserted by a test, not just stated in a comment

export interface TransitionRule {
  from: State;
  to: State;
  requiredDecision?: { type: DecisionType; decision: string }; // absent for plain transitions
}

// THE single, authoritative transition table — every row from §5.2, and nowhere else.
export const TRANSITIONS: TransitionRule[] = [/* ...all rows from §5.2... */];

// Terminal states are DERIVED, not hand-listed — a state with zero outgoing
// rows in TRANSITIONS is terminal, by construction, so "the terminal list"
// and "the transition table" cannot drift apart because there is only one of them.
export const TERMINAL_STATES = new Set(
  STATES.filter((s) => !TRANSITIONS.some((t) => t.from === s)),
);

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.has(state);
}

// The ONE function replaying a task's history against TRANSITIONS. This
// single function IS transition validation, approval-gate validation, and
// status derivation — there is no second copy of any of the three anywhere.
export function deriveStatus(history: HistoryEntry[]): DeriveResult {
  /* ... */
}
```

`docs/orchestrator/SCHEMA.md` does **not** reprint the transition table as static prose — it describes the front-matter/history shapes and explicitly points to `state-machine.ts` as the single source, so there is exactly one place the table can ever be edited.

---

## 7. Validator location, technology, and unit tests

**Location:** `packages/orchestrator-validator`, a new pnpm workspace package following the structural template of `packages/event-bus-client` (a small, dependency-light shared library — no Dockerfile, no port, no `noryx.module.json`, no `docker-compose.yml` entry, never a long-lived process; structurally identical in kind to `packages/db-core`'s existing standalone scripts). This is the repository's own established distinction between `services/*` (deployable) and `packages/*` (library/tooling) — not a new service.

**Technology:** TypeScript; **`js-yaml`** (new dependency, using `JSON_SCHEMA` to disable YAML 1.1's implicit-typing footguns — unquoted `yes`/`no`/`on`/`off`, native date coercion); **`class-validator` + `class-transformer`** (both already present elsewhere in the repo, reused rather than introducing a new schema library); Jest `^29.7.0` + `ts-jest`, matching `packages/event-bus-client`'s `jest.config.js`; test files named `*.test.ts`.

**Unit tests — exact coverage plan** (all via synthetic in-memory `BASE`/`HEAD` pairs; every transition/gate/terminal test exercises the real, imported `STATES`/`TRANSITIONS`/`deriveStatus`/`isTerminal` — never a hand-typed parallel table):

- **Single-source assertions:** `STATES.length === 14`; `TERMINAL_STATES` derived from `TRANSITIONS` equals exactly `{DONE, FAILED, CANCELLED}` (proving the _derivation_, not just the result — this would fail if an outgoing row were ever accidentally added from `DONE`).
- **Happy paths:** `DEFINED → DISCOVERY → PROPOSED` (new file, no `BASE`); full lifecycle `PROPOSED → APPROVED → AUTHORIZED → IN_PROGRESS → VERIFICATION → FINAL_REVIEW → DONE` (skipping code review); the same including a `CODE_REVIEW` loop with one `CHANGES_REQUESTED` before `APPROVED`; a `CHANGES_REQUIRED` cycle at `PROPOSED` with correct `revision` incrementing.
- **Invalid transitions (explicit negative cases):** `DEFINED → APPROVED` (skips states); `PROPOSED → AUTHORIZED` directly (skips `APPROVED`); `DONE → IN_PROGRESS` (exit from terminal); a `VERIFICATION_RESULT: PASSED` used to satisfy `PROPOSED → APPROVED` (wrong decision type for the gate) — each run against the real table, not a re-typed one.
- **History mutation/deletion/reordering:** an existing entry's `actor` changed; an existing entry's `scope` changed; an entry present in `BASE` missing from `HEAD`; two existing entries swapped in position.
- **Backdating:** a new entry timestamped earlier than the immediately preceding entry; a new entry timestamped earlier than an existing, unchanged entry elsewhere in `BASE.history`.
- **Terminal mutation:** any diff at all — even an apparently harmless new field — to a file whose `BASE`-derived status is terminal.
- **Invalid approvals:** an empty `scope`; a generic-only `scope` (`"approved"`); a decision entry whose `artifact_ref.commit_sha` does not resolve to an ancestor of the PR base.
- **`retry_of` behavior:** a new file with `retry_of` pointing at a real `FAILED` task — accepted; pointing at a non-`FAILED` task — rejected; attempting to set `retry_of` on an _existing_ file via a later diff — rejected.
- **Malformed records:** no front matter; invalid YAML; a missing required field; an unrecognized enum value; an extra, unrecognized top-level key — each a hard failure, never silently skipped.

---

## 8. CI integration (described only — not implemented in this stage)

A future, separate PR would add a path-scoped job/step (proposed name `orchestrator-validate`) to `.github/workflows/ci.yml`, running only on `pull_request` events touching `docs/orchestrator/tasks/**`, invoking the validator against `git diff --name-only <base> <head>` and failing the check (merge-blocking, like every other required job) on any violation. **Not implemented as part of this plan or its first implementation PR** — Turborepo's existing `build`/`lint`/`typecheck`/`test` sweep already covers the new package's own correctness with zero `ci.yml` edits; only _gating real task-record PRs_ needs this future change, and it deserves its own explicit, separately-reviewed sign-off since it touches a file every contributor's PRs run through.

---

## 9. Stage 1B task record (created once implementation is authorized and begins — not part of this ratification step)

Illustrative shape only, shown here so the schema in §3/§4 has one worked example to validate against once implementation begins. Not created as part of source-of-truth ratification (this document's own commit) — no task record is written until `packages/orchestrator-validator` exists to eventually check it, and until the events it would describe (proposal submission, review, authorization) have real, ancestor commit SHAs to cite:

```yaml
---
schema_version: 1
task_id: "1B-orchestrator-foundation-4f2a"
title: "Stage 1B — Git-native orchestration control plane (schema + validator)"
stage: "1B"
owner_role: CLAUDE
status: AUTHORIZED
revision: 1
retry_of: null
resumes_cancelled: null
history:
  - type: DISCOVERY_STARTED
    actor: CLAUDE
    timestamp: "<real timestamp>"
  - type: PROPOSAL_SUBMITTED
    actor: CLAUDE
    revision: 1
    artifact_ref:
      {
        path: "docs/orchestrator/proposals/1B-implementation-plan.md",
        commit_sha: "<this ratification PR's merge commit SHA>",
        revision: 1,
      }
    timestamp: "<real timestamp>"
  - type: PROPOSAL_REVIEW
    actor: NOAH
    decision: APPROVED
    reviewed_revision: 1
    artifact_ref:
      {
        path: "docs/orchestrator/proposals/1B-implementation-plan.md",
        commit_sha: "<same SHA>",
        revision: 1,
      }
    scope: "Option A, docs/orchestrator/, packages/orchestrator-validator, Markdown+YAML+history format, js-yaml/JSON_SCHEMA — implementation plan approved per DEC-007"
    timestamp: "<real timestamp>"
  - type: IMPLEMENTATION_AUTHORIZATION
    actor: NOAH
    decision: AUTHORIZED
    artifact_ref:
      {
        path: "docs/project/DECISIONS.md",
        commit_sha: "<Step B's real, separate merge SHA>",
      }
    scope: "Implementation of the schema + validator package exactly as approved; CI wiring explicitly excluded, authorized separately"
    timestamp: "<real timestamp>"
---
```

---

## 10. Project-memory updates required after successful implementation (not made now)

Once the validator/schema/example task record are implemented and verified: `docs/project/PROJECT_STATE.md` updated to record Stage 1B's schema/validator as implemented, with the real merge SHA; `docs/project/CURRENT_PHASE.md` given a new phase block mirroring Stage 1A's structure; `docs/project/NEXT_TASK.md` replaced with the Stage 1C objective (or a `ORCH-1B-CI-INTEGRATION` task if that's sequenced next); `docs/project/DECISIONS.md` given a further entry recording what shipped and restating what remains explicitly out of scope.

---

## 11. Security

No secrets/credentials/tokens/`.env` contents in any task record, schema doc, or validator source/tests/fixtures. The validator reads only Git-tracked file content via local Git plumbing — no network calls, no database connection. It checks that `actor`/`approver` fields are one of the four closed role strings but cannot verify real-world authorship — that accountability comes from GitHub's own commit/PR-author identity. Every task-record change goes through a normal PR under today's default CODEOWNERS rule (no change proposed). The one new dependency (`js-yaml`) is already covered by existing, unmodified CI (`pnpm audit`/OSV-Scanner scan the whole lockfile; gitleaks/Semgrep scan the whole repository) — no new security tooling is needed.

---

## 12. Implementation sequence (corrected for artifact-SHA pinning)

### A. Source-of-truth ratification (this PR)

- **Commit A1:** add this document at `docs/orchestrator/proposals/1B-implementation-plan.md`.
- **Commit A2:** after A1 exists and has a real SHA, update `docs/project/DECISIONS.md` (new entry citing A1's real SHA, recording proposal approval and explicitly _not_ recording implementation authorization) and `docs/project/NEXT_TASK.md` (removing `DISCOVERY_REQUIRED`, pointing at the authorization step as the next gate, without claiming implementation has started or been authorized).
- Merge this PR. This is the point at which an immutable Git SHA for the approved proposal exists on `main`.

### B. Implementation authorization (separate, later, small)

- A distinct commit/PR, branched only after A merges, records `IMPLEMENTATION_AUTHORIZATION: AUTHORIZED`, explicitly citing A's merged SHA. Not part of this PR.

### C. Implementation (separate, later)

- Branches from `main` only after A and B are both merged, so the approved artifact is already an ancestor of the implementation PR's base by construction. Implements `packages/orchestrator-validator` (§6/§7), `docs/orchestrator/README.md` + `SCHEMA.md`, and the Stage 1B task record (§9, now honestly completable). Must match the approved artifact exactly — any material deviation triggers a new proposal revision and approval, not an ad hoc change. Does not modify CI or CODEOWNERS.

### Then, separately:

- CI wiring (§8), its own PR.
- Project-memory closure updates (§10), once C is verified.

---

## 13. Files changed / must-not-change

**This PR (Step A) changes exactly:** `docs/orchestrator/proposals/1B-implementation-plan.md` (new); `docs/project/DECISIONS.md` (new entry appended); `docs/project/NEXT_TASK.md` (rewritten to reflect the new gate). Nothing else.

**Once implementation (Step C) proceeds, expected to change:** `packages/orchestrator-validator/{package.json,tsconfig.json,eslint.config.cjs,jest.config.js,src/*.ts,src/*.test.ts}`; `docs/orchestrator/README.md`; `docs/orchestrator/SCHEMA.md`; `docs/orchestrator/tasks/1B-orchestrator-foundation-<suffix>.md`; `pnpm-lock.yaml` (from adding `js-yaml`/`class-validator`/`class-transformer` as this package's dependencies).

**Must never change, in this or any of the above steps unless explicitly separately authorized:** anything under `services/`, `apps/`, `infra/`; `docker-compose.yml`; any existing `packages/*` content other than adding the new sibling directory; `.github/workflows/ci.yml`; `.github/CODEOWNERS`; any `.env`/`.env.example` file.

---

## 14. Testing/verification plan

**Claude:** runs the new package's `lint`/`typecheck`/`test`/`build` locally and reports exact results before requesting review (once Step C exists); confirms `git status --porcelain` shows only the expected files at every step.

**Antigravity:** re-runs the full CI suite equivalent and confirms zero change to any other package's/service's output; confirms `pnpm audit --audit-level=high` stays clean with the one new dependency; confirms every negative-path unit test (§7) passes, not just happy paths.

---

## 15. Rollback plan

Step A (this PR): a plain `git revert` of its commits — pure documentation, no code, no schema, no dependency. Step C, once it exists: also a plain `git revert`, since `packages/orchestrator-validator` has zero consumers anywhere else in the monorepo.

---

## 16. Risks and unresolved questions

Carried forward, unresolved by choice rather than by gap (none block Step A): whether PR A and the Step-B authorization should be two commits in one PR or two separate PRs (a process-mechanics choice with no effect on the SHA-ancestor guarantee either way — this ratification PR is structured as two commits in one PR per the CTO's explicit instruction, resolving this for Step A specifically); the exact CI-wiring mechanics for Step 8 (deferred to that separate proposal).

---

_This document is the artifact `DEC-007` in `docs/project/DECISIONS.md` cites as approved. Implementation of `packages/orchestrator-validator` and any task record has not begun as of this commit._
