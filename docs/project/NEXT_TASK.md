# Next Task

## Task ID
ORCH-1A

## Status
IMPLEMENTATION_IN_PROGRESS

## Role
Senior Engineer / Repository Agent

## Workstream
AI Engineering Orchestrator — Project Memory Foundation

## Objective
Complete Stage 1A by establishing durable project memory and the agent operating contract without changing Noryx application behavior.

## Read first
1. `CLAUDE.md`
2. `docs/project/PROJECT_STATE.md`
3. `docs/project/CURRENT_PHASE.md`
4. `docs/project/DECISIONS.md`
5. `README.md`
6. `docs/architecture.md`
7. `docs/roadmap.md`
8. `docs/security.md`
9. `docs/plug-and-play-modules.md`

Then inspect relevant Finance documents only when needed to validate current state.

## Task
Validate and complete the five Stage 1A project-memory files. Ensure they are concise, factual, internally consistent, and do not duplicate the domain/reference documentation. Verify the final diff contains only the intended Stage 1A files.

## In scope
- Project memory content and consistency
- Agent role boundaries
- Workflow states and approval gates
- Current phase and task handoff information

## Out of scope
- Application source code
- Database/schema changes
- CI/CD changes
- RAG
- Orchestrator runtime/service
- MCP implementation
- Automatic approvals, commits, or merges
- Secrets or environment configuration
- Inventing the next Finance work item

## Do not
- Do not infer an unverified next feature from commit order.
- Do not rewrite existing roadmap/architecture/security documents.
- Do not store secrets, tokens, credentials, or `.env` contents.
- Do not push or merge this branch without explicit instruction.

## Expected output
- Validated Stage 1A memory files.
- Short report of any discrepancies found and how they were resolved.
- Final diff/file list.
- Validation performed.

## Success conditions
A fresh Claude session connected to the repository can answer: what Noryx is, the current product direction, the current orchestrator phase, the current task, each agent's role, approval boundaries, prohibited actions, and which documents to read next — without relying on a previous conversation.

## Approval
CTO review required before Stage 1A is considered complete.
