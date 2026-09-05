# Current Phase

**Phase:** Stage 1A — Project Memory Foundation  
**Orchestrator:** NOAH  
**Workstream:** AI Engineering Orchestrator  
**Status:** Implementation / validation

## Objective
Create a small, durable, version-controlled memory layer that lets a fresh engineering-agent session reconstruct the current project state, operating rules, decisions, and immediate handoff without relying on prior chat context.

## In scope
1. `CLAUDE.md` — Claude operating contract and role boundaries.
2. `docs/project/PROJECT_STATE.md` — factual current-state snapshot.
3. `docs/project/CURRENT_PHASE.md` — current phase and constraints.
4. `docs/project/NEXT_TASK.md` — explicit current handoff contract.
5. `docs/project/DECISIONS.md` — append-oriented institutional decisions.

## Out of scope
- RAG or vector database implementation.
- Autonomous agent loops or runtime orchestration.
- Automatic task selection.
- Application feature changes.
- Automatic merges or direct main pushes.
- Reconstructing an unverified Finance roadmap choice.

## Locked workflow
YOU → NOAH decides WHAT → Claude discovers HOW + writes proposal → NOAH CTO approval → Claude implementation → Antigravity verification → Claude review when warranted → NOAH final review → Git verification/state update → next task.

## Current repository context
`main` is at `e04dd5887f057ff730045dacfacc6c936a106f18`, implementing Scheduled Reversal for Accruals and Other Timing Adjustments (Revision 2). Claude's fresh-session validation found substantial existing engineering documentation but no authoritative next Finance feature and a stale roadmap/checklist relative to the current implementation.

## Acceptance criteria
- A fresh Claude session can identify Noryx, the current repository state, the NOAH/Claude/Antigravity role separation, the current phase, the immediate task, source-of-truth rules, prohibitions, and approval gates from repository files alone.
- No secrets are stored.
- Stage 1A introduces no application behavior changes.
- Ambiguous/stale Finance roadmap information is explicitly surfaced rather than guessed.

## Approval
Stage 1A is a locked orchestrator-foundation task. Substantive product/runtime work continues through the proposal → CTO approval → implementation → verification → final-review workflow.
