# Next Task

**Task ID:** ORCH-1B-DESIGN  
**Status:** DISCOVERY_REQUIRED  
**Role:** NOAH / CTO + Product Owner  
**Workstream:** AI Engineering Orchestrator — Stage 1B

## Objective
Define the next safe, deterministic increment of the NOAH orchestration foundation without prematurely introducing RAG, autonomous agent loops, or broad application changes.

## Read first
1. `CLAUDE.md`
2. `docs/project/PROJECT_STATE.md`
3. `docs/project/CURRENT_PHASE.md`
4. `docs/project/NEXT_TASK.md`
5. `docs/project/DECISIONS.md`
6. Relevant existing architecture, roadmap, and proposal documents only as needed.

## Current task
NOAH must first determine the precise Stage 1B objective and scope. Once the objective is defined, Claude performs repository discovery against the actual codebase and produces a technical proposal describing the smallest high-quality implementation boundary, affected files/components, interfaces/data contracts, security implications, deterministic verification, rollback considerations, and unresolved risks.

NOAH then reviews the proposal as CTO. No substantive Stage 1B implementation begins until CTO approval is explicit.

## Stage 1B boundary
Stage 1B may establish deterministic orchestration/control primitives if discovery supports them, such as task/workflow state, handoff contracts, approval records, or related repository-backed control artifacts. The exact scope is **not predetermined** and must not be invented before discovery.

The following are not automatically included:
- RAG or vector database implementation.
- Autonomous agent loops.
- Automatic task selection.
- Automatic merges or direct main pushes.
- Broad application feature changes.
- Choosing the next Finance feature from stale roadmap documentation.

## Required workflow
YOU → NOAH defines Stage 1B objective → Claude repository discovery → Claude technical proposal → NOAH CTO review/approval → implementation → deterministic QA/verification → code review when warranted → NOAH final review → Git verification/state update.

## Success conditions
- Stage 1B has a clearly bounded, repository-grounded objective before implementation.
- Claude's proposal is based on actual current repository structure and code, not assumptions.
- Critical architecture, database/schema, security, auth/authz, tenant/RLS, production-impacting, breaking-API, scope, roadmap, and deviation decisions receive the required approval.
- No secrets are captured in project memory.
- No unapproved application behavior or runtime automation is introduced.

## Blocker rule
If repository state, architecture, roadmap authority, or Stage 1B scope is ambiguous, stop and surface the ambiguity to NOAH rather than inventing a decision.
