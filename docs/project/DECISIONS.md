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
