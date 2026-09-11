# Tax/VAT Phase 4 — VAT Position Report — Completion Report

**Status:** IMPLEMENTED, VERIFIED, COMMITTED (see §7 for push verification)
**Date:** 2026-09-11
**Authoritative discovery artifact:** `docs/finance-work-item-tax-vat-phase-4-discovery.md`
**Baseline before this work:** `main` @ `263354b` (Tax/VAT Phase 3 completion report), confirmed `local main == origin/main == live GitHub main` at that SHA before implementation began.
**Commit produced by this work:** `ba607b86266f4237e80187ecbceb91bc7f193e81`

## 1. Implementation status

Complete. The VAT Position Report is implemented, fully tested, and committed to local `main` as a single commit on top of the verified `263354b` baseline. No schema change or migration was required — every column the report reads already existed from Tax/VAT Phases 1-3.

## 2. What was built

A new top-level, read-only `TaxReportsModule` (`services/sphere-finance/src/tax-reports/`), registered in `app.module.ts` as a sibling of `GeneralLedgerModule`/`FinancialStatementsModule` — not nested under `TaxConfigurationModule`, `AccountsPayableModule`, or `AccountsReceivableModule` — because the report is inherently cross-subledger, mirroring the exact reasoning `FinancialStatementsModule` itself gives for its own top-level placement (discovery §6.1, §11 decision 1).

**Endpoint:** `GET /v1/finance/tax-reports/vat-position`
**RBAC:** `finance.viewer`, `finance.poster`, `finance.admin` (read-only — same any-finance-role posture as every other Finance report controller; no write-side role split needed).
**Query:** `periodId` (UUID) OR an explicit `dateFrom`/`dateTo` date-range window — mutually exclusive, validated by a locally-defined `PeriodIdExcludesDateRangeConstraint` that mirrors `ProfitAndLossQueryDto`'s existing pattern exactly. Neither supplied → `400 Bad Request`.

### Core calculation (discovery §3.2/§3.3, §6.4)

The report reads directly from the four AP/AR tax-bearing source-line tables established in Phases 2/3 — **never** from `journal_lines`, which has no `tax_code_id` column and so cannot support per-tax-code reporting (confirmed by direct read of the schema and of `CustomerInvoicesService.post()`'s journal-line-construction code, which writes exactly one aggregate tax `journal_lines` row per document, summed across all tax codes on it). This directly corrected the roadmap's prior literal "built on the existing GL read layer" framing.

- **Net output tax** = SUM(`customer_invoice_lines.tax_amount_minor`, POSTED, in-window) − SUM(`customer_credit_note_lines.tax_amount_minor`, POSTED, in-window)
- **Net input tax** = SUM(`supplier_bill_lines.tax_amount_minor`, POSTED, in-window) − SUM(`supplier_debit_note_lines.tax_amount_minor`, POSTED, in-window)
- **Net VAT position** = output − input

Polarity (credit-note/debit-note as reversal of their parent document type) was confirmed by direct read of all four documents' posting code, not assumed.

### Tax-code-level reporting and unclassified handling

Reporting is broken out per tax code where data exists. Legacy/manual lines with `taxCodeId IS NULL` are never dropped: an always-correct headline total (no `tax_code_id` filter) is computed independently, and `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` is that headline total minus the sum of the classified per-code rows — guaranteeing the total can never silently exclude legacy manual-tax lines (discovery §11, resolved per its own recommendation).

### Calculated-vs-overridden visibility

Each code row and the headline surface both `netTaxMinor` (authoritative — what actually posted, honoring any override) and `netCalculatedTaxMinor` (the calculated figure, retained even when overridden), per discovery §11 decision 5.

### GL cross-check (secondary, coarser layer)

A `glCrossCheck` block reports period **MOVEMENT** (not point-in-time balance) on the two singleton tax accounts (`ap_settings.tax_input_account_id`, `ar_settings.tax_output_account_id`) for the same window: `SUM(credit) − SUM(debit)` for the output account (credit-normal — invoices credit it, credit notes debit/reverse it) and `SUM(debit) − SUM(credit)` for the input account (debit-normal — bills debit it, debit notes credit/reverse it). This is a deliberate period-movement variant, not a copy of `ApReportsService.glLiabilityBalance`'s point-in-time-balance style, per the discovery's own caution against conflating the two. It surfaces any mismatch against the source-line total (e.g. from a manually-posted, non-AP/AR journal entry touching the tax accounts directly) rather than silently trusting either figure.

### Reused, not duplicated

`REPORT_TX_CONFIG` (REPEATABLE READ + READ ONLY, exported from `general-ledger.service.ts`) is reused unmodified — the established convention for every multi-statement Finance report. Tax configuration/rate infrastructure (`TaxConfigurationModule`) is not imported at all: the report only reads already-snapshotted tax data off posted lines, it never resolves a rate itself.

## 3. Files changed

**New:**

- `services/sphere-finance/src/tax-reports/dto/vat-position-query.dto.ts`
- `services/sphere-finance/src/tax-reports/dto/vat-position-query.dto.spec.ts` (12 tests)
- `services/sphere-finance/src/tax-reports/tax-reports.service.ts`
- `services/sphere-finance/src/tax-reports/tax-reports.controller.ts`
- `services/sphere-finance/src/tax-reports/tax-reports.module.ts`
- `services/sphere-finance/test/vat-position-report.e2e-spec.ts` (17 tests, 8 describe blocks: RBAC; query validation; no tax activity; classification by treatment; credit/debit-note polarity; legacy/unclassified tax lines; overridden tax lines; date-window boundary; GL cross-check happy-path + manual-journal-entry mismatch; tenant/legal-entity isolation)
- `docs/finance-work-item-tax-vat-phase-4-discovery.md` (the discovery artifact this work implements)
- `docs/finance-work-item-tax-vat-phase-4-completion-report.md` (this report)

**Modified:**

- `services/sphere-finance/src/app.module.ts` — `TaxReportsModule` registered as a top-level sibling of `GeneralLedgerModule`/`FinancialStatementsModule`.
- `services/sphere-finance/src/route-role-matrix.spec.ts` — `TaxReportsController` added (import, `EXPECTED` role entry, `discoverRoutes()` call); 125→126 routes, 24→25 controllers.
- `docs/roadmap.md` — Tax/VAT Phases 1-4 marked COMPLETE for current MVP scope; stale "Financial Reporting — PARTIAL" paragraph corrected (discovery §11 decision 6) with an explicit dated correction note.
- `docs/project/PROJECT_STATE.md` — snapshot/baseline lines updated; new Phase 4 paragraph added to "Repository implementation state"; next-work-item framing genericized (no phase named as authorized-next).

**Deliberately excluded from this commit:** `docs/hardening/` (unrelated, pre-existing untracked NOAH/hardening workstream documents) — not part of this authorization's scope.

## 4. Architecture decisions resolved (discovery §11)

All six CTO decisions flagged in the discovery document were resolved per the user's explicit implementation authorization, using existing architecture/precedent/accounting correctness/minimal-schema-impact, consistent with "do not wait for clarification unless a genuinely irreconcilable architectural conflict is discovered" — none were found:

1. **Module placement** — top-level `TaxReportsModule`, sibling of `GeneralLedgerModule`/`FinancialStatementsModule` (not nested under Tax Configuration or either subledger).
2. **Supply-value breakdown** — included, per discovery recommendation.
3. **Unclassified/legacy tax handling** — rolled into the headline total via an explicit unclassified bucket, never dropped.
4. **GL cross-check scope** — included this phase, as a secondary period-movement check, not the primary source.
5. **Calculated-vs-overridden visibility** — both `netTaxMinor` and `netCalculatedTaxMinor` exposed.
6. **Stale roadmap "Financial Reporting — PARTIAL" paragraph** — corrected in `docs/roadmap.md` with an explicit inline correction note.

## 5. Verification results

Run in this exact order per the "Execution discipline" instruction, against the final committed (post-format) state:

| Check                                      | Result                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Targeted: `vat-position-query.dto.spec.ts` | 12/12 passed                                                                                           |
| Targeted: `route-role-matrix.spec.ts`      | 136/136 passed                                                                                         |
| Typecheck (`tsc --noEmit`)                 | Clean, 0 errors                                                                                        |
| Lint (`eslint`)                            | 0 errors, 8 pre-existing unrelated warnings (all in `_drop`-pattern spec files untouched by this work) |
| Full unit suite (`jest`)                   | **602/602 passed**, 64 suites                                                                          |
| Full e2e suite (`jest -e2e`)               | **865/865 passed**, 44 suites, including the new 17-test `vat-position-report.e2e-spec.ts`             |
| RBAC route-role-matrix                     | **136/136 passed**, now covering 126 routes across 25 controllers                                      |

No regressions in any pre-existing suite.

## 6. Deviations / notable implementation details

- No migration was generated or run — zero schema impact, exactly as the discovery predicted.
- A lint-staged pre-commit hook (`eslint --fix` + `prettier --write`) reformatted several staged files at commit time (whitespace/line-wrapping only, e.g. multi-lining the new `role(...)` array entry in `route-role-matrix.spec.ts`). The full verification suite (typecheck/lint/602 unit/865 e2e) was re-run in full against the actual post-format committed tree and remains 100% green — see §5.
- Two bugs were caught and fixed during implementation, before this commit was made (not present in the committed code): an `async`/`await` mismatch in the e2e test's `vatPosition()` supertest helper (fixed by removing the erroneous `async` wrapper), and two exception-type inconsistencies in `tax-reports.service.ts` (`BadRequestException` → `NotFoundException` in `resolvePeriodInScope`/`resolveCurrency`, matching `FinancialStatementsService`/`ApReportsService` convention).

## 7. Commit, bundle, and push verification

- **Commit SHA:** `ba607b86266f4237e80187ecbceb91bc7f193e81`
- **Parent (verified prior `main`):** `263354be0658e9d9d45a8ecb297fdadecf890db0`
- **Bundle:** `tax-vat-phase-4.bundle`, containing the full commit lineage from `263354b` through `ba607b8`, saved to `~/Downloads` and verified with `git bundle verify`.

Push and independent `local main == origin/main == live GitHub main` verification results are stated in the final chat response accompanying this report, per the user's exact required reporting format — including the `LOCAL COMMIT COMPLETE — PUSH NOT VERIFIED` fallback phrasing if push was technically blocked at delivery time.

## 8. Explicitly out of scope (respected)

- Tax/VAT Phase 5 was not selected, discovered, or implemented.
- The unrelated NOAH orchestrator workstream (`docs/orchestrator/`, `CURRENT_PHASE.md`/`NEXT_TASK.md`/`DECISIONS.md`) was not touched.
- `docs/hardening/` was not included in this commit.
- Statutory VAT filing, reverse charge, multi-jurisdiction tax, and coverage of manually-posted (non-AP/AR) tax journal entries remain explicitly deferred, as stated in the updated `docs/roadmap.md`.
