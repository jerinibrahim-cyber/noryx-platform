# Tax/VAT Phase 3 (AR Tax Calculation) — Completion Report

**Status:** Implementation, verification, documentation, and local commit are complete. **Push to `origin/main` is blocked by a session-level git-proxy authorization denial, not by any code, test, or architecture issue.** This mirrors the exact blocker reported for Tax/VAT Phase 2 at the start of this session (`LOCAL COMMIT COMPLETE — PUSH NOT VERIFIED`).

## Commit

- **Implementation commit SHA:** `ad71a504cf54e7ad3e5f35d1c0b7cc7ec517ccc0` — "Tax/VAT Phase 3 — AR Tax Calculation"
- **Local `main` HEAD:** the commit adding this report itself, "Add Tax/VAT Phase 3 completion report" (its exact SHA is necessarily generated after this text is written — see `git log -1 --format=%H` on `main`, or the bundle's own ref)
- **Parent (last pushed-verified commit):** `6229bc6f01c532e5ebb30797c9ed040107d8591f` (Tax/VAT Phase 2 completion report)
- **GitHub `origin/main` SHA (verified via `git fetch` + `git rev-parse origin/main`):** `6229bc6f01c532e5ebb30797c9ed040107d8591f` — **still Phase 2**, because every push attempt below failed.
- **Local `main` vs `origin/main`:** local is **2 commits ahead** (`ad71a50`, `6aa4896`), not yet pushed.

## Push attempt and blocker

Three `git push origin main` attempts, spread across the implementation and documentation steps, all failed identically:

```
remote: access denied by the git proxy: jerinibrahim-cyber/noryx-platform is not in
this session's authorized repository set, so the proxy will not inject a credential
for it. To fix, add the repository to the session's sources.
fatal: unable to access 'https://github.com/jerinibrahim-cyber/noryx-platform.git/':
The requested URL returned error: 403
```

Read access (`git fetch origin main`) succeeds normally — this is a write/push-scope authorization gap on the session's git proxy, not a network, credentials, or repository-state problem. It requires the repository to be added to this session's authorized-write set, which is outside the engineering scope of this task. **Genuine remaining blocker: the Phase 3 commit cannot be pushed to `origin/main` from this session until that authorization is granted; the git bundle below (`tax-vat-phase-3.bundle`) contains the exact commit and can be pushed from any environment that does have write access.**

## What was implemented

Wires the approved Tax Code/Rate model (Tax/VAT Phase 1) into Customer Invoices and Customer Credit Notes, using the Phase 2 AP implementation (`SupplierBillsService` / `SupplierDebitNotesService`) as the direct engineering precedent, per `docs/work-items/tax-vat-phase-3-ar-tax-calculation/DISCOVERY.md`.

- **Schema / migration** (`0019_tax_vat_phase_3_ar_calculation.sql`): added `tax_code_id`, `tax_rate_id`, `tax_amount_calculated_minor`, `tax_amount_overridden` to `customer_invoice_lines` and `customer_credit_note_lines`, with FKs to `tax_codes`/`tax_rates` and the two CHECK constraints per table (`..._tax_overridden_requires_code`, `..._tax_rate_requires_code`) established in Phase 2. Purely additive; RLS policies and the immutability trigger automatically cover the new columns with zero SQL changes, exactly as the discovery document predicted.
- **DTOs**: optional `taxCodeId` (UUID) added to `CreateCustomerInvoiceLineDto` and `CreateCustomerCreditNoteLineDto`, with unit tests for well-formed, malformed, and override-combined cases.
- **Module wiring**: `TaxConfigurationModule` imported into `CustomerInvoicesModule` / `CustomerCreditNotesModule` so each service can inject `TaxRatesService`.
- **`CustomerInvoicesService`**: new `resolveLineTax()` resolves the effective tax rate by the invoice's own `invoiceDate` (or the updated date on edit), calculates and snapshots `taxRateId`/`taxAmountCalculatedMinor`, and applies the Phase 2 Decision 4 override semantics (client-supplied `taxAmountMinor` stays authoritative when both are given; calculated value is authoritative when `taxCodeId` alone is given; 100% legacy behavior when `taxCodeId` is omitted).
- **`CustomerCreditNotesService`**: identical `resolveLineTax()`, resolved by `creditNoteDate`. Its signature `(tx, tenantId, legalEntityId, creditNoteDate, lines)` deliberately takes **no `allocations` parameter** — mirroring `SupplierDebitNotesService.resolveLineTax()` exactly — so it is a compile-time impossibility for credit-note tax resolution to read invoice or allocation data. This carries forward Phase 2's CTO-confirmed no-inheritance correction: `customer_credit_note_allocations` is a header-level many-to-many table with no line-level linkage to any `customer_invoice_lines` row, so there is nothing to inherit from.
- **Reuse, zero duplication**: `TaxConfigurationModule`, `TaxRatesService.resolveEffectiveRate()`, and `calculateTaxAmountMinor()` are consumed unmodified via dependency injection. No new tax-calculation logic was written for Phase 3.
- **Posting/accounting**: unchanged. AR posting polarity (Cr revenue + Cr tax-output / Dr AR control on invoices; reversed — Dr line + Dr tax / Cr AR control — on credit notes) is unaffected; the aggregate tax journal line still equals `SUM(line.taxAmountMinor)` with calculated and overridden tax mixed, verified by dedicated e2e tests on both documents.

## Verification results

All run against a live PostgreSQL instance (`noryx` for dev migrations, `noryx_test` for e2e, per `test/env-setup.ts`).

| Check                                                                         | Result                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tsc --noEmit` (typecheck)                                                    | **Clean**                                                                                                                                                                                                                                                                                                    |
| `eslint src --ext .ts` (lint)                                                 | **Clean — 0 errors** (8 pre-existing unrelated warnings in unrelated files)                                                                                                                                                                                                                                  |
| Unit tests (`jest`)                                                           | **589 / 589 passed** (63 suites)                                                                                                                                                                                                                                                                             |
| E2E tests (`jest --config jest-e2e.config.js`)                                | **848 / 848 passed** (43 suites)                                                                                                                                                                                                                                                                             |
| RBAC route-role-matrix (`src/route-role-matrix.spec.ts`, included in the 589) | **135 / 135 assertions passed** — unchanged from Phase 2 since Phase 3 added no new routes                                                                                                                                                                                                                   |
| New Phase 3 e2e tests                                                         | **19 / 19 passed** — 10 in `customer-invoices.e2e-spec.ts`, 9 in `customer-credit-notes.e2e-spec.ts`                                                                                                                                                                                                         |
| New Phase 3 DTO unit tests                                                    | **22 / 22 passed** (11 per DTO spec file)                                                                                                                                                                                                                                                                    |
| DB-level RLS/constraint verification                                          | Confirmed directly via `psql \d` against **both** `noryx` and `noryx_test`: new columns, both CHECK constraints, and both FKs present on `customer_invoice_lines` and `customer_credit_note_lines`; `tenant_isolation` RLS policy (forced row security) unchanged and covering the new columns automatically |
| Post-commit re-verification                                                   | The repository's pre-commit hook ran `eslint --fix` / `prettier --write` on the staged files; typecheck and the two modified e2e suites (81 tests) were re-run afterward and remained fully green                                                                                                            |

One genuine test-authoring error was found and fixed during this work, not a product bug: the first draft of the credit-note "posting is unaffected" e2e test asserted the tax journal line as a **credit** against the tax-output account, copying the plain AR-invoice polarity. The actual (correct) behavior — proven by the pre-existing "happy path: reversed polarity" test in the same file — is that credit notes **reverse** the invoice's own polarity, so the tax line is a **debit**. The test assertion was corrected to `taxLine!.debitMinor` to match the confirmed, already-verified posting behavior; no production code changed as a result.

## Architecture decisions applied (discovery §13, re-confirmed against current code before implementation)

1. Line-level `taxCodeId` on both Customer Invoice and Customer Credit Note lines — implemented as designed.
2. Rate resolution by the document's own transaction date (`invoiceDate` / `creditNoteDate`), never any other date — implemented as designed.
3. Snapshot semantics (immutable `taxRateId` FK, `taxAmountCalculatedMinor` retained) — implemented as designed, identical to Phase 2.
4. Override semantics identical to Phase 2 Decision 4 — implemented as designed.
5. Credit notes resolve tax independently per line, with no inheritance from allocated invoices, enforced at the method-signature level — implemented as designed, and additionally proven by a dedicated e2e test (`a credit note allocating to TWO DIFFERENT invoices resolves its own lines' tax entirely independently`) where neither allocated invoice carries any tax at all.

No architecture conflict was found between the discovery document and the actual repository state at implementation time; all five decisions held exactly as discovered, so implementation proceeded directly per the discovery document's own recommendation.

## Documentation updated

- `docs/roadmap.md`: "Current execution status" summary, the Tax/VAT phase checklist (`Phase 3` marked `[x]` complete, `Phase 4 — VAT Position Report` named as the next unauthorized candidate item), and the Finance-First Product Build Strategy tree's Tax/VAT status line.
- `docs/project/PROJECT_STATE.md`: "Repository implementation state" paragraph updated to describe Phase 3 completion and the current commit lineage, snapshot date/description line updated.

## Files changed (17 total, this commit)

```
docs/finance-work-item-tax-vat-phase-3-discovery.md                                          (new)
docs/project/PROJECT_STATE.md
docs/roadmap.md
services/sphere-finance/drizzle/migrations/0019_tax_vat_phase_3_ar_calculation.sql            (new)
services/sphere-finance/drizzle/migrations/meta/0019_snapshot.json                            (new)
services/sphere-finance/drizzle/migrations/meta/_journal.json
services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.module.ts
services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts
services/sphere-finance/src/accounts-receivable/customer-credit-notes/dto/create-customer-credit-note-line.dto.spec.ts
services/sphere-finance/src/accounts-receivable/customer-credit-notes/dto/create-customer-credit-note-line.dto.ts
services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.module.ts
services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.service.ts
services/sphere-finance/src/accounts-receivable/customer-invoices/dto/create-customer-invoice-line.dto.spec.ts
services/sphere-finance/src/accounts-receivable/customer-invoices/dto/create-customer-invoice-line.dto.ts
services/sphere-finance/src/db/schema.ts
services/sphere-finance/test/customer-credit-notes.e2e-spec.ts
services/sphere-finance/test/customer-invoices.e2e-spec.ts
```

`services/sphere-finance/.env` (created locally during migration setup, containing only a placeholder dev-only JWT secret and the local dev `DATABASE_URL`) remains correctly excluded by `.gitignore`. `docs/hardening/` remains untracked — a pre-existing, unrelated workstream not touched by this task.

## Deliverables

- **Git bundle:** `~/Downloads/tax-vat-phase-3.bundle` — contains the single Phase 3 commit `ad71a504cf54e7ad3e5f35d1c0b7cc7ec517ccc0` on top of `6229bc6` (the last commit already on `origin/main`). Verified with `git bundle verify` (`is okay`). Push it with `git fetch <bundle-path> main:main-phase-3-import` or `git pull <bundle-path> main` from a clone with write access to `jerinibrahim-cyber/noryx-platform`, then `git push origin main`.
- **This completion report:** `~/Downloads/finance-work-item-tax-vat-phase-3-completion-report.md`

## Remaining blocker (genuine, not dismissed)

**The Phase 3 commit is not yet on `origin/main`.** This session's git proxy denies push access to `jerinibrahim-cyber/noryx-platform` ("not in this session's authorized repository set"), while read access (`fetch`) works normally — this is a session-authorization-scope gap, not a code, test, merge-conflict, or architecture problem. Everything up to and including the local commit is complete and fully verified; pushing requires either (a) adding this repository to the session's authorized write set and re-running `git push origin main`, or (b) applying the delivered bundle from an environment that already has push access.
