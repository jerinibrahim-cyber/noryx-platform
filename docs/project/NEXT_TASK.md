# Next Task

**Task ID:** ORCH-1B-IMPLEMENTATION  
**Status:** IMPLEMENTATION_AUTHORIZED — NOT_YET_STARTED  
**Role:** NOAH / CTO  
**Workstream:** AI Engineering Orchestrator — Stage 1B

## Objective

Implement exactly the Stage 1B orchestration foundation described in the approved proposal artifact (`docs/orchestrator/proposals/1B-implementation-plan.md`), now that implementation has been explicitly authorized (DEC-008) — and nothing beyond that artifact's scope.

## Read first

1. `CLAUDE.md`
2. `docs/project/PROJECT_STATE.md`
3. `docs/project/CURRENT_PHASE.md`
4. `docs/project/NEXT_TASK.md` (this file)
5. `docs/project/DECISIONS.md` — see DEC-007 (proposal approval) and DEC-008 (implementation authorization)
6. `docs/orchestrator/proposals/1B-implementation-plan.md` — the approved proposal artifact; implementation must match it exactly, with any material deviation requiring a new proposal revision and separate approval

## Current state — what is and is not true right now

- Stage 1B Revision 1 and its Implementation Plan (V2) are **approved** (DEC-007), committed at `docs/orchestrator/proposals/1B-implementation-plan.md` (commit `ef9b95049e5ac2cca8946870eeefc4b84c84b0d9`), and ratified into `main` via PR #23 (merge commit `878da4c2f4c945c1d44cad385f6965c309e41c81`).
- **Implementation is now AUTHORIZED** (DEC-008), citing the approved artifact and the Gate A merge commit `878da4c2f4c945c1d44cad385f6965c309e41c81`.
- **Implementation has NOT yet begun.** No file exists yet under `packages/orchestrator-validator/` or `docs/orchestrator/tasks/`. `docs/orchestrator/README.md` and `docs/orchestrator/SCHEMA.md` do not exist yet either.

## Next gate (Step C, per the approved implementation plan §12)

A new branch may now be created from `main` (which must contain DEC-008) to implement, in one PR: `packages/orchestrator-validator` (including `state-machine.ts` as the single authoritative representation of `STATES`, `TRANSITIONS`, derived `TERMINAL_STATES`, `isTerminal()`, and `deriveStatus()`, plus its unit tests), `docs/orchestrator/README.md`, `docs/orchestrator/SCHEMA.md`, and the illustrative example task record under `docs/orchestrator/tasks/` — exactly as specified in the approved artifact.

## Explicitly not done by this task

- Does not modify CI or CODEOWNERS — CI wiring remains a separate, later, independently-reviewed gate.
- Does not touch `apps/`, `services/`, `infra/`, `docker-compose.yml`, `.env` files, or `pnpm-lock.yaml`.
- Does not introduce n8n, RAG, autonomous agent loops, automatic task selection, or automatic merges — all remain explicitly out of scope.
- Does not record `VERIFICATION_RESULT`, `CODE_REVIEW_RESULT`, or `CTO_FINAL_APPROVAL` for the implementation PR — those are separate, later gates.

## Blocker rule

If repository state or approval status is ambiguous, stop and surface the ambiguity to NOAH rather than inventing a decision — unchanged from Stage 1A/1B's standing rule.
