# Tax/VAT Phase 5 — Per-Tax-Code GL Account Mapping — Completion Report

**Status:** IMPLEMENTED, VERIFIED, COMMITTED (see §11 for push verification)
**Date:** 2026-09-12
**Authoritative discovery/proposal artifacts:** `docs/work-items/tax-vat-phase-5-gl-account-mapping/DISCOVERY.md`, `docs/work-items/tax-vat-phase-5-gl-account-mapping/PROPOSAL.md`
**Baseline before this work:** `main` @ `8ccdec5` (Tax/VAT Phase 4 completion report), confirmed `local main == origin/main` at that SHA before implementation began.
**Commit(s) produced by this work:** see §11

## 1. Implementation status

Complete. All work is implemented exactly as authorized in the CTO's Phase 5 implementation-authorization prompt, including its one mandatory architectural correction (resolve/snapshot the GL account inside `resolveLineTax()`, never inside `post()`) — which was independently identified during the preceding architecture-review turn and is therefore already built into the approved proposal, not a mid-implementation deviation.

## 2. What changed

### 2.1 Data model (§5 of the proposal)

- `tax_codes` gained two independent, nullable, per-direction GL-account override columns: `ap_tax_account_id` (input/AP) and `ar_tax_account_id` (output/AR). Deliberately **not** a join table, effective-dated history, or a separate tax-account configuration table — the CTO's explicit constraint. A single tax code may legitimately be used on both AP and AR documents, so these are two independent columns, not one column plus a direction enum.
- Each of the four tax-bearing line tables — `supplier_bill_lines`, `supplier_debit_note_lines`, `customer_invoice_lines`, `customer_credit_note_lines` — gained one nullable `resolved_tax_account_id` FK column: the GL account this line's tax was **resolved to at draft-resolution time**, before the document is ever posted.

### 2.2 Resolution flow (§6 of the proposal)

- `TaxRatesService.resolveEffectiveRate()` now returns `{ rate: TaxRate; taxCode: TaxCode }` instead of just `TaxRate`. It already fetched the full `tax_codes` row internally for its own `isActive` check and previously discarded everything else about it — exposing it costs **zero additional queries**, directly satisfying the CTO's "do not introduce an unnecessary additional per-line `tax_codes` SELECT" instruction.
- Each of the four posting services' `resolveLineTax()` (the existing method that already snapshots `taxCodeId`/`taxRateId`/`taxAmountCalculatedMinor`/`taxAmountOverridden`, called only from `create()`/`update()` while the document is `DRAFT`) now also resolves and snapshots `resolvedTaxAccountId`: the line's tax code's own `apTaxAccountId`/`arTaxAccountId` override if set, else the direction's AP/AR-settings singleton account, evaluated at that same moment. A new non-throwing settings lookup (`loadApTaxInputAccountFallback`/`loadArTaxOutputAccountFallback`) sources the singleton fallback — draft `create()`/`update()` must succeed even when AP/AR settings aren't configured yet (the resulting snapshot is simply `null`; posting is what enforces the destination invariant). Populated whenever the line's final `taxAmountMinor > 0`, including legacy lines with no `taxCodeId` (which fall back to the singleton only, since there is no code to carry an override). `null` only when the line carries no tax, or when neither an override nor a singleton fallback is configured.
- Credit notes and debit notes resolve `resolvedTaxAccountId` entirely from their **own** tax code/document date — no `allocations` parameter was added to any `resolveLineTax()` signature, preserving the existing no-inheritance architecture verbatim.

### 2.3 Snapshot semantics (§7 of the proposal / discovery §13)

Once a document is `POSTED`, its `resolvedTaxAccountId` snapshot cannot change: the pre-existing per-table database-level immutability triggers (`prevent_posted_<table>_mutation()`, already protecting `taxRateId`/`taxAmountCalculatedMinor`/every other line field) protect this new column for free, because they block any `UPDATE` (or `INSERT`/`DELETE`) on the line table once the parent is `POSTED`, unconditionally, regardless of which column is touched. This was **directly verified at the database level** (§9), not assumed from reading the trigger source: a raw `UPDATE` against a posted line's `resolved_tax_account_id` was attempted and rejected by the existing trigger, with no Phase-5-specific trigger change required or made.

A later change to a tax code's `apTaxAccountId`/`arTaxAccountId` never retroactively changes an already-resolved line's snapshot — proven by e2e test (§8) both for a still-`DRAFT` document (no PATCH with new lines re-triggers resolution) and for a `POSTED` one (immutable regardless).

### 2.4 Posting changes (`post()`, §6 of the proposal)

`post()` in all four services remains **100% read-only with respect to source-document tax lines** — it never writes to `supplier_bill_lines`/`supplier_debit_note_lines`/`customer_invoice_lines`/`customer_credit_note_lines`, exactly as before Phase 5.

- The pre-existing "tax total but no account configured" check (previously `taxTotal > 0 && !settings.taxInputAccountId`) is re-expressed against the per-line `resolvedTaxAccountId` snapshot's nullity: any line with `taxAmountMinor > 0` and a `null` snapshot blocks posting (422) — "every posted tax line must have a deterministic accounting destination."
- `revalidateLineAccountsForPostingOrThrow` (already re-validating every line's own `accountId` is still an active account at posting time) now also re-validates every distinct non-null `resolvedTaxAccountId` — an account can be archived between draft resolution and posting, the identical hazard already guarded for line accounts.
- The single aggregate tax journal line is replaced with **one journal line per DISTINCT `resolvedTaxAccountId`**, summing every line that resolved to that account — never merging different accounts together, never splitting lines sharing one account across multiple journal lines. Verified against the CTO's exact worked example (two lines at 500+300 sharing account A aggregate into one 800 line; a third line on account B stays a separate 900 line).
- Each document type's existing polarity is unchanged: supplier bills debit, supplier debit notes credit (reversed), customer invoices credit, customer credit notes debit (reversed) — the four tax journal lines now vary only in which account(s) they hit, not their debit/credit side.

### 2.5 VAT Position Report changes (`TaxReportsService`, §8 of the proposal)

`VatPositionGlCrossCheck` gained two **strictly additive** fields, `outputTaxAccounts`/`inputTaxAccounts` — an array of `{ accountId, sourceLineTaxMinor, glMovementMinor, differenceMinor, reconciled }`, one entry per distinct GL account any in-window `POSTED` tax line actually resolved to (derived from the lines' own historical `resolved_tax_account_id`, unioned with the singleton account even at zero movement), computed with the same `glMovement()` polarity the pre-existing singleton cross-check already uses. The pre-existing 8 fields (`taxOutputAccountId`, `glOutputTaxMovementMinor`, …) keep their **exact pre-Phase-5 names, types, and meanings** — no existing consumer of this report is broken. A tenant using only the singleton (no code-level overrides) sees exactly one breakdown entry per direction, numerically identical to the pre-existing singleton fields.

### 2.6 RBAC

New route: `PATCH /tax-codes/:id/gl-accounts` (`TaxCodesController.setGlAccounts`), `@Roles("finance.admin")` — the same write-side role as every other `TaxCodesController` mutation (this is master-data configuration, not a transactional document write). `TaxCodesService.setGlAccounts()` validates each supplied account with the identical exists/active/same-legal-entity pattern `ApSettingsService`/`ArSettingsService` already use for their own tax-account fields (deliberately no `accountType` check, for the same jurisdiction-dependent reasoning), and writes an audit-log entry. No new permission was invented.

## 3. Migration

`services/sphere-finance/drizzle/migrations/0020_tax_vat_phase_5_gl_account_mapping.sql` — generated via `drizzle-kit generate` (matching every prior Tax/VAT migration's own provenance, not hand-written), following the exact schema/FK conventions of `0018_tax_vat_phase_2_ap_calculation.sql`/`0019_tax_vat_phase_3_ar_calculation.sql`: six additive `ALTER TABLE ... ADD COLUMN` statements (all nullable, no default, no backfill), six matching FK constraints wrapped in the repository's standard `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;` idempotency guard, `ON DELETE no action ON UPDATE no action` — identical FK behavior to every existing `chart_of_accounts` reference in this schema. No destructive change. Applied and directly verified (not source-inspection-only — see §9) against both `noryx` and `noryx_test`. No RLS policy change was needed: RLS in this schema is table-level (`tenant_isolation` policy, already present on all 5 affected tables), unaffected by adding nullable columns. No constraint-SQL file change was needed: the existing generic immutability triggers already cover every column of their table unconditionally.

## 4. Files changed

**New:**

- `services/sphere-finance/drizzle/migrations/0020_tax_vat_phase_5_gl_account_mapping.sql` (+ `meta/0020_snapshot.json`, `meta/_journal.json` updated)
- `services/sphere-finance/src/tax-configuration/dto/update-tax-code-gl-accounts.dto.ts`
- `services/sphere-finance/src/tax-configuration/dto/update-tax-code-gl-accounts.dto.spec.ts` (7 tests)
- `services/sphere-finance/test/tax-vat-phase-5-gl-account-mapping.e2e-spec.ts` (26 tests, 5 describe blocks: PATCH RBAC/validation; resolution + snapshot semantics; posting polarity/aggregation; post()-time deterministic-destination/re-validation; VAT Position Report multi-account cross-check)
- `docs/finance-work-item-tax-vat-phase-5-discovery.md`, `docs/finance-work-item-tax-vat-phase-5-proposal.md` (the discovery/proposal artifacts this work implements)
- `docs/finance-work-item-tax-vat-phase-5-completion-report.md` (this report)

**Modified:**

- `services/sphere-finance/src/db/schema.ts` — 2 new columns on `taxCodes`, 1 new column each on the 4 line tables.
- `services/sphere-finance/src/tax-configuration/tax-rates.service.ts` — `resolveEffectiveRate()` return-shape extension.
- `services/sphere-finance/src/tax-configuration/tax-codes.service.ts` — `setGlAccounts()` + `validateTaxAccountOrThrow()`.
- `services/sphere-finance/src/tax-configuration/tax-codes.controller.ts` — new `PATCH :id/gl-accounts` route.
- `services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.service.ts`
- `services/sphere-finance/src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts`
- `services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.service.ts`
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts`
- `services/sphere-finance/src/tax-reports/tax-reports.service.ts` — additive `VatPositionGlAccountBreakdown`/multi-account cross-check.
- `services/sphere-finance/src/route-role-matrix.spec.ts` — new route entry; 126→127 routes, still 25 controllers.
- `docs/roadmap.md`, `docs/project/PROJECT_STATE.md` — Phase 5 marked COMPLETE, snapshot/baseline lines updated, next-work-item framing kept generic.

**Deliberately excluded from this commit:** `docs/hardening/` (unrelated, pre-existing untracked NOAH/hardening workstream) — not part of this authorization's scope. No `.env` file was touched or included.

## 5. Architectural invariants (CTO's 14-item list) — status

All 14 remain true: centralized tax calculation (unchanged — still `TaxRatesService`/`calculateTaxAmountMinor`); rates resolved by transaction date (unchanged); tax snapshots immutable after posting (unchanged, now including the new column); GL account selection also snapshotted before posting (new, this phase); `post()` does not mutate tax-bearing source lines (unchanged — confirmed still true, §2.4); credit/debit notes never inherit tax configuration from allocations (unchanged, explicitly re-verified this phase, §2.2); AP and AR remain structurally symmetric (the four posting services received the identical shape of change); existing posting polarity unchanged (§2.4); tenant isolation/RLS intact (table-level RLS unaffected by new nullable columns); existing posted documents remain historically deterministic (§2.3); VAT Position Report backward-compatible (§2.5, additive-only); GL reconciliation works with multiple tax accounts (§2.5, new); no destructive migration (§3); no unrelated workstream modified (§4).

## 6. Deviations from the approved proposal

None. The repository matched every proposal assumption everywhere checked during implementation; the one escape-hatch condition ("if the actual repository contradicts the approved proposal in a material way, STOP and report") was never triggered.

## 7. Verification results

Run in the order specified, against the actual final tree (re-run after the lint-staged commit hook — see §10):

| Check                                                      | Result                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (`tsc --noEmit`)                                 | Clean, 0 errors                                                                                                                                                                                       |
| Lint (`eslint`)                                            | 0 errors, 12 pre-existing unrelated warnings (8 `_drop`-pattern spec-file warnings identical to Phase 4's report; 4 pre-existing unused-var warnings in unrelated e2e files not touched by this work) |
| Targeted: `update-tax-code-gl-accounts.dto.spec.ts`        | 7/7 passed                                                                                                                                                                                            |
| Targeted: `tax-vat-phase-5-gl-account-mapping.e2e-spec.ts` | 26/26 passed                                                                                                                                                                                          |
| Targeted: `route-role-matrix.spec.ts`                      | 137/137 passed                                                                                                                                                                                        |
| Full unit suite (`jest`)                                   | **610/610 passed**, 65 suites                                                                                                                                                                         |
| Full e2e suite (`jest -e2e`)                               | **891/891 passed**, 45 suites — includes the full pre-existing 865-test suite passing **unmodified**, proving backward compatibility empirically, not just by design argument                         |
| Migration applied + verified                               | `noryx` and `noryx_test` — see §9                                                                                                                                                                     |

No regression in any pre-existing suite.

## 8. Testing — the 20 CTO-specified categories, mapped to coverage

1. Tax code with input/output account configured → correct resolution: e2e "tax code WITH an apTaxAccountId/arTaxAccountId override".
2. Tax code with NO account configured → correct singleton fallback: e2e "tax code with NO override falls back to ...".
3. Snapshot persists at DRAFT-resolution time: every resolution test above reads the line immediately after `create()`.
4. Snapshot unchanged after later config changes: e2e "a later change to the tax code's GL account does NOT retroactively change an already-resolved DRAFT line".
5. Posted lines immutable: e2e "remains unchanged after posting, even if the tax code is remapped again afterward" (application-level) + direct SQL `UPDATE` rejection test against the real trigger (§9, database-level).
6. Each of the 4 document types uses the correct account + polarity: 4 dedicated e2e tests in "posting — polarity and multi-account aggregation".
7. Multiple tax codes/accounts in one document: the CTO's exact worked-example e2e test.
8. Multiple lines sharing one account aggregate into one journal line: same worked-example test (500+300→800).
9. Different accounts stay separate: "does not aggregate two DIFFERENT accounts together merely because both are input/output tax".
10. Credit-note/debit-note allocations don't influence tax-account resolution: 2 dedicated e2e tests using a DIFFERENT tax code on the credit/debit note than on the allocated invoice/bill, asserting the note's own code wins.
11. Singleton fallback if approved: covered throughout (§ items 2, and the "tenant using only the singleton" VAT report test).
12. VAT Position Report remains correct: full pre-existing 17-test `vat-position-report.e2e-spec.ts` passes unmodified.
13. GL cross-check handles multiple accounts: dedicated e2e test asserting `outputTaxAccounts`/`inputTaxAccounts` per-account figures reconcile against actual journal movement.
14. Existing Phase 2/3/4 tests remain green: full e2e suite, 865 pre-existing tests, unmodified and passing.
15. RBAC route matrix remains green: 137/137, including the 1 new route.
16. DTO validation: 7 unit tests on `UpdateTaxCodeGlAccountsDto` (empty payload, each field alone, both together, explicit-null clearing, invalid UUID rejection).
17. Deterministic-destination invariant enforced at posting: e2e "blocks posting when a tax line has no resolved tax account".
18. Posting-time account re-validation: e2e "blocks posting when the resolved tax account was archived between draft resolution and posting".
19. Unit/service-level behavior: DTO spec + the service-layer logic exercised transitively through every e2e test (no separate mock-based unit suite was written for the four posting services, consistent with this codebase's existing convention of testing posting logic exclusively at the e2e layer against a real Postgres instance — see every prior Tax/VAT phase's own test split).
20. End-to-end posting/report behavior: the entire new 26-test e2e suite.

## 9. Database verification (direct, not source-inspection-only)

- Migration applied via `drizzle-kit migrate` against both `postgresql://noryx:noryx@localhost:5432/noryx` and `.../noryx_test`; `[✓] migrations applied successfully!` for both.
- `\d supplier_bill_lines` / `\d tax_codes` directly inspected post-migration on `noryx`: `resolved_tax_account_id` and `ap_tax_account_id`/`ar_tax_account_id` columns present with the expected FK constraints to `chart_of_accounts(id)`.
- `information_schema.columns` queried directly on `noryx_test`: confirms `resolved_tax_account_id` present on all 4 line tables.
- After the full e2e run, queried `noryx_test` directly for non-null `resolved_tax_account_id` row counts across all 4 line tables (124/112/35/34 rows respectively) and `tax_codes` rows with a configured override (34) — confirms the resolution logic actually persisted real data through the real HTTP API, not merely that the code compiles.
- Direct SQL immutability proof: a `DO $$ ... UPDATE supplier_bill_lines SET resolved_tax_account_id = ... WHERE <a real POSTED line> ... $$` was executed against `noryx_test` and returned `UPDATE BLOCKED as expected: supplier_bill_lines is immutable once its parent supplier_bills is POSTED` — the pre-existing trigger, unmodified, protecting the new column.

## 10. Deviations / notable implementation details

- `TaxRatesService.resolveEffectiveRate()`'s return-type change (`TaxRate` → `{ rate, taxCode }`) required updating its 4 call sites (one per posting service) — all mechanical, no behavior change to rate resolution itself.
- The e2e suite required separate `finance.poster` tokens for document create/post calls (bills/invoices/debit-notes/credit-notes require `finance.poster`, not `finance.admin`, per this codebase's existing RBAC convention) alongside `finance.admin` tokens for tax-code/account/settings configuration — caught and corrected during test-writing, not a production-code issue.
- The repository's lint-staged pre-commit hook did run on commit (`eslint --fix` + `prettier --write` across all 21 staged files, as on every prior phase) and reported no findings requiring manual fixup. The full verification suite was re-run in full against the actual post-commit/post-format tree (not the pre-commit state): `tsc --noEmit` clean; `eslint src --ext .ts` → 0 errors, 8 warnings (all 8 are pre-existing `_drop`-unused-var warnings in unrelated bank-transactions/payment-provider-settlements/scheduled-reversals DTO spec files — down from the 12 pre-existing warnings noted pre-commit, i.e. no new warnings were introduced and the hook's `eslint --fix` incidentally cleared 4 auto-fixable pre-existing ones); full unit suite 610/610 passed across 65 suites; full e2e suite 891/891 passed across 45 suites (including the new `tax-vat-phase-5-gl-account-mapping.e2e-spec.ts`, 26/26); `route-role-matrix.spec.ts` 137/137. No file required a manual fix after the hook ran — the pre-commit and post-commit trees are behaviorally identical.

## 11. Commit, bundle, and push verification

- **Commit SHA:** `27779c875e015803f2728b4c745420ee18525dfb` on branch `main`, 21 files changed (13 modified, 8 new), 8541 insertions(+), 77 deletions(-) as reported by `git commit`/`git log --stat`. `docs/hardening/` remains untracked and was not included. `git status --short` post-commit shows only `?? docs/hardening/`.
- **Parent (verified prior `main`):** `8ccdec5da3ab663dc896660d0b92e646e46f30e3` (Tax/VAT Phase 4 completion report) — confirmed via `git log --oneline -5` showing `27779c8` directly on top of `8ccdec5`.
- **Push attempt:** `git push origin main` was attempted and failed with the same recurring environment-level git-proxy authorization gap observed on every prior phase: `remote: access denied by the git proxy: jerinibrahim-cyber/noryx-platform is not in this session's authorized repository set... fatal: ... 403`. No push occurred; `origin/main` was not modified.
- **Fallback delivery:** a bundle (`tax-vat-phase-5.bundle`) covering the full commit range `8ccdec5..main` (single commit `27779c8`) was created and independently verified via `git bundle verify` (`is okay`) and `git bundle list-heads` (confirms `27779c875e015803f2728b4c745420ee18525dfb refs/heads/main`).
- **Reported status: `LOCAL COMMIT COMPLETE — PUSH NOT VERIFIED`.** GitHub delivery is not claimed.

## 12. Explicitly out of scope (respected)

- Tax/VAT Phase 6 (or any next work item) was not selected, discovered, or implemented.
- The unrelated NOAH orchestrator workstream was not touched.
- `docs/hardening/` was not included in this commit.
- Statutory VAT filing, reverse charge, multi-jurisdiction tax, tax-inclusive pricing, and coverage of manually-posted (non-AP/AR) tax journal entries remain explicitly deferred, per the updated `docs/roadmap.md`.
