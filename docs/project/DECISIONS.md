# Decisions

Append-only institutional memory for decisions that materially affect the AI engineering workflow. Do not record secrets or credentials.

## DEC-001 — AI Engineering Role Separation

**Status:** LOCKED  
**Date:** 2026-09-05

- **NOAH / ChatGPT:** CTO, Product Owner, orchestration/state controller, proposal approver, final quality gate.
- **Claude:** Senior Engineer / primary coder, repository discovery, technical proposal author, implementation, debugging, testing, and assigned code review.
- **Antigravity:** execution/verification, browser/UI testing, screenshots, parallel work, and explicitly delegated low-risk/repetitive implementation.
- **Human owner:** business authority and required approvals.

No agent is final authority over its own work.

## DEC-002 — Quality-First Orchestration

**Status:** LOCKED  
**Date:** 2026-09-05

The engineering loop remains: discovery/proposal → CTO review/approval → implementation → deterministic QA/verification → code review when warranted → CTO final review → Git verification/state update. These are distinct control points. Scope expansion, critical architecture/security/database/tenant/RLS/auth changes, breaking APIs, production-impacting changes, and roadmap changes require explicit approval.

## DEC-003 — Repository as Durable Agent Memory

**Status:** LOCKED  
**Date:** 2026-09-05

Git plus version-controlled Markdown is the durable source of truth for project state and engineering instructions. RAG is retrieval/context only and cannot override repository truth or approval authority.

## DEC-004 — Finance-First Direction; No Invented Next Feature

**Status:** LOCKED  
**Date:** 2026-09-05

Noryx remains Finance-first. The current repository contains a newer Scheduled Reversal implementation than some roadmap/checklist documents describe, and fresh validation found no authoritative next Finance feature. Therefore agents must not infer or invent the next Finance work item from stale documentation; ambiguity must be surfaced to NOAH.

## DEC-005 — Stage 1A Before RAG / Runtime Orchestration

**Status:** LOCKED  
**Date:** 2026-09-05

Establish repository project memory and operating contracts before implementing RAG, an autonomous orchestrator runtime, or agent loops. Stage 1A must not change application behavior.

## DEC-006 — Stage 1A Completion and Stage 1B Gate

**Status:** LOCKED  
**Date:** 2026-09-05

Stage 1A is complete after fresh-session validation passed, the documentation-only changes were merged to `main` as `733c30706a2c0c1baf2e4abdd29824739df26dd8`, and local `main` was fast-forwarded and verified clean. Stage 1B begins as a design/discovery task only. Its implementation scope must be established from the actual repository and approved by NOAH/CTO before substantive engineering work begins.

## DEC-007 — Stage 1B Revision 1 and Implementation Plan Approved (Proposal Approval Only — Implementation Not Yet Authorized)

**Status:** LOCKED  
**Date:** 2026-09-05

NOAH/CTO approved Stage 1B Revision 1 (the technical proposal correcting the state machine, approval semantics, and append-only history validation rules) and its subsequent Implementation Preparation V2 (correcting the state count to 14 and the implementation sequence to guarantee approved-artifact SHAs are always an ancestor of the implementation PR that relies on them).

**Approved proposal artifact:** `docs/orchestrator/proposals/1B-implementation-plan.md`, committed at `ef9b95049e5ac2cca8946870eeefc4b84c84b0d9`.

**Locked architectural decisions this approval covers (content/design approval only — see the explicit distinction below):**

- Canonical architecture: Git-native Option A — no new orchestrator service, no new database.
- Canonical format: Markdown + strict YAML front matter + structured, append-only history.
- Canonical documentation path: `docs/orchestrator/`, with proposal artifacts under `docs/orchestrator/proposals/` and task records under `docs/orchestrator/tasks/`.
- Validator package: `packages/orchestrator-validator` (a library/tooling package, not a deployable service).
- YAML parser: `js-yaml`, using strict `JSON_SCHEMA` behavior.
- Test convention: `*.test.ts`.
- Canonical state model: 14 states (`DEFINED, DISCOVERY, PROPOSED, APPROVED, AUTHORIZED, IN_PROGRESS, VERIFICATION, CODE_REVIEW, FINAL_REVIEW, DONE, FAILED, BLOCKED, DEFERRED, CANCELLED`), with transitions, decision gates, and terminal-state derivation represented exactly once, in code, as `STATES` + `TRANSITIONS` + derived terminal states + `deriveStatus()` in `state-machine.ts` — no independently maintained duplicate anywhere else, including in documentation.
- CODEOWNERS: no change; the existing default approval rule applies to every new path.
- CI: no change in this stage; CI wiring to run the validator against real PRs is a separate, later, independently-reviewed PR.
- Explicitly out of scope: n8n (in any role beyond a possible future external-automation boundary — never as the control plane or source of truth), RAG, autonomous agent loops, automatic task selection, automatic merges, and any application/product behavior change.

**Explicit distinction — proposal approval vs. implementation authorization:** this decision records that the design/content above is approved. It does **not** authorize implementation of `packages/orchestrator-validator` or any task record. Per the approved design's own approval-semantics model, `IMPLEMENTATION_AUTHORIZATION` is a separate, later decision, to be recorded only once this proposal-approval commit already exists in `main`'s history — deliberately not recorded here or anywhere yet.

## DEC-008 — Stage 1B Implementation Authorized

**Status:** LOCKED
**Date:** 2026-09-05

NOAH/CTO authorizes implementation of the Stage 1B orchestration foundation described in the approved proposal artifact. This decision is the separate, later `IMPLEMENTATION_AUTHORIZATION` referenced in DEC-007's own text, and is recorded only now that the proposal-approval commit already exists in `main`'s history, per the approved artifact's own approval-semantics model (a `PROPOSAL_REVIEW` approval and an `IMPLEMENTATION_AUTHORIZATION` are distinct decision types and are never conflated).

**Decision:** IMPLEMENTATION IS AUTHORIZED.

**Approved artifact this authorization covers:** `docs/orchestrator/proposals/1B-implementation-plan.md`, originally committed at `ef9b95049e5ac2cca8946870eeefc4b84c84b0d9` and ratified into `main` via PR #23, merge commit `878da4c2f4c945c1d44cad385f6965c309e41c81` (referenced here as the real, verified Gate A merge SHA — no placeholder).

**Authorized scope:** implementation of exactly what the approved artifact specifies, and nothing beyond it:

- `packages/orchestrator-validator` (the validator library/tooling package, modeled structurally on `packages/event-bus-client`), including `state-machine.ts` (`STATES`, `TRANSITIONS`, derived `TERMINAL_STATES`, `isTerminal()`, `deriveStatus()`) as the single authoritative representation of the state/transition/decision-gate logic, plus its accompanying unit tests (`*.test.ts`, including the negative cases and the `STATES.length === 14` safeguard the approved artifact specifies).
- `docs/orchestrator/README.md` and `docs/orchestrator/SCHEMA.md`.
- The illustrative example task record described in the approved artifact's §9, under `docs/orchestrator/tasks/`.

Any material deviation from the approved artifact discovered during implementation requires a new proposal revision and separate approval — not a silent change under this authorization.

**Exclusions preserved (all exclusions from the approved plan remain in force, unchanged by this authorization):**

- No changes to `.github/CODEOWNERS`.
- No changes to `.github/workflows/` or any other CI configuration — CI wiring to run the validator against real PRs remains a separate, later, independently-reviewed gate, not covered by this authorization.
- No changes to `apps/`, `services/`, `infra/`, `docker-compose.yml`, or `.env` files. `pnpm-lock.yaml` MAY change only as the deterministic consequence of adding the explicitly approved dependency/dependencies required by `packages/orchestrator-validator` — no unrelated dependency upgrades, additions, removals, or lockfile churn are authorized.
- No dependency installation beyond what the approved artifact's own scope requires within `packages/orchestrator-validator` itself.
- n8n, RAG, autonomous agent loops, automatic task selection, automatic merges, and any application/product behavior change remain explicitly out of scope.
- This authorization does not itself constitute or include a `VERIFICATION_RESULT`, `CODE_REVIEW_RESULT`, or `CTO_FINAL_APPROVAL` decision for the resulting implementation PR — those remain separate, later gates per the approved decision-semantics model.
