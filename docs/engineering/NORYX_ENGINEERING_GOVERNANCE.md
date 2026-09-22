# NoryX Engineering Governance

**Status:** Active / Ratified  
**Owner:** NoryX CTO / Product Owner  
**Last updated:** 2026-09-17

## Purpose

Defines authority boundaries and the controlled lifecycle for NoryX engineering work.

## Authority

The CTO is the final authority for discovery authorization, proposal approval, implementation authorization, quality-gate approval, delivery authorization, and closure.

No other actor may infer or manufacture CTO authorization.

## Roles

### CTO

Makes product, architecture, quality, and delivery decisions.

### CTO Copilot

Supports the CTO by organizing workflow, reviewing proposals/evidence, identifying risks, drafting precise instructions, and preventing scope drift and loops. Recommendations are never represented as CTO approval.

### Claude

Performs discovery, proposal creation, implementation after explicit authorization, verification, bounded remediation, completion reporting, and Git-bundle creation. Claude does not push.

### Antigravity

Performs delivery/push after explicit CTO delivery authorization and verifies the remote result. Antigravity does not modify the implementation.

## Controlled Lifecycle

```text
CTO DISCOVERY AUTHORIZATION
→ CLAUDE DISCOVERY
→ PROPOSAL
→ CTO PROPOSAL REVIEW
→ CTO IMPLEMENTATION AUTHORIZATION
→ CLAUDE IMPLEMENTATION + VERIFICATION
→ COMPLETION REPORT + VERIFIED BUNDLE
→ CTO QUALITY GATE
→ CTO DELIVERY AUTHORIZATION
→ ANTIGRAVITY DELIVERY
→ CTO DELIVERY VERIFICATION
→ CLOSED
→ CTO DISCOVERY AUTHORIZATION
```

Every transition requires the authorization appropriate to that transition.

## Non-Inference Rule

No actor may infer authorization from prior conversation, proposal quality, successful tests, a completion report, another actor's recommendation, an ambiguous “go ahead,” or an existing branch/commit.

## Source of Truth

Use this hierarchy:

1. Explicit current CTO instruction
2. Approved work-item contract
3. Acceptance matrix
4. Permanent engineering protocols
5. Repository architecture/patterns
6. Historical discussion

If sources conflict, stop and surface the conflict.

## Loop Prevention

Each work item has a finite lifecycle. A failed gate reopens only the affected gate and direct dependencies. Do not repeatedly rediscover or review passed areas without new evidence.

## Closure

A work item closes only after CTO quality approval, explicit delivery authorization, Antigravity push, remote SHA verification, and CTO delivery verification.
