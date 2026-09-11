# Tax/VAT Phase 2 — AP Tax Calculation — Completion Report

**Date:** 2026-09-11
**Work item:** Tax/VAT MVP Phase 2 — AP Tax Calculation
**Discovery contract:** `docs/finance-work-item-tax-vat-phase-2-discovery.md`
**Authorization:** Direct CTO/NOAH implementation authorization with the Phase 2 architecture decision confirmed (debit notes resolve tax independently per line; no inheritance from allocated bills), superseding the discovery document's prior BLOCKED status.

## Status

**LOCAL COMMIT COMPLETE — PUSH NOT VERIFIED.**

Implementation, tests, and documentation updates are complete and committed to local `main`. The push to `origin/main` was attempted and rejected by this session's git proxy for authorization reasons (detail below) — it is **not** confirmed on GitHub. Per the governing instruction for this work item, completion is **not** being claimed until the push is verified.

## Commit

|                   |                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **SHA**           | `ae4b073286ee82aa0cc508a01701a0fc9917c084`                                                                                           |
| **Branch**        | `main` (local)                                                                                                                       |
| **Parent**        | `e5846cca0933a0cb0b7de33e87fcd357514d7975` (verified baseline — see below)                                                           |
| **Message**       | `Tax/VAT Phase 2 — AP Tax Calculation` (full body includes implementation summary, architecture decisions, and verification results) |
| **Files changed** | 21 files, +7389 / −44                                                                                                                |

## GitHub push verification

**Not verified — push failed.**

```
$ git push origin main
remote: access denied by the git proxy: jerinibrahim-cyber/noryx-platform is not in
this session's authorized repository set, so the proxy will not inject a credential
for it. To fix, add the repository to the session's sources.
fatal: unable to access 'https://github.com/jerinibrahim-cyber/noryx-platform.git/':
The requested URL returned error: 403
```

This is a session-level authorization denial from the environment's egress/git proxy (`jerinibrahim-cyber/noryx-platform` is not in this session's authorized repository set), not a transient network failure, a credential typo, or a repository-side rejection. A parallel `gh api repos/jerinibrahim-cyber/noryx-platform` call returned the same class of denial ("GitHub access to this repository is not enabled for this session. Use add_repo to request access."), confirming it is the session's authorization scope, not a git-specific problem. No tool available in this session (Cowork) exposes an `add_repo`/session-authorization mechanism to resolve this from within the task, and per this environment's own operating guidance, an organization-policy 403 denial must be reported rather than retried or routed around.

**Local `main` is 1 commit ahead of the last known `origin/main`:**

```
$ git rev-parse HEAD
ae4b073286ee82aa0cc508a01701a0fc9917c084
$ git rev-parse origin/main
e5846cca0933a0cb0b7de33e87fcd357514d7975
$ git rev-list --left-right --count origin/main...HEAD
0	1
```

Local `main` and `origin/main` are therefore **not** confirmed equal. The Phase 2 commit exists only in this session's local repository until a push is performed with credentials this session does not have. **The user (or a session with the appropriate repository authorization) needs to push `ae4b073286ee82aa0cc508a01701a0fc9917c084` to `origin/main` to complete this work item's delivery.**

## Pre-implementation verification (completed before any code change)

- Confirmed local `main` == `origin/main` == `e5846cca0933a0cb0b7de33e87fcd357514d7975` before starting.
- Confirmed the Phase 2 discovery document (`docs/finance-work-item-tax-vat-phase-2-discovery.md`) matches the current repository.
- Confirmed Phase 1's `tax_codes`/`tax_rates` schema, services, and APIs are present and match the discovery document, via direct `\d tax_rates` / `\d supplier_bill_lines` database inspection (not just code reading).

No architecture conflict was found; implementation proceeded directly per the authorization.

## Implemented behavior

- **Supplier Bill lines and Supplier Debit Note lines** gain an optional line-level `taxCodeId`. On create, or on a full line-array replace via update, the effective `tax_rates` row is resolved by the document's own transaction date (`billDate` for bills, `debitNoteDate` for debit notes — never the posting date), the tax amount is calculated with integer minor-unit rounding, and the resolved rate is snapshotted via an immutable `taxRateId` foreign key (safe because `tax_rates` is create-only/immutable — Phase 1).
- **Override semantics:** `taxAmountMinor` remains the single authoritative posted amount, unchanged in meaning.
  - `taxCodeId` omitted → 100% legacy behavior; no new columns populated (`taxAmountOverridden=false`, all new columns null).
  - `taxCodeId` supplied alone → the calculated amount becomes authoritative (`taxAmountMinor` = calculated value, `taxAmountOverridden=false`).
  - `taxCodeId` + explicit `taxAmountMinor` both supplied → the supplied value stays authoritative; the calculated value is retained separately in `taxAmountCalculatedMinor`; `taxAmountOverridden=true`.
- **Supplier Debit Notes resolve tax entirely independently per line**, using only `debitNoteDate` — never touching `dto.allocations` or any allocated bill's data. This is the CTO-confirmed correction to the originally-proposed Decision 1: debit notes have header-level many-to-many bill allocations and no line-level linkage to any bill line, so inheriting from an allocated bill is architecturally undefined. Proven end-to-end by a dedicated e2e test where a single debit note allocates across two different bills and its two tax-coded lines resolve to two different tax codes/rates entirely independently of both bills' data.
- **Existing GL posting, totals, RLS, RBAC, and blanket post-immutability are unchanged.** Posting still sums `taxAmountMinor` per line (the single authoritative column); the new columns are additive and carry no posting semantics of their own.

## Architecture decisions applied

1. **Resolution timing:** at line-write time (create, or full-array-replace update), inside the existing `withTenant()` transaction — never at posting time.
2. **Resolution date:** the document's own transaction date (`billDate` / `debitNoteDate`), per Decision 6 of the discovery document.
3. **Snapshot mechanism:** immutable FK (`taxRateId`) to the specific resolved `tax_rates` row, not a denormalized rate value — safe because `tax_rates` rows are never updated or deleted.
4. **Debit-note independence (Decision 1 correction):** no inheritance from allocated bills; each debit note line resolves tax entirely on its own, confirmed by the CTO and implemented exactly as specified.
5. **Legacy preservation:** omitting `taxCodeId` reproduces Phase-1-era behavior exactly, with no new columns populated.
6. **Shared logic, not duplicated:** `calculateTaxAmountMinor()` (new `tax-configuration/tax-calculation.ts`) and `TaxRatesService.resolveEffectiveRate()` are each defined once and consumed via DI from both AP services — a deliberate, documented departure from this codebase's usual "duplicate the trivial query locally" convention, justified because tax resolution/rounding is correctness-critical, evolving business logic owned by its own module.
7. **Defense in depth:** two new CHECK constraints per table (`*_tax_overridden_requires_code`, `*_tax_rate_requires_code`) enforce the override/snapshot invariants at the database level, not just in the service layer.

### Deviation: pre-existing Phase 1 bug found and fixed

While verifying the half-open `[effectiveFrom, effectiveTo)` boundary for `resolveEffectiveRate()`, a genuine pre-existing bug was found in `TaxRatesService.create()`'s overlap pre-check: it used inclusive (`lte`/`gte`) comparisons, which are **stricter** than the actual `EXCLUDE USING gist ... daterange(effective_from, effective_to, '[)')` constraint (truly half-open on `effective_to`). This caused the pre-check to reject a legitimate, non-overlapping pair of adjacent rates with a 409 before the INSERT was even attempted.

This was verified directly at the database level (a manual `BEGIN; INSERT; INSERT; ROLLBACK;` psql transaction) confirming the real EXCLUDE constraint correctly allows the adjacent pair — proving the bug was purely in the application-layer pre-check, never in the authoritative constraint. Fixed by changing the pre-check's comparisons from `lte`/`gte` to strict `lt`/`gt` (matching the constraint it exists to preview), and by adding `gt`/`lt` to `@noryx/db-core`'s re-exported operator list (purely additive). This is judged a narrow, safe, transparently-documented correction — not an architecture conflict requiring a stop — and all 27 pre-existing `tax-configuration.e2e-spec.ts` tests, including the one covering this exact adjacent-range case, continue to pass after the fix.

## Tests and checks

| Check                             | Result                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                        | **583/583 passing**                                                                                                                                                                                                       |
| E2E tests (43 suites)             | **829/829 passing** (~188s)                                                                                                                                                                                               |
| RBAC route-role-matrix assertions | **135/135 unchanged/passing**                                                                                                                                                                                             |
| Typecheck                         | Clean (`packages/db-core`, `services/sphere-finance`)                                                                                                                                                                     |
| Lint                              | Clean, 0 errors (`packages/db-core`, `services/sphere-finance`)                                                                                                                                                           |
| DB constraint verification        | Direct `\d` inspection confirms existing RLS `tenant_isolation` policy and existing blanket (zero-exception) immutability triggers on both `*_lines` tables automatically cover the new columns — no SQL changes required |

New tests added in this work item:

- `tax-calculation.spec.ts` — 8 unit tests for `calculateTaxAmountMinor()` (exact rate, 0bp, 0 amount, round down, round half-up at boundary, round up, 100% pass-through, large amounts).
- DTO spec additions — 6 tests (3 each for supplier-bill-line and supplier-debit-note-line `taxCodeId` validation).
- `supplier-bills.e2e-spec.ts` — 10 new tests: legacy behavior preserved, calculation with/without override, inactive/no-rate/cross-legal-entity `taxCodeId` rejection, independent multi-line resolution, half-open boundary + historical snapshot survival, posting unaffected with mixed calculated/overridden lines, and DB-level CHECK constraint enforcement against raw-SQL inserts.
- `supplier-debit-notes.e2e-spec.ts` — 9 new tests, mirroring the above plus the dedicated cross-bill independence test described above.

## Roadmap / project-state updates

- **`docs/roadmap.md`:** "Current execution status" section rewritten to reflect Phase 2 as implemented and (pending push) intended for `main`; Phase 1/Phase 2 status paragraphs added; "Next approved work item" changed to Tax/VAT Phase 3 (AR Tax Calculation, not yet discovered/authorized); the Finance-First Product Build Strategy tree's Tax/VAT status line and the detailed Tax/VAT phase checklist both updated to mark Phase 2 complete and Phase 3 next.
- **`docs/project/PROJECT_STATE.md`:** "Repository implementation state" section rewritten to describe the CTO's Phase 2 authorization, the implemented/verified Phase 2 scope, the Decision 1 correction, and the Phase 1 pre-check bug fix; points to this report for the commit SHA and push status; "next Finance work item" updated to Phase 3, explicitly marked not yet discovered/authorized.

Both documents currently describe Phase 2 as implemented, verified, and intended for `main` — **the push itself remains unverified**, and this report is the authoritative record of that until the commit is actually pushed and confirmed on GitHub.

## Files changed (this commit)

```
docs/finance-work-item-tax-vat-phase-2-discovery.md            (already existed; unchanged by this session — listed for completeness)
docs/project/PROJECT_STATE.md
docs/roadmap.md
packages/db-core/src/index.ts
services/sphere-finance/drizzle/migrations/0018_tax_vat_phase_2_ap_calculation.sql
services/sphere-finance/drizzle/migrations/meta/0018_snapshot.json
services/sphere-finance/drizzle/migrations/meta/_journal.json
services/sphere-finance/src/accounts-payable/supplier-bills/dto/create-supplier-bill-line.dto.spec.ts
services/sphere-finance/src/accounts-payable/supplier-bills/dto/create-supplier-bill-line.dto.ts
services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.module.ts
services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.service.ts
services/sphere-finance/src/accounts-payable/supplier-debit-notes/dto/create-supplier-debit-note-line.dto.spec.ts
services/sphere-finance/src/accounts-payable/supplier-debit-notes/dto/create-supplier-debit-note-line.dto.ts
services/sphere-finance/src/accounts-payable/supplier-debit-notes/supplier-debit-notes.module.ts
services/sphere-finance/src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts
services/sphere-finance/src/db/schema.ts
services/sphere-finance/src/tax-configuration/tax-calculation.spec.ts
services/sphere-finance/src/tax-configuration/tax-calculation.ts
services/sphere-finance/src/tax-configuration/tax-rates.service.ts
services/sphere-finance/test/supplier-bills.e2e-spec.ts
services/sphere-finance/test/supplier-debit-notes.e2e-spec.ts
```

(`docs/finance-work-item-tax-vat-phase-2-discovery.md` was untracked in the working tree at the start of this session — the approved discovery document itself — and is included in this commit alongside the implementation it authorizes; it was not modified in this session, only added to version control.)

`docs/hardening/` remains a pre-existing, unrelated untracked directory and was deliberately excluded from staging and this commit — it is outside Phase 2 scope.

## Deviations and remaining issues

1. **Push not verified (primary open item).** See "GitHub push verification" above. `ae4b073286ee82aa0cc508a01701a0fc9917c084` needs to be pushed to `origin/main` by a session/credential with repository authorization, and the SHA then verified on GitHub, for this work item to be considered fully delivered.
2. **Phase 1 pre-check bug fix.** A narrow, transparently-documented correction to `TaxRatesService.create()`'s overlap pre-check (inclusive → strict comparisons), made because it was blocking correct Phase 2 test coverage of the half-open date boundary and was verified at the DB level to be a pure application-layer false positive, not a change to the actual constraint. Flagged here per the instruction to report all deviations, though it was judged not to rise to the level of a stop-worthy architecture conflict.
3. **No route/RBAC/RLS/schema-breaking changes were required or made.** Phase 2 adds only nullable columns and CHECK constraints to already-protected tables; this was confirmed, not assumed — via the unchanged 135/135 RBAC-matrix assertions and direct database inspection.
