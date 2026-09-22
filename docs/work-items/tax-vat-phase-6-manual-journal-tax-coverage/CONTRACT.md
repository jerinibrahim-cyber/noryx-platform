# Contract: TAX-VAT-PHASE-6-MANUAL-JOURNAL-TAX-COVERAGE

**Status:** IMPLEMENTED — pending CTO_REVIEW (implementation-stage artifact; converts the CTO-approved discovery proposal into the formal work-item package required by "NORYX CTO — FINAL ONE-PASS IMPLEMENTATION AUTHORIZATION").

Per `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md`, `docs/engineering/NORYX_CTO_COPILOT_PROTOCOL.md`, `docs/engineering/NORYX_ANTIGRAVITY_DELIVERY_PROTOCOL.md`.

Labelling discipline used throughout (per the CTO's implementation authorization §4): **OBSERVED** = directly confirmed by reading repository code/output this session; **INFERRED** = a reasoned conclusion from observed facts, not itself directly read; **PROPOSED** = this session's own design choice, not dictated by the CTO authorization; **CTO DECISION** = explicitly settled by the CTO's implementation authorization text; **IMPLEMENTED** = code exists in the working tree, confirmed by direct read; **VERIFIED** = proven by an actual, executed test run against real PostgreSQL this session (never inferred from code inspection alone).

## 0. Governance note — MDCRAFT / Metrics Protocol (OBSERVED gap, resolved per the authorization's own fallback clauses)

**OBSERVED:** a repository-wide search (`grep -ril "mdcraft\|metrics" docs/`, full `docs/` tree listing) found no document named "MDCRAFT protocol" or "Metrics Protocol" anywhere in this repository, and the immediately preceding Finance work item (`docs/work-items/budgeting-phase-1-foundation/`, delivered under this same CTO authorization framework one work item ago) produced no such documents either — its `COMPLETION_REPORT.md` has no Metrics section and follows a plain Authorization/Files-Changed/Schema/API/Security/Concurrency/Tests/Acceptance/Regression/Self-Review/Final-Git-Status/Confirmations/Artifacts/Governance-State structure.

**Resolution (per authorization §6/§7's own fallback text, not invented):** §6 requires applying "the repository's current MDCRAFT protocol" — with none separately documented, the actual, current repository practice for this exact deliverable type is `docs/work-items/<slug>/{CONTRACT,ACCEPTANCE,COMPLETION_REPORT}.md`, evidenced empirically by the Budgeting Phase 1 precedent; this document follows that same structure rather than inventing a new one. §7 explicitly provides: "If an existing metric is not applicable, explicitly record N/A with reason" — since no Metrics Protocol or established completion-report Metrics-section convention exists to instantiate, `COMPLETION_REPORT.md` §12 records N/A with this exact reasoning, rather than inventing arbitrary thresholds (which §7 explicitly forbids). This is a process-documentation gap, not a product/accounting/security/scope decision, so it does not trigger the authorization's STOP-for-CTO_REVIEW clause.

## 1. Work Item

**ID:** TAX-VAT-PHASE-6-MANUAL-JOURNAL-TAX-COVERAGE
**Product area:** Sphere Finance → Tax/VAT (roadmap status: Tax/VAT Phases 1–5 COMPLETE; this phase is the roadmap's own stated "fast-follow candidate," `docs/roadmap.md`).
**Discovery source:** `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/PROPOSAL.md` (§0–§18, CTO-reviewed, concluded READY FOR CTO REVIEW).
**Implementation authorization:** "NORYX CTO — FINAL ONE-PASS IMPLEMENTATION AUTHORIZATION — Tax/VAT Phase 6 — Manual Journal Tax Coverage" (this session).

## 2. Baseline and Commit Provenance

**CTO DECISION (authorization §1):** authoritative starting point is `ac16fa0e195f175806240924832c8c1567cc9772`.

**Commit chain:**

- **Approved baseline SHA:** `ac16fa0e195f175806240924832c8c1567cc9772`
- **Implementation commit SHA:** `908b9306f496ed11059aa8f551b741ba30a6fb4a`
- **Documentation/completion commit SHA:** `f48266899bec4e3bdd0550fcfd02a45639b3be3f`
- **Evidence correction commit SHA:** recorded in `COMPLETION_REPORT.md` upon completion of this pass.

**VERIFIED before coding:**

- Local repo `main` at `ac16fa0e195f175806240924832c8c1567cc9772`.
- `origin/main` (via `git ls-remote`) verified at `ac16fa0e195f175806240924832c8c1567cc9772`.
- `main` was not modified directly.

## 3. Implementation Branch

`feat/tax-vat-phase-6-manual-journal-tax-coverage`, created from `ac16fa0e195f175806240924832c8c1567cc9772`. Not pushed. `main` not modified directly. See `COMPLETION_REPORT.md` for explicit commit provenance.

## 4. Current Architecture (OBSERVED, re-confirmed against this exact baseline before coding — full detail already in the discovery proposal §2, not repeated verbatim here)

- **Journal Engine** (`journal_entries`/`journal_lines`, `services/sphere-finance/src/journal-entries/journal-entries.service.ts`, 951 lines pre-change): DRAFT→POSTED lifecycle; header-row-lock-first transactional pattern; full-array line replacement on update; atomic journal numbering; column-agnostic generic immutability trigger (`drizzle/constraints/004_journal_lines_immutability_trigger.sql`) that blocks ANY mutation (`TG_OP` + parent-status check, no column enumeration) once the parent is POSTED — confirmed this session, by reading the trigger function, to require zero changes for new columns.
- **Tax Configuration** (`tax_codes`/`tax_rates`): `treatment` enum STANDARD|ZERO_RATED|EXEMPT; no direction column on `tax_codes` (confirmed by direct schema read — a code may legitimately be used on both AP and AR); `isActive` flag; `TaxCodesService.findByIdInTx(tx, legalEntityId, id)` — legal-entity-scoped lookup, relies on the transaction's RLS session variable for tenant scoping, same as every other in-service lookup in this file.
- **AP/AR tax-line pattern** (`supplier_bill_lines` etc.): `taxCodeId` (nullable FK) + `taxRateId` (immutable snapshot) + `taxAmountCalculatedMinor` + `taxAmountOverridden`, with implication-style CHECK constraints (e.g. `taxRateId IS NULL OR taxCodeId IS NOT NULL`) mirroring service-layer invariants at the DB level — the exact idiom this work item's own CHECK constraints reuse.
- **VAT Position Report** (`tax-reports.service.ts`, 840 lines pre-change): computes `outputByTaxCode`/`inputByTaxCode`/headline totals from the four AP/AR document line tables directly, never from `journal_lines` (which, before this migration, carried no `tax_code_id` at all — confirmed by direct schema read); a separate, coarser `glCrossCheck` section reads aggregate GL account movement by `accountId`, independent of tax-code attribution. A pre-existing, already-passing e2e test (`vat-position-report.e2e-spec.ts`, "reports a nonzero, correctly-signed difference when a manual journal entry posts to the tax-output account outside any AR document...") is the concrete, repository-native evidence of the gap this work item closes.
- **RBAC/RLS/audit:** three roles (`finance.viewer`/`finance.poster`/`finance.admin`); `FORCE ROW LEVEL SECURITY` tenant-scoped policy per table (filters rows, not columns — the reason no RLS file change is needed for new columns on an existing table); legal-entity isolation always an explicit service-layer predicate; every mutation writes an `auditLogs` row with full before/after JSON snapshots in the same transaction (automatically covers new columns, since the snapshot is the whole row object, not an enumerated field list).

## 5. Implementation Feasibility Review (authorization §18, performed before writing any production code)

Performed as a single pass across the authorization's A–T checklist, re-confirming the discovery proposal's architecture against this exact baseline's actual current code (not the proposal's own possibly-stale description of it). No genuinely material new product/accounting/security/architectural decision or contradiction was found — every item below was resolved as an ordinary implementation choice, not escalated.

**One design choice made and recorded here (PROPOSED, not a CTO-decision-level change):** the discovery proposal's §4 described tax-code validation as reusing `TaxCodesService` via dependency injection, following the AP/AR pattern. On inspecting `JournalEntriesService`'s actual current module wiring this session (OBSERVED), it has **zero** constructor-injected dependencies today, and seven other modules (`SupplierBillsModule`, `SupplierDebitNotesModule`, `SupplierPaymentsModule`, `CustomerReceiptsModule`, `CustomerCreditNotesModule`, `CustomerInvoicesModule`, `ScheduledReversalsModule`) each register it as a bare second provider, explicitly relying on that fact (`SupplierBillsModule`'s own doc comment: "Safe for the identical reason: JournalEntriesService has no constructor-injected dependencies of its own"). Introducing a `TaxCodesService` dependency would require touching all seven of those functionally-unrelated modules purely for DI wiring, for a check that — unlike AP/AR's rate resolution/calculation — has no non-trivial logic to justify DI in the first place (CTO authorization §8.2 rules out any calculation here). **Implemented instead:** a local, single-table `findInvalidTaxCodeIds()` helper inside `JournalEntriesService` itself, querying the exact same `tax_codes` table `TaxCodesService.findByIdInTx()` itself queries (not a second tax-code authority — CTO authorization §10) — the same "duplicate the trivial single-table lookup locally" convention this file already uses for `findInvalidAccountIds()`/`resolveCurrency()`/`allocateJournalNumber()`. Smaller footprint, zero new cross-module dependencies, functionally identical validation semantics (exists, active, correct legal entity).

## 6. Frozen Accounting/Product Semantics (CTO DECISION, authorization §8 — reproduced here for traceability, not reopened)

1. Manual tax classification is explicit: `taxCodeId` + `taxDirection` (INPUT|OUTPUT), never inferred from polarity/account/configuration.
2. No tax-base calculation: a tagged line's own `debitMinor`/`creditMinor` amount **is** the tax amount attributed to that code+direction.
3. Both-or-neither pairing (DTO validator + two DB CHECK constraints).
4. Validated at both draft-time (create/update) and post-time (independent re-check inside the posting transaction).
5. Posted classification is immutable — no side door around the existing generic trigger.
6. Reversal carries the same `taxCodeId`/`taxDirection` (not swapped, unlike debit/credit).
7. VAT headline is unified: `outputTaxMinor`/`inputTaxMinor` include manual tax, not a separate headline; source-level attribution remains available.
8. No AP/AR double-counting — only explicitly manually-tagged lines participate in the manual path; existing AP/AR posting paths are untouched.
9. Untagged lines (all existing/legacy rows, and any new line where the caller omits both fields) are excluded from classified VAT totals.
10. Multiple tax lines on one journal are each independently classified, never collapsed.

## 7. Data Model (IMPLEMENTED, VERIFIED)

Migration `0024_tax_vat_phase_6_manual_journal_tax_coverage.sql` (confirmed available — highest pre-existing migration was `0023_budgeting_phase_1_foundation.sql`, generated via `drizzle-kit generate` from the edited `schema.ts`, not hand-authored):

```sql
CREATE TYPE "public"."journal_line_tax_direction" AS ENUM('INPUT', 'OUTPUT');
ALTER TABLE "journal_lines" ADD COLUMN "tax_code_id" uuid;
ALTER TABLE "journal_lines" ADD COLUMN "tax_direction" "journal_line_tax_direction";
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_code_id_tax_codes_id_fk"
  FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id");
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_direction_requires_code"
  CHECK ("tax_direction" IS NULL OR "tax_code_id" IS NOT NULL);
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_code_requires_direction"
  CHECK ("tax_code_id" IS NULL OR "tax_direction" IS NOT NULL);
```

Purely additive: two nullable columns, one new enum type, two implication CHECKs, one FK. No table, no RLS file (existing `tenant_isolation` policy filters rows, not columns), no new constraint/trigger file (the existing generic `prevent_posted_journal_line_mutation()` trigger already covers any column). **VERIFIED:** applied cleanly to (a) a fresh database running all 24 migrations in sequence, and (b) a database seeded with real pre-existing POSTED `journal_entries`/`journal_lines` rows created _before_ 0024 — existing rows survived with `tax_code_id`/`tax_direction` both NULL (no backfill, as designed), and the immutability trigger continued to reject a raw-SQL mutation attempt against a pre-existing POSTED row's new columns.

**Pre-migration data safety vs. post-migration rollback safety (JTX-027):**

- **Pre-migration data safety:** Migration 0024 is additive; existing pre-Phase-6 rows are preserved with `NULL`; no pre-existing tax classification data exists to lose during forward migration.
- **Post-migration rollback safety:** A rollback performed after tax classifications have been populated could destroy the new tax classification columns and data. Therefore, rollback after population is potentially destructive and requires an explicit operational rollback procedure.

See `COMPLETION_REPORT.md` §3/§4/§13.

## 8. API / Service Contract (IMPLEMENTED, VERIFIED — no new routes)

| Route                                              | Change                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /journal-entries`                            | `CreateJournalLineDto` gains optional `taxCodeId`/`taxDirection`; both-or-neither validated by a new `TaxCodeDirectionPairingConstraint` (400 on violation); tax-code existence/active/legal-entity-scope validated (400) alongside the existing account check.                                                                                           |
| `PATCH /journal-entries/:id`                       | Same line-level validation (full-array replacement, unchanged mechanism).                                                                                                                                                                                                                                                                                 |
| `POST /journal-entries/:id/post`                   | Independent post-time re-validation of every line's tax code (422 on a code deactivated after draft creation), inside the same authoritative transaction as the existing account re-validation.                                                                                                                                                           |
| `POST /journal-entries/:id/reverse`                | Reversal lines carry the original's `taxCodeId`/`taxDirection` unchanged (debit/credit still swapped).                                                                                                                                                                                                                                                    |
| `GET /journal-entries`, `GET /journal-entries/:id` | Response rows include the two new columns automatically (`select()` with no column list) — no controller change.                                                                                                                                                                                                                                          |
| `GET /tax-reports/vat-position`                    | `meta.outputTaxMinor`/`meta.inputTaxMinor` now include classified manual-journal tax (CTO DECISION §8.7); two new `meta` fields (`manualOutputTaxMinor`, `manualInputTaxMinor`); one new field per `outputByTaxCode`/`inputByTaxCode` row (`manualTaxMinor`) for source-level attribution. All additive — no existing field renamed, removed, or retyped. |

`netSupplyValueMinor` (existing, non-nullable `number` field on each tax-code row) is **not** widened to `number | null` for manual-only rows — reported as `0` instead, preserving the existing API contract, per the authorization §11's own explicit fallback ("preserve the existing contract and document the limitation rather than expanding scope"). Documented in code (`tax-reports.service.ts`, `mergeManualIntoByCode()`) and here.

## 9. Security / RLS / RBAC (VERIFIED)

- RLS: unchanged (`tenant_isolation` policy on `journal_lines` already filters every row regardless of column). No new RLS file. **VERIFIED** by the full e2e suite (including `rls-hardening.e2e-spec.ts`, which connects as the actual non-superuser `noryx_app` application role) passing unmodified, plus this work item's own tenant/legal-entity-isolation e2e scenarios.
- Legal-entity isolation: `findInvalidTaxCodeIds()` scopes by `legalEntityId`, matching every other in-service lookup's convention. **VERIFIED**: a tax code belonging to a different legal entity of the same tenant is rejected (400).
- RBAC: zero new routes, zero role changes. **VERIFIED**: `route-role-matrix.spec.ts` — 157 routes, 0 unrecognized (unchanged from the pre-existing Budgeting-era count), plus this work item's own RBAC scenarios.
- Audit: unchanged mechanism (full before/after row snapshots) automatically covers the two new columns.
- Posted immutability: **VERIFIED** at the raw-SQL level (not merely re-asserted from reading the trigger) — a direct `UPDATE journal_lines SET tax_code_id = NULL, tax_direction = NULL ...` and a direct `UPDATE ... SET tax_direction = 'INPUT' ...` against a POSTED line both rejected by the pre-existing, unmodified trigger.

## 10. Concurrency (CTO DECISION §14, IMPLEMENTED, addressed)

The one genuinely new interleaving this phase introduces — a tax code being deactivated between a journal's draft creation and its `post()` — is closed the same way the pre-existing account-deactivation-vs-`post()` race is closed: independent re-validation inside `post()`'s own authoritative transaction (after the header row lock, before number allocation), never trusting the draft-time check. **VERIFIED** end-to-end (JTX-009): a tax code deactivated after a draft is created causes `post()` to reject with 422. No new lock, no new lock order, no new isolation-level requirement — reuses the existing header-row-lock-first pattern unchanged.

## 11. Scope Boundary (CTO authorization §25)

**In scope (all implemented):** manual journal tax classification, explicit direction, tax-code association, draft+post-time validation, reversal classification preservation, VAT headline integration, source-level attribution, migration, security, concurrency, tests, documentation, acceptance, completion report, verified bundle.

**Out of scope (none touched):** FX/multi-currency, Fixed Assets, Expense Management, statutory tax filing, multi-jurisdiction tax, reverse-charge expansion, tax-inclusive pricing, new tax engine, unrelated reporting redesign, new approval/DOA architecture, Procurement/Inventory/HRMS. Confirmed by the final diff (`COMPLETION_REPORT.md` §3) touching only: `schema.ts`, one new migration, `create-journal-line.dto.ts` (+ its spec), `journal-entries.service.ts`, `tax-reports.service.ts`, one extended existing e2e file, one new e2e file, and this work item's own `docs/` artifacts.

## 12. Fixed Assets Isolation (CTO authorization §24)

The isolated Fixed Assets implementation (`704b7aa0c34a6cb268fd4362c5739935735b87e6`) was not inspected, referenced, cherry-picked, merged, or made reachable from this work item's branch in any way.

## 13. Acceptance and Test Strategy

See `ACCEPTANCE.md` for the full scenario matrix (JTX-001..JTX-031 plus RBAC/isolation/migration IDs) and `COMPLETION_REPORT.md` §10/§11 for execution evidence.
