---
schema_version: 1
task_id: "1B-orchestrator-foundation-4f2a"
title: "Stage 1B — Git-native orchestration control plane (schema + validator)"
stage: "1B"
owner_role: CLAUDE
status: IN_PROGRESS
revision: 1
retry_of: null
resumes_cancelled: null
history:
  - type: DISCOVERY_STARTED
    actor: CLAUDE
    timestamp: "2026-09-05T09:00:00Z"
  - type: PROPOSAL_SUBMITTED
    actor: CLAUDE
    revision: 1
    artifact_ref:
      path: "docs/orchestrator/proposals/1B-implementation-plan.md"
      commit_sha: "878da4c2f4c945c1d44cad385f6965c309e41c81"
      revision: 1
    timestamp: "2026-09-05T09:30:00Z"
  - type: PROPOSAL_REVIEW
    actor: NOAH
    decision: APPROVED
    reviewed_revision: 1
    artifact_ref:
      path: "docs/orchestrator/proposals/1B-implementation-plan.md"
      commit_sha: "878da4c2f4c945c1d44cad385f6965c309e41c81"
      revision: 1
    scope: "Option A, docs/orchestrator/, packages/orchestrator-validator, Markdown+YAML+history format, js-yaml/JSON_SCHEMA — implementation plan approved per DEC-007"
    timestamp: "2026-09-05T10:00:00Z"
  - type: IMPLEMENTATION_AUTHORIZATION
    actor: NOAH
    decision: AUTHORIZED
    artifact_ref:
      path: "docs/project/DECISIONS.md"
      commit_sha: "563046ebee324f89ae19dd738f6edcbe1e638128"
    scope: "Implementation of the schema + validator package exactly as approved in docs/orchestrator/proposals/1B-implementation-plan.md; CI wiring explicitly excluded, authorized separately per DEC-008"
    timestamp: "2026-09-05T21:00:00Z"
  - type: IMPLEMENTATION_STARTED
    actor: CLAUDE
    timestamp: "2026-09-06T04:00:00Z"
---

# Stage 1B — orchestrator foundation

This is the one worked example named in
`docs/orchestrator/proposals/1B-implementation-plan.md` §9, created now
that implementation is authorized (DEC-008) and `packages/orchestrator-validator`
exists to validate it against. It documents this very implementation
task: the schema, the validator package, and this directory's docs.

Every `artifact_ref.commit_sha` above is a real commit already on `main`
at the time this file was authored — the proposal-ratification merge commit
(`878da4c...`, Gate A) and the implementation-authorization decision's
merge commit (`563046eb...`, Gate B) — never a placeholder.
