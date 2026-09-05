# Noryx Decision Log

Append new decisions; do not rewrite historical decisions unless explicitly authorized.

## DEC-001 — AI Engineering Role Separation
**Status:** LOCKED
**Date:** 2026-09-05

Noryx will use a JARVIS-style multi-agent workflow with explicit role separation:

- ChatGPT / JARVIS owns CTO/Product decisions, roadmap interpretation, task creation, workflow/state control, proposal approval, and final quality review.
- Claude acts as the senior engineer: repository discovery, technical proposal creation, complex implementation, and code review when assigned.
- Antigravity acts as an execution/verification worker: deterministic validation, browser/UI verification, parallel work, and delegated low-risk implementation where appropriate.
- Human approval remains required for decisions designated as human gates.

The workflow preserves the prior quality model: Claude performs technical discovery/proposal work against the actual repository, while ChatGPT independently reviews and approves before implementation.

## DEC-002 — Quality-First Orchestration
**Status:** LOCKED
**Date:** 2026-09-05

The orchestrator must optimize for engineering quality and traceability rather than maximum autonomy. No agent may silently expand scope or become the final authority over its own work. Approval, implementation, QA, code review, and final CTO review remain distinct states.

## DEC-003 — Repository as Durable Agent Memory
**Status:** LOCKED
**Date:** 2026-09-05

Version-controlled Markdown under `docs/project/` will provide durable workflow/project memory. Agent conversations are ephemeral context, not authoritative project history.
