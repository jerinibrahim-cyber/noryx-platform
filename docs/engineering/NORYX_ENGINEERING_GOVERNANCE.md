# NoryX Engineering Governance

**Status:** Active / Ratified  
**Owner:** NoryX CTO / Product Owner  
**Last updated:** 2026-09-23

## Purpose

Defines authority boundaries, operational roles, and the controlled state-machine lifecycle for all NoryX engineering work.

## Authority

The CTO is the final authority for discovery authorization, proposal approval, implementation authorization, quality-gate approval, delivery authorization, and work-item closure.

No other actor may infer or manufacture CTO authorization.

## Roles

### CTO

Makes product, architectural, accounting, quality-gate, and delivery decisions. Evaluates technical evidence at the quality gate and issues explicit delivery authorization.

### CTO Copilot

Supports the CTO by organizing workflow, reviewing proposals/evidence, identifying architectural risks, drafting precise instructions, and guarding against scope drift and loops. Recommendations are advisory and never constitute CTO approval or delivery authorization.

### Claude

Performs repository discovery autonomously within approved scope, authors the required discovery package (`DISCOVERY.md`, `CONTRACT.md`, `ACCEPTANCE.md`, and discovery report), implements approved scope, executes verification suites, performs bounded technical remediation (maximum 2 implementation passes), generates completion reports, and produces verified Git bundles. Claude does not push to remotes or merge branches.

### Antigravity

Performs controlled delivery/push to the authorized target (default: `origin/main`) ONLY after explicit CTO delivery authorization (`NORYX CTO DELIVERY AUTHORIZATION: APPROVED`), verifies the remote state, and returns a delivery report. Antigravity does not modify production source code, alter implementation, silently repair tests, rebase, squash, or cherry-pick.

---

## Controlled Lifecycle & Unified 14-State Machine

Every work item progresses through an authoritative, finite 14-state machine:

```text
DISCOVERY (Pass 1 or 2)
→ PROPOSED
→ CTO_APPROVED (Proposal Approval)
→ IMPLEMENTATION_AUTHORIZED (CTO Implementation Authorization)
→ IMPLEMENTING (Pass 1 or 2)
→ VERIFIED
→ COMMITTED
→ REPORT_GENERATED
→ BUNDLE_VERIFIED
→ CTO_QUALITY_GATE (Quality-Gate Approval)
→ DELIVERY_AUTHORIZED (CTO Delivery Authorization)
→ DELIVERED / PUSHED (Default: origin/main)
→ CTO_DELIVERY_VERIFIED
→ CLOSED
```

Every transition requires the explicit authorization or verification appropriate to that transition. No state may automatically imply another.

---

## Two-Pass Maximum Rule

Both Discovery and Implementation operate under an explicit two-pass maximum:

- **Discovery:** Maximum 2 passes (Pass 1, Pass 2). Pass 2 is a consolidated refinement of Pass 1 addressing specific CTO feedback. If material issues remain unresolved after Pass 2, the work enters `HOLD / CTO DECISION REQUIRED`. There is no Discovery Pass 3.
- **Implementation:** Maximum 2 passes (Pass 1, Pass 2). Pass 2 addresses bounded remediation from quality-gate findings. If material issues remain unresolved after Pass 2, the work enters `HOLD / CTO DECISION REQUIRED`. There is no Implementation Pass 3.

---

## Discovery Autonomy & Canonical File Modification

### Technical Self-Correction vs. Scope Escalation

During discovery, Claude has autonomy within approved scope to inspect dependencies, adjacent modules, canonical services, database constraints, mutation paths, and runtime behavior. Claude may autonomously resolve technical contradictions, refine boundary conditions, add acceptance scenarios, and correct its own technical assumptions. Claude should not stop prematurely for issues resolvable within scope.

Claude must escalate to the CTO when an issue requires:

- product or business policy decisions;
- expansion of approved scope;
- changing a frozen architectural decision;
- contradicting an explicit prior CTO decision;
- changing accounting, financial, or legal invariants;
- changing authorization or security boundaries.

### Modifying Existing Canonical Files

The governance rule is: **Do not make unrelated or unnecessary changes outside approved scope.**

An architecturally necessary change to an existing canonical service, controller, schema, or configuration file is permitted when:

1. it is required by the approved capability;
2. it is within approved scope;
3. it is technically justified;
4. it is covered by acceptance criteria;
5. it is verified;
6. it is documented in the completion evidence.

Claude must not create duplicate or parallel abstractions merely to avoid touching an existing canonical component when extending the canonical component is the sound architectural design.

---

## Git Bundle Hard Gate & Delivery Package

The Git bundle is a **mandatory hard quality gate**.

- Every implementation pass must generate a Git bundle from the final commit and verify it with `git bundle verify`, `git bundle list-heads`, and an independent fetch into a fresh repository.
- If source changes occur after a bundle is generated, the bundle **MUST be regenerated and reverified**. A stale bundle is invalid.
- If the bundle is missing, stale, inaccessible, or unverifiable, the CTO quality-gate review must not be considered complete.

The mandatory delivery package consists of: work-item ID, approved baseline SHA, approved final SHA, completion report, acceptance evidence, regression evidence, delivery/handoff report, Git bundle, bundle verification evidence, fresh-fetch verification, clean working-tree status, and delivery target.

---

## CTO Quality Gate vs. Delivery Authorization

These are two separate authorities:

1. **CTO Quality-Gate Approval:** Certifies that the implementation evidence is technically acceptable for delivery. It does NOT authorize pushing.
2. **CTO Delivery Authorization:** Requires explicit literal authorization:
   ```text
   NORYX CTO DELIVERY AUTHORIZATION: APPROVED
   ```
   This permits Antigravity to deliver the approved SHA to the designated delivery target.

No delivery authorization may be inferred from quality approval, passing tests, a completion report, a verified bundle, or ambiguous affirmations.

---

## Default Delivery Target & Delivery Semantics

- Unless the CTO explicitly designates another target, **the default delivery target is `origin/main`**.
- Normal delivery delivers the approved final state directly to the approved target without an implicit additional merge stage.
- Antigravity must push the exact approved SHA without modifying source code, rebasing, squashing, or cherry-picking. If delivery cannot proceed as authorized, Antigravity stops and reports `HOLD`.

---

## Source of Truth

Use this hierarchy:

1. Explicit current CTO instruction
2. Approved work-item contract
3. Acceptance matrix
4. Permanent engineering protocols
5. Repository architecture/patterns
6. Historical discussion

If sources conflict, stop and surface the conflict.

---

## Loop Prevention

Each work item has a finite lifecycle governed by the two-pass maximum. A failed gate reopens only the affected gate and direct dependencies. Do not repeatedly rediscover or review passed areas without new evidence.

---

## Closure

A work item closes only after CTO quality approval, explicit delivery authorization, Antigravity push to the approved target, remote SHA verification, and CTO delivery verification.
