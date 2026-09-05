# Noryx Project State

**Snapshot:** 2026-09-05  
**Repository:** `jerinibrahim-cyber/noryx-platform`  
**Authoritative product branch:** `main`  
**Last verified main commit:** `e04dd5887f057ff730045dacfacc6c936a106f18`

## Product
Noryx is a monorepo for **Noryx Sphere** (ERP · CRM · HRMS) and **Noryx Orbis** (CAFM/FM Intelligence), with shared multi-tenant platform services. The stack includes Node.js/TypeScript/NestJS backend services, PostgreSQL with RLS, React/TypeScript web, an event-driven internal core, and a versioned REST gateway.

## Product direction
The locked strategic direction is **Finance-first**. Other product areas are not to be inferred as the next implementation target unless the roadmap/state explicitly establishes them.

## Repository implementation state
The current `main` commit is the CTO-approved implementation of **Scheduled Reversal for Accruals and Other Timing Adjustments (Revision 2)**. Its commit records additive scheduled-reversal persistence, RLS/immutability constraints, behavior-preserving journal-engine refactoring, scheduled-reversal APIs/service, concurrency handling, and regression evidence of 548 unit + 783 e2e tests passing.

The fresh Claude validation also identified that the roadmap/checklist documentation is stale relative to this implementation and that there is no authoritative next Finance feature. Therefore the next Finance feature must **not** be invented from stale documents.

## Orchestrator state
**NOAH (Noryx Orchestration & AI Hub)** is the agreed name for the orchestration AI role.

Current phase: **Stage 1A — Project Memory Foundation**.

Stage 1A establishes durable repository memory and operating contracts through:
- `CLAUDE.md`
- `docs/project/PROJECT_STATE.md`
- `docs/project/CURRENT_PHASE.md`
- `docs/project/NEXT_TASK.md`
- `docs/project/DECISIONS.md`

The repository remains the source of truth. No RAG or autonomous orchestrator runtime exists in Stage 1A.

## Locked role separation
- **NOAH / ChatGPT:** CTO + Product Owner + orchestration/state controller + final quality gate.
- **Claude:** Senior Engineer / primary coder / technical proposal author and reviewer when assigned.
- **Antigravity:** execution, verification, browser/UI testing, and explicitly delegated low-risk work.
- **Human owner:** business authority and required approvals.

## Safety boundary
Never store secrets, credentials, tokens, `.env` contents, or other sensitive operational values in project memory. Critical architecture, database/schema, security, auth/authz, tenant/RLS, production-impacting, breaking-API, scope, roadmap, and deviation decisions require the appropriate human/CTO approval.
