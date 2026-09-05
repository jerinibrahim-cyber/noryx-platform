# Noryx Project State

**State snapshot:** 2026-09-05
**Repository:** `jerinibrahim-cyber/noryx-platform`
**Authoritative branch:** `main`
**Last verified main commit:** `f750406c447f15e56e096e3ea288e4c4c2295874`

## Current product direction
Noryx is a multi-tenant platform spanning Noryx Sphere (ERP/CRM/HRMS) and Noryx Orbis (CAFM/FM). The roadmap is Finance-first. Sphere Finance is intended to be a complete finance suite, with the existing Accounting Core as its foundation.

## Current repository state
- Phase 0 foundation: largely implemented; remaining items include cloud service-parity work, standalone Subscription & Entitlement service/admin API, Kubernetes/Terraform scaffolding completion, and Tenant Provisioning Service.
- Phase 1: in progress.
- Accounting Core: complete and verified historically.
- Banking & Cash capability: roadmap marks bank accounts, bank transactions, reconciliation, payment reconciliation where applicable, cash management, receipts, payments, transfers, and cash position as complete.
- The latest repository commit is `Banking-1a — Bank/Cash Account Master`.

## Important sequencing rule
The roadmap explicitly distinguishes COMPLETE, IN PROGRESS, PLANNED, and DEFERRED. Do not infer the next work item from commit order alone. The next task must be established from authoritative project memory and/or an approved proposal.

## Orchestrator status
The AI engineering orchestrator is being built incrementally. Stage 1A establishes durable project memory and agent operating rules before adding orchestration services, RAG, or autonomous execution.

## Safety boundary
This file contains project state only. Never place secrets, credentials, tokens, private keys, `.env` values, or sensitive runtime configuration here.
