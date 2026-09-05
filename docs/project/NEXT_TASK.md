# Next Task

**Task ID:** ORCH-1B-IMPLEMENTATION-AUTHORIZATION  
**Status:** SOURCE_OF_TRUTH_RATIFIED — AWAITING_CTO_IMPLEMENTATION_AUTHORIZATION  
**Role:** NOAH / CTO  
**Workstream:** AI Engineering Orchestrator — Stage 1B

## Objective

Record NOAH/CTO's explicit `IMPLEMENTATION_AUTHORIZATION` decision for Stage 1B's implementation plan, citing the exact commit SHA of the now-ratified proposal artifact, before any implementation of `packages/orchestrator-validator` or any `docs/orchestrator/tasks/` record begins.

## Read first

1. `CLAUDE.md`
2. `docs/project/PROJECT_STATE.md`
3. `docs/project/CURRENT_PHASE.md`
4. `docs/project/NEXT_TASK.md` (this file)
5. `docs/project/DECISIONS.md` — see DEC-007
6. `docs/orchestrator/proposals/1B-implementation-plan.md` — the approved proposal artifact

## Current state — what is and is not true right now

- Stage 1B Revision 1 and its Implementation Plan (V2) are **approved** (DEC-007), and the approved artifact is committed at `docs/orchestrator/proposals/1B-implementation-plan.md` (commit `ef9b95049e5ac2cca8946870eeefc4b84c84b0d9`).
- **Implementation has NOT begun.** No file exists yet under `packages/orchestrator-validator/` or `docs/orchestrator/tasks/`. `docs/orchestrator/README.md` and `docs/orchestrator/SCHEMA.md` do not exist yet either.
- **Implementation is NOT yet authorized.** No `IMPLEMENTATION_AUTHORIZATION` decision has been recorded anywhere in this repository. Proposal approval and implementation authorization are deliberately distinct decisions (per the approved design's own approval-semantics model) — approving the design does not itself authorize building it.

## Next gate (Step B, per the approved implementation plan §12)

A small, separate, docs-only change — not inferred or assumed by any future session — must explicitly record `IMPLEMENTATION_AUTHORIZATION: AUTHORIZED`, citing commit `ef9b95049e5ac2cca8946870eeefc4b84c84b0d9` (or this ratification's own merge commit, whichever NOAH specifies) as the artifact being authorized. Only once that record exists in `main`'s history may an implementation PR (Step C) branch from `main` and begin implementing `packages/orchestrator-validator` and the Stage 1B task record — this ordering exists specifically so an approved artifact's SHA is always an ancestor of the implementation PR that relies on it.

## Explicitly not done by this task

- Does not implement `packages/orchestrator-validator`.
- Does not create any file under `docs/orchestrator/tasks/`.
- Does not modify CI or CODEOWNERS.
- Does not touch any application/product code.

## Blocker rule

If repository state or approval status is ambiguous, stop and surface the ambiguity to NOAH rather than inventing a decision — unchanged from Stage 1A/1B's standing rule.
