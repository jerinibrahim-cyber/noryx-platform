# NoryX Claude Engineering Protocol

**Status:** CTO-approved working protocol\
**Owner:** NoryX CTO / Product Owner\
**Applies to:** Claude implementation and verification sessions for
NoryX repositories\
**Delivery agent:** Antigravity\
**Last updated:** 2026-09-17

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
- final quality approval
- authorization to push

The CTO does **not** ask Claude to repeatedly rediscover
already-approved requirements.

## Claude

Claude owns:

- repository discovery
- implementation
- technical verification
- bounded remediation
- test execution
- completion evidence
- final completion report
- verified Git bundle

Claude must not push to the remote repository.

## Antigravity

Antigravity owns:

- delivery/push only after CTO approval
- remote verification
- exact approved-SHA delivery
- delivery report

Antigravity must not redesign, modify, or silently repair source code
during delivery.

---

# 3. Mandatory Work-Item State Machine

Every work item has one authoritative state.

```text
DISCOVERY
   ↓
PROPOSED
   ↓
CTO_APPROVED
   ↓
IMPLEMENTING
   ↓
VERIFIED
   ↓
COMMITTED
   ↓
REPORT_GENERATED
   ↓
BUNDLE_VERIFIED
   ↓
CTO_VERIFIED
   ↓
PUSHED
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
5.  Discovery and implementation are separate phases.
6.  CTO approval is mandatory before implementation.
7.  Push requires explicit CTO approval of the final SHA.
8.  No implementation is allowed while the work item is only `PROPOSED`.

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

Claude's discovery session must:

1.  Read the current repository state.
2.  Read the approved/current architecture patterns relevant to the work
    item.
3.  Inspect existing implementations before proposing new patterns.
4.  Identify database, accounting, tenant/RLS, RBAC, concurrency,
    migration, and regression implications.
5.  Check runtime prerequisites before proposing test-dependent
    implementation.
6.  Produce the work-item contract.
7.  Produce the acceptance matrix.
8.  Identify blockers or contradictions.
9.  STOP.

Discovery must not implement production code.

### Discovery output

Keep the response concise and evidence-based:

```text
WORK ITEM
BASELINE
FILES/PATTERNS INSPECTED
PROPOSED ARCHITECTURE
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

# 7. CTO Approval Gate

The CTO reviews the contract and acceptance matrix.

Approval means:

```text
CTO_APPROVED
```

The implementation prompt must reference the approved contract rather
than replaying the entire discussion.

If changes are required, update the contract first, then obtain approval
again.

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

### Forbidden during implementation

Unless explicitly approved:

- new posting engines
- replacement accounting architecture
- unrelated schema redesign
- unrelated UI/product changes
- broad refactoring
- new document states
- new GL accounts
- changing unrelated business rules
- pushing to origin

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

Claude owns one bounded implementation/verification cycle.

The cycle is:

```text
IMPLEMENT
→ RUN REQUIRED TESTS
→ CLASSIFY FAILURES
→ FIX GENUINE DEFECTS
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

The classification must be evidence-based.

If a test or fixture is defective, fix it rather than weakening the
requirement.

Do not start an endless "repair the repair" conversation.

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

# 15. Completion Report

The completion report is generated **last**, after final verification.

Location:

```text
docs/work-items/<WORK_ITEM_ID>/COMPLETION_REPORT.md
```

It must contain:

```text
Work item
Baseline SHA
Final SHA
Scope completed
Files changed
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

The report must be evidence-oriented.

Do not write a completion report before final verification and then
repeatedly rewrite it during remediation.

---

# 16. Git Commit and Bundle Protocol

After verification:

1.  Create the final commit.
2.  Record the exact final SHA.
3.  Generate a Git bundle containing the work-item history from the
    approved baseline.
4.  Verify the bundle.
5.  Independently fetch the bundle into a fresh repository.
6.  Confirm the expected commit/history is present.
7.  Place the bundle in:

```text
~/Downloads/
```

Required checks:

```text
git bundle verify <bundle>
git bundle list-heads <bundle>
```

Then perform an independent fetch into a fresh repository.

The bundle is a **review handoff artifact**, not a deployment artifact.

Terminal Claude state:

```text
IMPLEMENTED
→ VERIFIED
→ COMMITTED
→ REPORT_GENERATED
→ BUNDLE_GENERATED
→ BUNDLE_VERIFIED
→ CTO_REVIEW
```

Claude does not push.

---

# 17. CTO Review

The CTO reviews:

- completion report
- final SHA
- bundle
- acceptance matrix
- evidence for critical gates

The CTO may:

```text
APPROVE
```

or

```text
HOLD
```

A HOLD should identify the affected gate.

Do not ask Claude to "review everything again" unless new evidence
justifies reopening a specific area.

Preferred remediation instruction:

```text
Gate X is HOLD because [specific evidence].
Investigate only this gate and its directly affected dependencies.
Do not reopen PASS gates.
Fix if required.
Rerun the affected verification and required regression.
Regenerate the final report and bundle.
Stop.
```

---

# 18. Antigravity Delivery Protocol

Antigravity receives:

```text
Work item
Approved final SHA
Approved baseline
```

Antigravity must:

1.  Verify local repository state.
2.  Verify the approved SHA exists.
3.  Verify the approved SHA is based on the approved baseline.
4.  Push exactly the approved SHA.
5.  Verify remote `main`.
6.  Confirm no source modifications were made.
7.  Return a concise delivery report.

Antigravity must not:

- modify source code
- rebase
- squash
- cherry-pick
- repair tests
- alter commits
- redesign
- push an unapproved SHA

If delivery requires source changes:

```text
STOP
→ return to CTO/Claude
```

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
[ ] CTO approval recorded
[ ] Scope respected
[ ] Implementation complete
[ ] Required migrations verified
[ ] Accounting invariants verified where applicable
[ ] Tenant/RLS verified where applicable
[ ] RBAC verified where applicable
[ ] Concurrency verified where applicable
[ ] Required scenario matrix PASS
[ ] Required regression PASS
[ ] Typecheck PASS where required
[ ] Lint PASS where required
[ ] Build PASS where required
[ ] Final commit created
[ ] Completion report generated LAST
[ ] Git bundle generated
[ ] Bundle verified
[ ] Independent bundle fetch verified
[ ] CTO review APPROVED
[ ] Antigravity pushed exact approved SHA
[ ] Remote SHA verified
[ ] Work item CLOSED
```

No `NOT EXECUTED` mandatory gate may remain.

---

# 23. Standard Discovery Prompt

Use this compact prompt:

```text
NORYX DISCOVERY — <WORK_ITEM_ID>

You are in DISCOVERY only. Do not implement.

Read the repository and determine the current architecture relevant to this work item.

Create:
1. docs/work-items/<WORK_ITEM_ID>/CONTRACT.md
2. docs/work-items/<WORK_ITEM_ID>/ACCEPTANCE.md

Inspect existing patterns before proposing new ones.

The contract must define:
- baseline SHA
- scope
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
BASELINE
FILES/PATTERNS INSPECTED
PROPOSED CONTRACT
ACCEPTANCE MATRIX
RUNTIME READINESS
BLOCKERS
STATUS: PROPOSED
```

---

# 24. Standard Implementation Prompt

Use this after CTO approval:

```text
NORYX IMPLEMENTATION — <WORK_ITEM_ID>

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

2. Implement only the approved scope.

3. Run the acceptance matrix and required regression gates.

4. Classify failures by production defect, test defect, fixture defect, environment defect, or requirement mismatch.

5. Perform bounded remediation for genuine defects and rerun affected gates plus required final regression.

6. Do not reopen PASS gates without contradictory evidence.

7. When all mandatory gates pass:
   - create final commit
   - generate docs/work-items/<WORK_ITEM_ID>/COMPLETION_REPORT.md
   - generate a Git bundle in ~/Downloads/
   - run git bundle verify
   - run git bundle list-heads
   - independently fetch the bundle into a fresh repository and verify it

8. Do not push.

Stop at:
IMPLEMENTED → VERIFIED → COMMITTED → REPORT → BUNDLE VERIFIED.

Return a concise evidence summary with:
FINAL SHA
ACCEPTANCE RESULT
REGRESSION RESULT
TYPECHECK/LINT/BUILD
BUNDLE PATH
BUNDLE VERIFICATION
WORKING TREE
STATUS
```

---

# 25. Standard Targeted Remediation Prompt

Use only when CTO identifies a specific failure:

```text
NORYX TARGETED REMEDIATION — <WORK_ITEM_ID>

CTO HOLD:

Gate:
<E.G. CONC-004>

Evidence:
<exact failure/evidence>

Investigate only this gate and directly affected dependencies.

Do not reopen unrelated PASS gates.
Do not expand scope.
Do not redesign the architecture unless the approved contract is demonstrably contradictory; if so, STOP and report the contradiction.

Fix the genuine defect if one exists.
Rerun the affected gate and required regression.
Regenerate the final completion report and verified Git bundle.

Do not push.

Return only:
ROOT CAUSE
FILES CHANGED
TESTS RUN
RESULT
FINAL SHA
BUNDLE VERIFICATION
STATUS
```

---

# 26. Standard CTO Approval Prompt to Antigravity

```text
NORYX DELIVERY APPROVAL

Work item: <WORK_ITEM_ID>

CTO has approved delivery of exactly this commit:

Approved SHA:
<FINAL_SHA>

Baseline:
<BASELINE_SHA>

Push exactly the approved SHA.

Before push:
- verify SHA exists
- verify baseline ancestry
- verify no unintended source changes

After push:
- verify remote main equals approved SHA
- verify no source changes occurred during delivery
- report working-tree state

Do not modify, rebase, squash, cherry-pick, repair, or redesign anything.

If source modification is required, STOP and report it.

Return the concise NORYX CTO DELIVERY report.
```

---

# 27. Final Operating Principle

NoryX engineering should optimize for:

```text
ONE DISCOVERY
        ↓
ONE CTO APPROVAL
        ↓
ONE IMPLEMENTATION + BOUNDED VERIFICATION
        ↓
ONE CTO REVIEW
        ↓
ONE DELIVERY
```

The protocol deliberately moves knowledge from the conversation into
durable repository artifacts.

**The repository contract is the memory.\
The acceptance matrix is the quality gate.\
The completion report is the evidence.\
The bundle is the review handoff.\
The CTO is the approval authority.\
Antigravity is the delivery mechanism.**
