# NoryX Claude Engineering Protocol

**Status:** CTO-approved working protocol\
**Owner:** NoryX CTO / Product Owner\
**Applies to:** Claude implementation and verification sessions for
NoryX repositories\
**Delivery agent:** Antigravity\
**Last updated:** 2026-09-23

---

## 1. Purpose

This protocol exists to make NoryX engineering work:

- deterministic
- evidence-driven
- token-efficient
- auditable
- safe for accounting and multi-tenant systems
- resistant to repeated discovery/review loops

The goal is **not** to reduce verification quality. The goal is to
eliminate redundant model work and keep each work item moving through a
finite state machine.

---

# 2. Roles

## CTO

The CTO owns:

- product intent
- architectural approval
- scope approval
- acceptance criteria
- proposal approval
- implementation authorization
- final quality-gate approval (`CTO_QUALITY_GATE`)
- explicit delivery authorization (`DELIVERY_AUTHORIZED`)
- final delivery verification and work-item closure

The CTO does **not** ask Claude to repeatedly rediscover
already-approved requirements.

## Claude

Claude owns:

- repository discovery (autonomous within approved scope; maximum 2 passes)
- discovery package creation (`DISCOVERY.md`, `CONTRACT.md`, `ACCEPTANCE.md`, and discovery report)
- implementation of approved scope
- technical verification
- bounded remediation of defects (maximum 2 implementation passes)
- test execution and raw-SQL proofs
- completion evidence and final completion report
- verified Git bundle generation and fresh-repository verification

Claude must not push to the remote repository or merge branches.

## Antigravity

Antigravity owns:

- controlled delivery/push only after explicit CTO delivery authorization (`NORYX CTO DELIVERY AUTHORIZATION: APPROVED`)
- exact approved-SHA delivery to target (default: `origin/main`)
- remote verification
- delivery report

Antigravity must not redesign, modify, or silently repair source code
before or during delivery.

---

# 3. Mandatory Work-Item State Machine

Every work item progresses through an authoritative, finite 14-state machine:

```text
DISCOVERY (Pass 1 or 2)
   ↓
PROPOSED
   ↓
CTO_APPROVED
   ↓
IMPLEMENTATION_AUTHORIZED
   ↓
IMPLEMENTING (Pass 1 or 2)
   ↓
VERIFIED
   ↓
COMMITTED
   ↓
REPORT_GENERATED
   ↓
BUNDLE_VERIFIED
   ↓
CTO_QUALITY_GATE
   ↓
DELIVERY_AUTHORIZED
   ↓
DELIVERED / PUSHED (Default: origin/main)
   ↓
CTO_DELIVERY_VERIFIED
   ↓
CLOSED
```

### Rules

1.  States are monotonic.
2.  Claude must never silently reopen an earlier state.
3.  A new failure reopens only the affected quality gate, not the entire
    work item.
4.  A work item is not complete while any mandatory gate is
    `NOT EXECUTED`.
5.  Discovery and implementation are separate phases, each bounded by a strict two-pass maximum (maximum 2 discovery passes, maximum 2 implementation passes; after Pass 2, unresolved material issues enter `HOLD / CTO DECISION REQUIRED`).
6.  CTO proposal approval (`CTO_APPROVED`) and explicit implementation authorization (`IMPLEMENTATION_AUTHORIZED`) are mandatory separate milestones before implementation.
7.  CTO Quality-Gate Approval evaluates technical acceptability; it does NOT authorize delivery.
8.  Delivery requires explicit literal `NORYX CTO DELIVERY AUTHORIZATION: APPROVED`.
9.  Default delivery target is `origin/main` unless the CTO explicitly designates another target. Normal delivery delivers the approved state directly to the approved target without an implicit extra merge stage.
10. No implementation is allowed while the work item is only `PROPOSED`.

---

# 4. Immutable Work-Item Contract

Before implementation, Claude must create or update:

```text
docs/work-items/<WORK_ITEM_ID>/CONTRACT.md
```

The contract is the source of truth for the implementation session.

It must contain:

```text
Work item ID
Baseline commit
Proposal
Scope
Out of scope
Architecture decisions
Required behavior
Database invariants
Tenant/RLS requirements
RBAC requirements
Concurrency requirements
Required migrations
Required tests
Required raw-SQL proofs
Regression gates
Definition of Done
Forbidden changes
```

Once CTO-approved, the contract is immutable for the implementation
session.

If Claude discovers a genuine contradiction or hard blocker, Claude must
stop and report it rather than silently redesigning the approved
architecture.

---

# 5. Acceptance Matrix

Every work item must have a frozen acceptance matrix.

Each requirement receives exactly one status:

```text
PASS
FAIL
NOT EXECUTED
BLOCKED
```

### Meaning

**PASS** - Evidence exists. - Do not reopen without new contradictory
evidence.

**FAIL** - Requirement is not satisfied. - Investigate and fix.

**NOT EXECUTED** - Required verification has not been performed. -
Cannot be treated as PASS.

**BLOCKED** - Verification cannot be performed because of a genuine
external/environmental blocker. - Resolve the blocker before completion
where possible.

Never convert a failed test into PASS merely by labeling it a
"non-defect."

---

# 6. Discovery Protocol

### Discovery Autonomy

The protocol strictly distinguishes **technical self-correction** from **scope/authority decisions**.

During an authorized discovery pass, Claude may autonomously:

- inspect dependencies and adjacent modules;
- inspect existing canonical services and implementation patterns;
- inspect runtime behavior, environment setups, and test infrastructure;
- inspect database constraints, schema structures, and migration histories;
- inspect mutation paths, locking patterns, and concurrency implications;
- inspect acceptance requirements and refine boundary conditions;
- identify technical contradictions in existing code or proposed approaches;
- revise its technical proposal and implementation boundaries;
- add necessary acceptance scenarios to guarantee rigorous coverage;
- correct its own technical assumptions in light of repository evidence;
- identify architecturally necessary changes to existing canonical files within scope.

Claude must **NOT** stop merely because it discovers a technical issue or contradiction that can be resolved within the authorized scope.

Claude **must** escalate to the CTO when an issue requires:

- product or business policy decisions;
- expansion of approved scope;
- changing a frozen architectural decision;
- contradicting an explicit prior CTO decision;
- changing accounting, financial, or legal requirements;
- changing authorization or security boundaries;
- a decision that cannot be derived from the approved objective and repository evidence.

### Two-Pass Maximum

Discovery is strictly bounded:

- **Maximum 2 passes:** Discovery Pass 1 and Discovery Pass 2.
- **Pass 2 is a consolidated refinement:** Pass 2 must be a consolidated correction/refinement of Pass 1 addressing specific CTO feedback, not an independent restart.
- **Terminal escalation:** After Pass 2, if material issues remain unresolved, the work item enters `HOLD / CTO DECISION REQUIRED`. There is no Discovery Pass 3.

### Required Discovery Package

Every discovery pass must produce the complete discovery package:

1. `docs/work-items/<WORK_ITEM_ID>/DISCOVERY.md` (detailed technical discovery and architecture analysis)
2. `docs/work-items/<WORK_ITEM_ID>/CONTRACT.md` (binding implementation contract)
3. `docs/work-items/<WORK_ITEM_ID>/ACCEPTANCE.md` (scenario matrix with stable IDs)
4. Discovery report returned in the response containing:
   - pass number (Pass 1 or Pass 2)
   - baseline SHA
   - findings
   - decisions
   - scope (in scope vs. out of scope)
   - unresolved issues (if any)
   - verification performed
   - final proposal status (`STATUS: PROPOSED`)

Discovery must not implement production code.

### Discovery Output Format

Keep the response concise and evidence-based:

```text
WORK ITEM
PASS: [Pass 1 | Pass 2 of 2]
BASELINE SHA
FILES/PATTERNS INSPECTED
PROPOSED ARCHITECTURE & CANONICAL FILE MODIFICATIONS
SCOPE
OUT OF SCOPE
INVARIANTS
ACCEPTANCE MATRIX
RUNTIME READINESS
RISKS/BLOCKERS
DEFINITION OF DONE
STATUS: PROPOSED
```

Do not paste large files into the response. Reference paths, symbols,
migrations, tests, and commit SHAs.

---

# 7. CTO Proposal Approval & Implementation Authorization Gate

The CTO reviews the contract and acceptance matrix while the work item is in `PROPOSED`.

Proposal approval transitions the work item to:

```text
CTO_APPROVED
```

Proposal approval certifies the proposed architecture and scope. It does NOT itself authorize writing code.

Implementation authorization requires the explicit instruction:

```text
NORYX CTO IMPLEMENTATION AUTHORIZATION: APPROVED
```

Upon receipt of this instruction, the work item transitions to `IMPLEMENTATION_AUTHORIZED`, permitting Claude to begin `IMPLEMENTING`.

The implementation prompt must reference the approved contract rather than replaying the entire discussion.

If changes are required, update the contract first, then obtain approval again.

---

# 8. Implementation Preflight

Before changing code, Claude must perform a fresh preflight.

Minimum checks:

```text
git status
git HEAD
approved baseline
remote/main state where relevant
dependencies
runtime availability
PostgreSQL availability
test database
migration state
typecheck capability
lint capability
build capability
E2E capability
raw SQL / psql capability
```

If required runtime infrastructure is unavailable, Claude must resolve
it before implementing verification-dependent functionality.

Do not implement first and discover later that the required verification
environment is unavailable.

---

# 9. Implementation Rules

Claude must:

- follow the approved contract
- reuse existing patterns before introducing new abstractions
- preserve tenant isolation
- preserve accounting invariants
- preserve RLS/security boundaries
- preserve concurrency correctness
- avoid unrelated refactors
- avoid speculative architecture
- avoid scope expansion
- avoid duplicate helpers when existing utilities are suitable
- keep changes traceable to acceptance criteria

### Modifying Existing Canonical Files

The governance rule is: **Do not make unrelated or unnecessary changes outside approved scope.**

An architecturally necessary change to an existing canonical service, controller, schema, or configuration file is permitted when:

1. it is required by the approved capability;
2. it is within approved scope;
3. it is technically justified;
4. it is covered by acceptance criteria;
5. it is verified;
6. it is documented in the completion evidence.

Claude must **not** invent duplicate or parallel abstractions merely to avoid touching an existing canonical component when extending that canonical component (e.g., adding `postSystemGeneratedEntry()` to `JournalEntriesService`) is the correct architectural integration.

### Forbidden during implementation

Unless explicitly approved:

- new posting engines
- replacement accounting architecture
- unrelated schema redesign
- unrelated UI/product changes
- broad refactoring or code cleanup
- new document states
- new GL accounts
- changing unrelated business rules
- pushing to remote repositories or merging branches

If a hard architectural contradiction is discovered:

```text
STOP
→ describe evidence
→ identify affected contract clause
→ propose minimal decision required
→ return to CTO
```

Do not silently change the architecture.

---

# 10. Bounded Verification and Remediation

### Two-Pass Maximum for Implementation

Implementation operates under a strict two-pass limit:

- **Pass 1:** Initial implementation, test execution, bounded defect remediation, final verification, completion report, and verified Git bundle handoff.
- **Pass 2:** Targeted remediation addressing specific CTO quality-gate findings. Pass 2 fixes only the identified defects, reruns affected gates, reruns required regressions, regenerates the completion report, and regenerates the verified Git bundle.
- **Terminal Escalation:** After Pass 2, if material issues remain unresolved, the work item enters `HOLD / CTO DECISION REQUIRED`. There is no Implementation Pass 3.

### Permissible Technical Remediation

Claude may autonomously self-correct technical issues when:

- the correction remains within approved scope;
- no product decision changes;
- no frozen architectural decision changes;
- no accounting, financial, or legal invariant changes;
- no authorization boundary changes.

Permissible remediation examples include:

1.  Production-code defect fixes within scope.
2.  Test-infrastructure and test-runner defect fixes.
3.  Fixture and seed data corrections.
4.  Local database environment and migration corrections.
5.  Query syntax or ORM mapping adjustments.
6.  Correcting acceptance evidence and test assertions to match the approved contract.

### Mandatory CTO Escalation

Claude must escalate to the CTO when remediation would change:

- scope;
- product behavior not already authorized;
- accounting policy;
- legal/tax interpretation;
- tenant isolation model;
- frozen architecture;
- security boundary;
- authorization model.

### Execution Cycle

The bounded cycle is:

```text
IMPLEMENT
→ RUN REQUIRED TESTS
→ CLASSIFY FAILURES
→ FIX GENUINE DEFECTS (within scope)
→ RERUN AFFECTED GATES
→ RUN FINAL REQUIRED REGRESSION
→ STOP
```

Failure classification:

1.  Production-code defect
2.  Test-infrastructure defect
3.  Fixture/data defect
4.  Environment defect
5.  Genuine expected-behavior mismatch

The classification must be evidence-based. If a test or fixture is defective, fix it rather than weakening the requirement. Do not start an open-ended loop.

---

# 11. Accounting and Data-Integrity Requirements

For Finance work, Claude must explicitly verify, where applicable:

- balanced journal entries
- posting semantics
- document lifecycle rules
- reversal behavior
- period validity
- business dates
- allocation semantics
- aggregate reconciliation
- as-of reporting
- tenant/legal-entity isolation
- RLS behavior
- RBAC
- duplicate prevention
- concurrency behavior
- migration safety
- rollback/reversibility where required

Application-level assertions are not sufficient for critical accounting
invariants.

Where requested by the contract, provide independent raw-SQL/database
proofs.

---

# 12. Database and Concurrency Rules

For database-sensitive work:

- test against PostgreSQL, not only mocks
- use controlled/reset test data
- isolate AP/AR or other aggregate fixtures where necessary
- avoid stale hardcoded dates
- use controlled dates for date-sensitive tests
- verify migration behavior from the relevant baseline
- test concurrent operations where concurrency is part of the contract
- verify uniqueness and locking behavior at the database level

A concurrency test must prove the intended invariant, not merely execute
two requests.

---

# 13. Acceptance Matrix Discipline

The acceptance matrix is the single source of truth for scenario
coverage.

Each scenario should have a stable ID.

Example:

```text
AP-001
AP-002
...
AR-001
AR-002
...
DB-001
RLS-001
CONC-001
REG-001
```

Avoid manually maintaining duplicated scenario numbering in multiple
documents.

For large matrices, use table-driven tests where practical, while
preserving stable scenario IDs.

A passing scenario stays PASS unless new evidence directly contradicts
it.

Do not repeatedly rerun or reinterpret unrelated PASS items because one
new scenario failed.

---

# 14. Regression Gate

Before completion, Claude must run the required regression gates defined
by the contract.

Typical gates may include:

```text
unit tests
E2E tests
PostgreSQL integration tests
raw SQL proofs
typecheck
lint
build
migration tests
security/RLS tests
concurrency tests
```

Only the contract determines which are mandatory for the work item.

The final report must state exact results.

Example:

```text
UNIT       620/620 PASS
E2E        1087/1087 PASS
TYPECHECK  PASS
LINT       PASS
BUILD      PASS
RLS        PASS
MIGRATION  PASS
CONCURRENCY PASS
```

Never invent counts.

---

# 15. Completion Report & Delivery Package

The completion report is generated **last**, after final verification.

Location:

```text
docs/work-items/<WORK_ITEM_ID>/COMPLETION_REPORT.md
```

It must contain:

```text
Work item ID
Baseline SHA
Final SHA
Scope completed
Files changed (including canonical files modified)
Database changes
Migrations
Acceptance matrix results
Accounting verification
RLS/tenant verification
RBAC verification
Concurrency verification
Regression results
Typecheck
Lint
Build
Known non-blocking repository state
Any deviations from contract
Final status
```

The report must be evidence-oriented. Do not write a completion report before final verification and then repeatedly rewrite it during remediation.

### Mandatory Delivery Package

Every implementation pass must produce a complete, verifiable delivery package:

1.  **Work-item identifier:** Canonical ID matching the contract.
2.  **Approved baseline SHA:** Commit SHA from which the work branch originated.
3.  **Approved final SHA:** Exact Git commit SHA containing the verified implementation.
4.  **Completion report:** `COMPLETION_REPORT.md` fully completed with evidence.
5.  **Acceptance evidence:** Full matrix showing all scenarios as `PASS`.
6.  **Regression evidence:** Documented execution and pass counts for all required regression suites.
7.  **Implementation delivery/handoff report:** Concise summary returned in the prompt.
8.  **Git bundle:** Bundle created from the final commit containing history from baseline.
9.  **Bundle verification evidence:** Documented output of `git bundle verify` and `git bundle list-heads`.
10. **Fresh-fetch verification:** Independent verification confirming the bundle unpacks cleanly into a separate test repository and resolves to the exact final SHA.
11. **Working-tree status:** Verification that the working tree is clean.
12. **Delivery target:** Explicit destination (default: `origin/main`).

---

# 16. Git Commit and Bundle Protocol (Hard Gate)

The Git bundle is a **mandatory hard quality gate**, not an optional artifact.

### Creation and Verification Steps

After all verification passes:

1.  Create the final commit.
2.  Record the exact final SHA.
3.  Generate a Git bundle containing the work-item history from the approved baseline:
    ```bash
    git bundle create ~/Downloads/<BUNDLE_NAME>.bundle <BASELINE_SHA>..HEAD <BRANCH_NAME>
    ```
4.  Verify bundle integrity:
    ```bash
    git bundle verify ~/Downloads/<BUNDLE_NAME>.bundle
    git bundle list-heads ~/Downloads/<BUNDLE_NAME>.bundle
    ```
5.  Perform an independent fresh-repository verification:
    - Clone or initialize an isolated temporary repository.
    - Fetch the bundle into the temporary repository:
      ```bash
      git fetch <BUNDLE_PATH> <BRANCH_NAME>:test-verify
      ```
    - Confirm the extracted commit resolves byte-for-byte to the exact intended final SHA.
6.  Ensure bundle accessibility in `~/Downloads/`.

### Stale Bundle Prohibition

If any source, test, configuration, schema, or documentation changes occur after a bundle is generated, the bundle **MUST be regenerated and reverified**. A stale bundle must never be treated as valid evidence for the final state.

### Hard Gate Requirement

If the required Git bundle is missing, stale, inaccessible, or unverifiable:

**CTO quality-gate review must not be considered complete.**

Terminal Claude state:

```text
IMPLEMENTED
→ VERIFIED
→ COMMITTED
→ REPORT_GENERATED
→ BUNDLE_GENERATED
→ BUNDLE_VERIFIED
→ FRESH_FETCH_VERIFIED
→ CTO_QUALITY_GATE
```

Claude does not push.

---

# 17. CTO Quality Gate vs. Delivery Authorization

These are two strictly separated authorities.

### 1. CTO Quality-Gate Approval

CTO Quality-Gate Approval means:

> **The CTO has reviewed the implementation evidence and considers the implementation technically acceptable for delivery.**

Quality-gate approval certifies technical correctness. It does **NOT** authorize pushing to any remote repository or merging branches.

### 2. CTO Delivery Authorization

Delivery requires explicit, literal delivery authorization:

```text
NORYX CTO DELIVERY AUTHORIZATION: APPROVED
```

This authorization permits Antigravity to perform the delivery operation defined by the approved delivery target.

### Strict Non-Inference Rule

Do not allow one authorization to be inferred from the other.

No delivery authorization may be inferred from:

- CTO quality approval;
- a completion report;
- passing tests or regression gates;
- an approved final SHA;
- a verified Git bundle;
- an ambiguous "looks good" or "ready to ship."

---

# 18. Antigravity Delivery Protocol

### Delivery Target

Unless the CTO explicitly specifies another target:

**The default delivery target is `origin/main`.**

Normal delivery delivers the approved final state directly to the approved target. Do not introduce an implicit additional merge, rebase, or cherry-pick stage after the approved delivery process.

If a separate merge or reconciliation operation is required, it must be explicitly authorized rather than silently assumed.

### Delivery Input

Antigravity receives:

```text
Work item
Approved baseline SHA
Approved final SHA
Delivery target (default: origin/main)
```

### Pre-Push Verification

Antigravity must:

1.  Verify local repository state and branch.
2.  Verify working tree is clean.
3.  Verify the approved SHA exists.
4.  Verify the approved baseline is an ancestor.
5.  Confirm remote target aligns with expectations.

### Exact-SHA & Zero Source Modification Rules

Antigravity is a controlled delivery agent, not an engineering agent.

Antigravity must:

- Push exactly the approved SHA to the authorized target.
- Verify remote target equals the approved SHA after push.
- Confirm no source modifications were made.

Antigravity must **NOT**:

- modify production source code;
- alter implementation details;
- silently fix tests or fixtures;
- rebase;
- squash;
- cherry-pick;
- change the approved final SHA;
- introduce undocumented changes.

If delivery cannot be performed exactly as authorized without modifying source:

```text
STOP → HOLD → report discrepancy to CTO
```

Antigravity does not repair the repository to force delivery.

---

# 19. Delivery Report

Required format:

```text
NORYX CTO DELIVERY

Work item:
Approved SHA:
Remote main:
Baseline:
Push:
Remote verification:
Source changes during delivery:
Rebase/squash/cherry-pick:
Working tree:
Final status:
```

The CTO compares:

```text
Approved SHA == Remote main
```

If false, delivery is not accepted.

---

# 20. Token-Efficiency Rules

Claude should spend tokens on engineering evidence, not conversation.

### Do

- reference repository paths instead of pasting files
- reference commit SHAs instead of narrating Git history
- use the approved contract as context
- use stable acceptance IDs
- report only changed/failed/unexecuted areas
- reuse existing repository patterns
- batch independent verification where safe
- produce the final report only once
- stop when the terminal state is reached

### Do not

- repeat the full proposal
- repeatedly rediscover repository architecture
- repeatedly review PASS gates
- narrate every command
- paste large files
- recreate already-known acceptance criteria
- rewrite the completion report after every small test
- start new discovery after implementation unless explicitly required
- perform open-ended self-review

The preferred communication model is:

```text
EVIDENCE → DECISION → ACTION → RESULT
```

not:

```text
DISCUSSION → DISCUSSION → DISCUSSION → DISCUSSION
```

---

# 21. Context Budget

Claude should maintain three levels of information:

### Permanent

Repository protocol and established architecture.

### Work-item permanent

Approved contract and acceptance matrix.

### Session temporary

Current commands, failures, fixes, and verification output.

Temporary information should not be repeatedly promoted into long
conversational prompts.

When a work item closes, its contract and completion report become the
durable historical record.

---

# 22. Definition of Done

A work item is DONE only when:

```text
[ ] Approved contract exists
[ ] CTO proposal approval recorded (CTO_APPROVED)
[ ] Explicit CTO implementation authorization recorded (IMPLEMENTATION_AUTHORIZED)
[ ] Two-pass discovery maximum respected (Pass 1 or Pass 2)
[ ] Scope respected (including authorized canonical file modifications)
[ ] Two-pass implementation maximum respected (Pass 1 or Pass 2)
[ ] Implementation complete (IMPLEMENTING)
[ ] Required migrations verified
[ ] Accounting invariants verified where applicable
[ ] Tenant/RLS verified where applicable
[ ] RBAC verified where applicable
[ ] Concurrency verified where applicable
[ ] Required scenario matrix PASS (VERIFIED)
[ ] Required regression PASS
[ ] Typecheck PASS where required
[ ] Lint PASS where required
[ ] Build PASS where required
[ ] Final commit created (COMMITTED)
[ ] Completion report generated LAST (REPORT_GENERATED)
[ ] Git bundle generated from final commit
[ ] Bundle verified (verify + list-heads) (BUNDLE_VERIFIED)
[ ] Independent bundle fetch into fresh repository verified
[ ] Delivery package complete and accessible
[ ] CTO Quality-Gate Approval recorded (CTO_QUALITY_GATE)
[ ] Explicit CTO Delivery Authorization recorded (DELIVERY_AUTHORIZED)
[ ] Antigravity delivered exact approved SHA to target (default: origin/main) without source modifications (DELIVERED / PUSHED)
[ ] Remote SHA verified (CTO_DELIVERY_VERIFIED)
[ ] Work item CLOSED
```

No `NOT EXECUTED` mandatory gate may remain.

---

# 23. Standard Discovery Prompt

Use this compact prompt:

```text
NORYX DISCOVERY — <WORK_ITEM_ID> (Pass 1 or 2 of 2)

You are in DISCOVERY only. Do not implement.

Read the repository and determine the current architecture relevant to this work item.
You have autonomy within approved scope to inspect dependencies, adjacent modules, canonical services, database constraints, mutation paths, and runtime behavior to resolve technical questions.

Create:
1. docs/work-items/<WORK_ITEM_ID>/DISCOVERY.md
2. docs/work-items/<WORK_ITEM_ID>/CONTRACT.md
3. docs/work-items/<WORK_ITEM_ID>/ACCEPTANCE.md

Inspect existing patterns before proposing new ones.
If modifying existing canonical files is architecturally necessary, specify and justify those changes.

The contract must define:
- baseline SHA
- scope (including justified canonical file changes)
- out of scope
- architecture
- required behavior
- DB/accounting invariants
- tenant/RLS
- RBAC
- concurrency
- migrations
- required tests/raw-SQL proofs
- regression gates
- forbidden changes
- Definition of Done

Check runtime prerequisites needed for verification.

Do not modify production code.
Do not implement.
Do not push.

Return only:
WORK ITEM
PASS: [Pass 1 | Pass 2 of 2]
BASELINE SHA
FILES/PATTERNS INSPECTED
PROPOSED CONTRACT & CANONICAL FILE MODIFICATIONS
ACCEPTANCE MATRIX
RUNTIME READINESS
BLOCKERS
STATUS: PROPOSED
```

---

# 24. Standard Implementation Prompt

Use this after CTO approval:

```text
NORYX IMPLEMENTATION — <WORK_ITEM_ID> (Pass 1 or 2 of 2)

CTO has approved the work-item contract.

Read:
- docs/work-items/<WORK_ITEM_ID>/CONTRACT.md
- docs/work-items/<WORK_ITEM_ID>/ACCEPTANCE.md

Do not redesign the approved architecture.

1. Fresh preflight:
   - git state
   - approved baseline
   - dependencies
   - PostgreSQL/test DB
   - migrations
   - required test/runtime tooling

2. Implement only the approved scope (including authorized canonical file changes).

3. Run the acceptance matrix and required regression gates.

4. Classify failures by production defect, test defect, fixture defect, environment defect, or requirement mismatch.

5. Perform bounded remediation for genuine defects within scope (maximum 2 implementation passes) and rerun affected gates plus required final regression.

6. Do not reopen PASS gates without contradictory evidence.

7. When all mandatory gates pass:
   - create final commit
   - generate docs/work-items/<WORK_ITEM_ID>/COMPLETION_REPORT.md
   - generate a Git bundle in ~/Downloads/
   - run git bundle verify
   - run git bundle list-heads
   - independently fetch the bundle into a fresh repository and verify it resolves to final SHA

8. Do not push.

Stop at:
IMPLEMENTED → VERIFIED → COMMITTED → REPORT → BUNDLE VERIFIED → FRESH FETCH VERIFIED → CTO_QUALITY_GATE.

Return a concise delivery package summary with:
WORK ITEM
PASS: [Pass 1 | Pass 2 of 2]
FINAL SHA
ACCEPTANCE RESULT
REGRESSION RESULT
TYPECHECK/LINT/BUILD
BUNDLE PATH & ACCESSIBILITY
BUNDLE VERIFICATION & FRESH FETCH PROOF
WORKING TREE
STATUS: READY FOR CTO QUALITY-GATE REVIEW
```

---

# 25. Standard Targeted Remediation Prompt

Use only when CTO identifies a specific failure:

```text
NORYX TARGETED REMEDIATION — <WORK_ITEM_ID> (Pass 2 of 2)

CTO HOLD / QUALITY-GATE FINDING:

Gate:
<E.G. CONC-004>

Evidence:
<exact failure/evidence>

Investigate only this gate and directly affected dependencies.

Do not reopen unrelated PASS gates.
Do not expand scope.
Do not redesign the architecture unless the approved contract is demonstrably contradictory; if so, STOP and report the contradiction.

Fix the genuine defect within approved scope.
Rerun the affected gate and required regression.
Regenerate the final completion report and regenerate/reverify the Git bundle.
Verify bundle in an independent fresh repository.

Do not push.

Return only:
ROOT CAUSE
FILES CHANGED
TESTS RUN
RESULT
FINAL SHA
BUNDLE VERIFICATION & FRESH FETCH PROOF
STATUS: READY FOR CTO QUALITY-GATE REVIEW
```

---

# 26. Standard CTO Delivery Authorization Prompt to Antigravity

```text
NORYX CTO DELIVERY AUTHORIZATION: APPROVED

Work item: <WORK_ITEM_ID>

CTO has approved delivery of exactly this commit:

Approved SHA:
<FINAL_SHA>

Baseline:
<BASELINE_SHA>

Delivery target:
<TARGET> (default: origin/main)

Push exactly the approved SHA to the delivery target.

Before push:
- verify SHA exists
- verify baseline ancestry
- verify working tree is clean
- verify no unintended source changes

After push:
- verify remote target equals approved SHA
- verify no source changes occurred during delivery
- report working-tree state

Do not modify, rebase, squash, cherry-pick, repair, or redesign anything.

If source modification is required, STOP and report HOLD.

Return the concise NORYX CTO DELIVERY report.
```

---

# 27. Final Operating Principle

NoryX engineering should optimize for:

```text
ONE DISCOVERY (Max 2 passes)
        ↓
ONE CTO APPROVAL
        ↓
ONE IMPLEMENTATION + BOUNDED VERIFICATION (Max 2 passes)
        ↓
ONE CTO QUALITY GATE
        ↓
ONE CTO DELIVERY AUTHORIZATION
        ↓
ONE ANTIGRAVITY DELIVERY (Default: origin/main)
```

The protocol deliberately moves knowledge from the conversation into
durable repository artifacts.

**The repository contract is the memory.\
The acceptance matrix is the quality gate.\
The completion report is the evidence.\
The verified bundle is the review handoff.\
The CTO is the approval and delivery authority.\
Antigravity is the zero-modification delivery mechanism.**
