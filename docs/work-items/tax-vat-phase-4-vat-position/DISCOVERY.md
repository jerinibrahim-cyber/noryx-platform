# Tax/VAT Phase 4 — VAT Position Report — Architecture Discovery

**Document status:** DISCOVERY ONLY. No implementation, schema change, migration, commit, or push has been made as part of this document. Written by Claude (Senior Engineer role) per NOAH/CTO's discovery-only authorization prompt. Following `CLAUDE.md` rule 4, this document surfaces every point that requires a CTO decision rather than silently resolving it.

---

## 1. Verified baseline and commit SHA

Established directly from the live repository and GitHub, not from any cached assumption:

- **Local `main` HEAD:** `263354be0658e9d9d45a8ecb297fdadecf890db0` — "Add Tax/VAT Phase 3 completion report"
- **`origin/main` (GitHub), verified via `git fetch origin main` + `git rev-parse origin/main`:** `263354be0658e9d9d45a8ecb297fdadecf890db0` — **identical to local `main`.** This confirms the Tax/VAT Phase 3 push (reported as blocked at the end of the prior session due to a session-level git-proxy authorization gap) has since succeeded — local and GitHub `main` are now in sync at the same commit. (Direct `gh api` GitHub verification is not available in this session — "GitHub access to this repository is not enabled for this session" — but `git fetch`/`rev-parse` against the real `origin` remote is an equally authoritative signal of the actual GitHub ref and was used instead.)
- **Working tree:** clean except one pre-existing, unrelated untracked directory, `docs/hardening/` (a separate orchestrator-hardening workstream, out of scope here, left untouched exactly as in every prior Finance task this session).
- **Immediately preceding commits on `main`:** `ad71a50` (Tax/VAT Phase 3 — AR Tax Calculation implementation), `6229bc6`/`ae4b073` (Tax/VAT Phase 2 — AP Tax Calculation), `dd6d135` (Tax/VAT Phase 1 — Tax Configuration Foundation).
- **`docs/roadmap.md`** (current `main`): names **"Tax/VAT Phase 4 — VAT Position Report"** as the next candidate Finance work item, explicitly **not yet discovered or authorized**, with the one-line scope note _"internal VAT reconciliation/reporting built on the existing GL read layer."_ This document is that discovery.
- **`docs/project/PROJECT_STATE.md`** (current `main`): confirms Phase 1–3 completion and repeats the same "Phase 4 not yet discovered or authorized" framing; explicitly warns against inventing the next feature from stale documents.
- **`docs/project/CURRENT_PHASE.md`** / **`docs/project/NEXT_TASK.md`** / **`docs/project/DECISIONS.md`**: all describe a **separate, unrelated workstream** — the NOAH orchestrator's own Stage 1B (`packages/orchestrator-validator`, `docs/orchestrator/`). None of these three files mention Tax/VAT, Finance reporting, or Phase 4 in any way. Per the explicit instruction governing this task ("Do not select or begin Phase 5 or unrelated workstreams") and the roadmap's own Finance-first framing, **the orchestrator workstream is out of scope for this discovery** and is noted here only because reading these four files was an explicit baseline-establishment instruction.
- **Discrepancy found and flagged (not silently resolved):** `docs/roadmap.md`'s own detailed "Phase 1 — what's built so far" checklist (the "Financial Reporting — PARTIAL" paragraph) states that "broader P&L, Balance Sheet, Cash Flow, account statements, AP/AR ageing and management reporting remain planned." This is **stale relative to the actual repository**: `src/financial-statements/` (Profit & Loss, Balance Sheet), `src/accounts-payable/ap-reports/` (ageing, statement, balance, GL reconciliation), and `src/accounts-receivable/ar-reports/` (the AR equivalents) all exist, are wired into `app.module.ts`, and have passing e2e suites (`financial-statements-profit-and-loss.e2e-spec.ts`, `financial-statements-balance-sheet.e2e-spec.ts`, `ap-ageing.e2e-spec.ts`, `ar-ageing.e2e-spec.ts`, `ap-gl-reconciliation.e2e-spec.ts`, `ar-gl-reconciliation.e2e-spec.ts`, `ap-supplier-statement.e2e-spec.ts`, `ar-customer-statement.e2e-spec.ts`, `ap-supplier-balance.e2e-spec.ts`, `ar-customer-balance.e2e-spec.ts` — all confirmed present and passing as part of the 848/848 e2e suite verified during Phase 3). This document treats the live repository, not that stale checklist line, as authoritative for "what reporting infrastructure exists" — consistent with `CLAUDE.md`'s "Git ... is authoritative" rule. **This is noted as a documentation-hygiene item, not a Phase 4 blocker**, and is listed again as a minor housekeeping item in §11.

## 2. Scope / objective

Per the roadmap's own framing and the CTO authorization prompt: **an internal VAT Position Report**, read-only, built entirely on data Tax/VAT Phases 1–3 already capture — no new tax-calculation logic, no statutory filing format, no reverse charge, no multi-jurisdiction handling (all explicitly out of MVP scope per the Phase 1 schema doc comment, reproduced in §9 below).

The report's job: for a legal entity and a reporting window, show **output tax** (VAT collected on sales), **input tax** (VAT paid on purchases, recoverable), and the **net VAT position** (payable if output > input, refundable if input > output) — the internal building block a business needs before it can prepare an actual VAT return, not the return itself.

## 3. Current architecture and relevant data flow

### 3.1 Where tax is captured (Phases 1–3, confirmed by direct code read this session)

Four line-level tables carry an **optional, nullable** `tax_code_id`, added by Phase 2 (AP) and Phase 3 (AR), each with the identical four-column shape:

| Table                        | Parent header           | Document date field | Phase |
| ---------------------------- | ----------------------- | ------------------- | ----- |
| `supplier_bill_lines`        | `supplier_bills`        | `bill_date`         | 2     |
| `supplier_debit_note_lines`  | `supplier_debit_notes`  | `debit_note_date`   | 2     |
| `customer_invoice_lines`     | `customer_invoices`     | `invoice_date`      | 3     |
| `customer_credit_note_lines` | `customer_credit_notes` | `credit_note_date`  | 3     |

Each of these four line tables carries, verified directly in `src/db/schema.ts` this session: `tax_code_id` (nullable FK → `tax_codes`), `tax_rate_id` (nullable FK → `tax_rates`, the immutable snapshot of which rate resolved), `tax_amount_minor` (always populated — legacy manual value when `tax_code_id` is null, calculated-or-overridden value when it is set), `tax_amount_calculated_minor` (nullable — the calculated figure, retained even when overridden), `tax_amount_overridden` (boolean). Two CHECK constraints per table (`..._tax_overridden_requires_code`, `..._tax_rate_requires_code`) are already in place and unchanged by this discovery.

`tax_codes` (master data, one row per code per legal entity) carries a `treatment` enum: **`STANDARD` | `ZERO_RATED` | `EXEMPT`** (verified in `schema.ts`; no `REVERSE_CHARGE` value exists — confirmed absent, matching the schema's own doc comment: _"No reverse-charge treatment in MVP — nothing in this codebase or in verified UAE test data (`countryCode: "AE"` everywhere) requires it."_). `tax_rates` (effective-dated, immutable, create-only) carries `rate_basis_points` and an effective-date range enforced non-overlapping by a GiST EXCLUDE constraint.

**Direction (input vs. output) is not stored on `tax_codes` or `tax_rates` at all.** It is purely a function of which subledger posted the line: `ap_settings.tax_input_account_id` (one nullable column, singleton per legal entity) is the account every AP tax line posts to; `ar_settings.tax_output_account_id` (same shape) is the account every AR tax line posts to. A given `tax_code_id` is not restricted to AP-only or AR-only use — it is entity-wide master data, usable on any document type. This is confirmed both by the schema (no AP/AR flag on `tax_codes`) and by `TaxConfigurationModule` being imported, unmodified, into all four document modules (`SupplierBillsModule`, `SupplierDebitNotesModule`, `CustomerInvoicesModule`, `CustomerCreditNotesModule`) with no filtering logic anywhere.

### 3.2 The central architectural finding: GL cannot answer this report

Read directly from `CustomerInvoicesService.post()` this session (and confirmed structurally identical in `SupplierBillsService.post()`/the two credit/debit-note services by the same Phase 2/3 pattern): posting builds **one aggregate tax `journal_lines` row per document**, not one per tax code:

```ts
const taxTotal = before.lines.reduce((sum, l) => sum + l.taxAmountMinor, 0);
...
if (taxTotal > 0) {
  journalLineValues.push({
    ...
    accountId: settings.taxOutputAccountId!,   // the ONE singleton AR tax account
    creditMinor: taxTotal,                     // SUMMED across every tax code on the document
    description: `Tax on invoice ${internalReference}`,
  });
}
```

`journal_lines` itself (schema verified this session) has no `tax_code_id`, `tax_rate_id`, or back-reference to the source document line — only `account_id`, `debit_minor`, `credit_minor`, a free-text `description`. **Therefore the General Ledger read layer (`GeneralLedgerService`, `journal_lines`/`journal_entries`) can tell you the total tax activity on the one tax-input account and the one tax-output account for a period — but it structurally cannot tell you the breakdown by tax code, by rate, or by treatment (`STANDARD`/`ZERO_RATED`/`EXEMPT`).** That breakdown exists only at the four source line tables above.

This directly contradicts the roadmap's one-line scope note ("built on the existing GL read layer") taken literally. The correct reading, consistent with the actual data model: the report is built on the **existing tax-capture read layer** (the four line tables Phases 2/3 already wrote), with the **GL read layer used only as an optional, coarser cross-check** (see §6.3) — not as the report's primary source. This is flagged explicitly in §11 as a decision requiring CTO confirmation, since it changes what "built on the existing GL read layer" concretely means for implementation.

### 3.3 Credit/debit note polarity (confirmed by direct code read, not inferred)

`CustomerCreditNotesService`'s "happy path" e2e test (read this session) proves credit notes **reverse** invoice polarity at posting: invoices **credit** revenue + **credit** tax-output / debit AR control; credit notes **debit** the line account + **debit** tax-output / credit AR control. Economically, a credit note **reduces** previously-recognized output tax. `tax_amount_minor` is always stored as a non-negative number on every line (CHECK-constrained on all four tables) — the reduction is expressed by _which document type_ the line belongs to, never by a negative stored value. Debit notes are the exact AP mirror (confirmed by `ap-reports.service.ts`'s supplier-statement code treating a posted debit note as `-totalMinor`, i.e. it reduces the supplier balance the same way a credit note reduces the customer balance).

**Therefore, by direct consequence of already-implemented, already-tested behavior:**

- **Net output tax** for a period = SUM(`customer_invoice_lines.tax_amount_minor` for POSTED invoices dated in-period) − SUM(`customer_credit_note_lines.tax_amount_minor` for POSTED credit notes dated in-period).
- **Net input tax** for a period = SUM(`supplier_bill_lines.tax_amount_minor` for POSTED bills dated in-period) − SUM(`supplier_debit_note_lines.tax_amount_minor` for POSTED debit notes dated in-period).
- **Net VAT position** = Net output tax − Net input tax (positive = payable to the tax authority; negative = refundable/recoverable).

This is not a new design choice — it is the direct, unavoidable consequence of the posting polarity Phase 2/3 already implemented and verified. Presented here as a **confirmed fact**, not a proposal.

### 3.4 Reporting-period precedent already established

`FinancialStatementsService.getProfitAndLoss()` (read this session) is the closest existing precedent — a **movement** report (only activity strictly within `[dateFrom, dateTo]` counts, never cumulative-since-inception), accepting either an explicit `dateFrom`/`dateTo` or a `periodId` that resolves to `accounting_periods.start_date`/`end_date`. `accounting_periods` (schema verified) is a generic, arbitrarily-bounded period table (`start_date`, `end_date`, `status: OPEN|CLOSED`) — there is no built-in "monthly"/"quarterly" period type, so a VAT-filing-period cadence (UAE VAT is typically monthly or quarterly by registration category) is not structurally assumed anywhere in this schema; the caller supplies whatever window it needs. A VAT Position Report should accept the same `dateFrom`/`dateTo` (with optional `periodId` convenience resolution), **not** a Trial-Balance-style point-in-time `asOf` — VAT position is inherently a movement-over-a-window concept, like P&L, not a snapshot.

## 4. Exact affected files/tables/modules (for implementation — none touched by this discovery)

**No schema change, no migration.** Every column and table this report needs already exists and is already correctly populated by Phases 1–3:

- `tax_codes`, `tax_rates` (Phase 1)
- `supplier_bill_lines`, `supplier_debit_note_lines` (Phase 2, tax columns)
- `customer_invoice_lines`, `customer_credit_note_lines` (Phase 3, tax columns)
- Parent headers: `supplier_bills`, `supplier_debit_notes`, `customer_invoices`, `customer_credit_notes` (for `status = 'POSTED'` and the document date)
- `ap_settings.tax_input_account_id`, `ar_settings.tax_output_account_id` (for the optional GL cross-check, §6.3)
- `journal_lines`/`journal_entries` (read-only, optional cross-check only — see §3.2/§6.3)

**New files only** (proposed shape, §6):

```
services/sphere-finance/src/tax-reports/
  tax-reports.module.ts
  tax-reports.controller.ts
  tax-reports.service.ts
  dto/
    vat-position-query.dto.ts
    vat-position-query.dto.spec.ts
services/sphere-finance/test/vat-position-report.e2e-spec.ts
```

Plus a small, additive edit to `services/sphere-finance/src/app.module.ts` (one new import + one new entry in the `imports` array, the same one-line pattern every other top-level report module already follows) and `services/sphere-finance/src/route-role-matrix.spec.ts` (the new controller **must** be added to that file's manual controller-import list — its own exhaustiveness test, `"never classifies a route as 'unrecognized'"`, will otherwise fail the moment the new routes are registered; verified by reading that file's mechanism this session — it reflects over an explicit, hand-maintained array of controller classes, not auto-discovery).

## 5. Reusable existing components

Everything needed already exists; this is, like Phase 3, expected to be almost entirely wiring and read-only SQL, no new calculation logic:

- **`REPORT_TX_CONFIG`** (exported from `general-ledger.service.ts`: REPEATABLE READ + READ ONLY) — the established pattern for every multi-statement financial report in this codebase (`ApReportsService`, `ArReportsService`, `FinancialStatementsService` all import it directly rather than redefine it). A VAT report built from several separate `SELECT`s across four tables needs the identical one-snapshot guarantee.
- **`withTenant(tenantId, ..., REPORT_TX_CONFIG)`** — the tenant-context transaction wrapper every report method already uses.
- **The `resolvePeriodInScope`-style `periodId` → `{startDate, endDate}` resolution helper** — already implemented (locally, per that file's established "duplicate the trivial lookup" convention) in both `GeneralLedgerService` and `FinancialStatementsService`; the same shape is directly reusable.
- **`toNumber()` bigint-to-number coercion helper** — duplicated locally in every report service so far (`ApReportsService.toNumber`, etc.); same convention applies.
- **`todayUtc()`** — deterministic "today" (`new Date().toISOString().slice(0, 10)`), never SQL `NOW()`, same convention as every other report.
- **RBAC/RLS**: no new policy, no new role. `tenant_isolation` RLS already covers all four source line tables (and their parents) — confirmed unchanged since Phase 3's direct `psql \d` verification. `AuthCoreModule` + `@Roles("finance.viewer", "finance.poster", "finance.admin")` is the exact convention every other read-only report controller (`ApReportsController`, `ArReportsController`, `FinancialStatementsController`, `GeneralLedgerController`) already uses for 100% of their routes — no write-side RBAC split exists in any of them, because none of them write.
- **No new dependency on `TaxRatesService`/`TaxConfigurationModule` at all** — unlike Phase 2/3 (which needed to _resolve_ an effective rate at write time), this report only ever _reads already-snapshotted_ `tax_code_id`/`tax_rate_id`/`tax_amount_minor` values off posted lines. It needs `tax_codes` (for code/name/treatment display) and `tax_rates` (for rate-basis-point display) as plain joined tables, not the resolution service — keeping the new module decoupled, matching every existing report module's "pure read layer, no write-path coupling" posture.

## 6. Proposed implementation shape

### 6.1 Module placement

**Recommended: a new top-level module, `src/tax-reports/`**, a direct sibling of `GeneralLedgerModule`/`FinancialStatementsModule` in `app.module.ts` — not nested under `tax-configuration/` (that module is master-data/configuration, and every existing "…Module" under it is a config CRUD surface, not a report) and not nested under `accounts-payable/` or `accounts-receivable/` (this report is inherently cross-cutting over both, exactly like `FinancialStatementsModule` already is over GL — its own doc comment explicitly frames it as _"a top-level Accounting Core sibling of `GeneralLedgerModule`"_, the identical reasoning that applies here). This mirrors the one clear structural precedent already in the codebase for a report that reads both subledgers. **Flagged for CTO confirmation, not assumed** — see §11.

### 6.2 Endpoint

One read-only route, `GET /v1/finance/tax-reports/vat-position`, query params `{ dateFrom, dateTo }` XOR `{ periodId }` (same mutual-exclusion validator pattern already implemented in `TrialBalanceQueryDto`/`ProfitAndLossQueryDto`), all three finance roles.

### 6.3 Response shape (proposed, for CTO review — not locked)

```
{
  meta: {
    legalEntityId, dateFrom, dateTo, currencyCode,
    outputTaxMinor, inputTaxMinor, netPositionMinor,   // positive = payable
    unclassifiedOutputTaxMinor, unclassifiedInputTaxMinor  // see §9.1
  },
  outputByTaxCode: [ { taxCodeId, code, name, treatment, invoiceTaxMinor, creditNoteTaxMinor, netTaxMinor, netSupplyValueMinor } ],
  inputByTaxCode:  [ { taxCodeId, code, name, treatment, billTaxMinor, debitNoteTaxMinor, netTaxMinor, netSupplyValueMinor } ],
  glCrossCheck: {   // optional reconciliation section, §3.2 — coarse, not per-code
    taxOutputAccountId, glOutputTaxMovementMinor, outputDifferenceMinor, outputReconciled,
    taxInputAccountId,  glInputTaxMovementMinor,  inputDifferenceMinor,  inputReconciled
  }
}
```

`netSupplyValueMinor` (SUM of `amount_minor`, i.e. the taxable base, per code) is included because a usable VAT position report — even an internal one — is conventionally expected to show supply value alongside tax, not tax in isolation; this is flagged as a scope question in §11, not assumed as required.

### 6.4 Core queries (shape, not final SQL)

Four `SELECT ... FROM {line_table} JOIN {parent} ON ... JOIN tax_codes ON line.tax_code_id = tax_codes.id LEFT JOIN tax_rates ON line.tax_rate_id = tax_rates.id WHERE parent.status = 'POSTED' AND parent.{date_field} BETWEEN dateFrom AND dateTo AND parent.tenant_id = ... AND parent.legal_entity_id = ... GROUP BY tax_codes.id`, one each for invoice lines, credit-note lines, bill lines, debit-note lines — then combined in application code exactly as `ApReportsService.getSupplierStatement()` already combines multiple typed row sets before sorting/aggregating. The optional GL cross-check (§6.3's `glCrossCheck`) reuses the exact `glLiabilityBalance`-style raw-SQL shape already in `ApReportsService`/`ArReportsService`, applied to `ap_settings.tax_input_account_id`/`ar_settings.tax_output_account_id` for the same `[dateFrom, dateTo]` window (a _movement_ sum — `SUM(credit) - SUM(debit)` over the window — not the point-in-time balance style `glLiabilityBalance` itself uses, since VAT position is a period concept; this distinction is noted so implementation doesn't copy the wrong variant).

## 7. Reporting/accounting semantics

- **Only `status = 'POSTED'` documents count**, on every one of the four tables — identical posture to every other report in this codebase (DRAFT documents never appear in AP/AR ageing, statements, balances, or GL reports either).
- **Rounding**: every `tax_amount_minor` value being summed is already a final, rounded integer minor-unit figure (round-half-up, applied once per line at write time by `calculateTaxAmountMinor`, verified in `tax-calculation.ts` this session). The report must **sum already-rounded values**, never re-derive tax from `amount_minor × rate_basis_points` at report time — summing pre-rounded figures is also what keeps this report's `outputTaxMinor`/`inputTaxMinor` figures consistent with what was actually posted to the GL tax accounts (the invariant Phase 2/3's own e2e tests already prove: _"the aggregate tax journal line still equals SUM(line.taxAmountMinor)"_).
- **Overridden tax lines** (Phase 2 Decision 4: client-supplied `tax_amount_minor` authoritative, `tax_amount_calculated_minor` retained alongside): the report sums the authoritative `tax_amount_minor` (matching what actually posted to GL), not the calculated figure — for a tax position report this is correct by definition (it reports what was actually collected/paid), but is called out explicitly since it is a choice, not an accident (see §11).
- **Legacy lines with no `tax_code_id`** (manually-entered `tax_amount_minor`, fully legal per Phase 2/3's own preserved-legacy-behavior guarantee) carry no code, no rate, no treatment — they cannot be placed in `outputByTaxCode`/`inputByTaxCode`. They are proposed to roll into the `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` headline figures (§6.3) rather than being silently dropped from the total, so `outputTaxMinor` always equals the true sum regardless of classification completeness. This is a genuine design decision, flagged in §11.
- **Zero-rated and exempt treatment**: a `ZERO_RATED` or `EXEMPT` tax code still requires an effective `tax_rates` row to be usable at all (Phase 2/3's resolution logic 400s on "no effective rate" regardless of treatment) — in practice this means a 0%-rate row. The report groups by `tax_codes.treatment` as well as by code (per §6.3's `treatment` field) so standard-rated, zero-rated, and exempt activity can be told apart, which is the minimum a VAT position needs to be meaningful (a business with only zero-rated/exempt supplies has a very different position than one with none reported at all).

## 8. RLS/RBAC/security considerations

No change to either. Confirmed by direct inspection this session:

- **RLS**: `tenant_isolation` (forced row security) already covers every table this report reads (`customer_invoice_lines`, `customer_credit_note_lines`, `supplier_bill_lines`, `supplier_debit_note_lines`, their four parent headers, `tax_codes`, `tax_rates`, `ap_settings`, `ar_settings`, `journal_lines`/`journal_entries`) — verified directly via `psql \d` at the end of Phase 3 for the two newest tables, and established since Phase 1/2 for the rest. A purely additive, read-only report needs no RLS change.
- **RBAC**: read-only, all three finance roles (`finance.viewer`, `finance.poster`, `finance.admin`) — the exact, universal convention for every existing report controller in this codebase, none of which make a write-side RBAC distinction because none of them write.
- **Multi-tenant/multi-entity isolation**: `tenantId`/`legalEntityId` always come from the verified JWT via `requireTenantContext`, never from a request param — same convention as literally every other Finance controller, with no exception found anywhere in this codebase.
- **No PII/secret exposure risk**: the report surfaces only tax codes, rates, and minor-unit amounts already visible individually on invoices/bills/credit/debit notes to the same roles.

## 9. Tests/verification required

Mirroring the exact verification discipline established in Phases 2/3 (all independently re-run and confirmed clean this session as part of establishing the baseline for this discovery):

- **Unit**: new `vat-position-query.dto.spec.ts` (mutual-exclusion `dateFrom`/`dateTo` vs. `periodId` validation, matching `TrialBalanceQueryDto`'s existing `AsOfExcludesPeriodIdConstraint` pattern).
- **E2E** (`test/vat-position-report.e2e-spec.ts`), at minimum: RBAC (all three roles read, unauthenticated 401); a legal entity with no tax activity returns all-zero; STANDARD/ZERO_RATED/EXEMPT tax codes each classify correctly; a credit note correctly reduces net output tax (not merely adds to a separate bucket) — this is the single most important proof obligation, the direct analogue of Phase 3's cross-invoice-independence test; the debit-note mirror case for input tax; a legacy line with no `tax_code_id` lands in `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor`, not silently dropped from the total; an overridden tax line reports the overridden (not calculated) amount; the half-open date-window boundary (a document dated exactly on `dateTo` is included, one day after is not — matching every other movement report's own boundary test); cross-legal-entity and cross-tenant isolation; the optional GL cross-check reconciles to zero difference in the happy path and to a nonzero, correctly-signed difference when deliberately mismatched (mirroring `ap-gl-reconciliation.e2e-spec.ts`'s own structure).
- **Route-role-matrix**: the new controller must be added to `route-role-matrix.spec.ts`'s manual import list (§4) — otherwise its own exhaustiveness assertion fails immediately, this is not optional cleanup.
- **Full regression**: typecheck, lint, the full unit suite (589 tests as of Phase 3), the full e2e suite (848 tests as of Phase 3, plus whatever this phase adds), exactly as Phase 3 ran and reported.
- **DB-level**: none needed beyond what Phase 1–3 already verified (`psql \d` checks) — no new constraint, no new column, nothing to re-verify at the DDL level.

## 10. Risks and edge cases

- **The roadmap's "built on the existing GL read layer" framing is imprecise** (§3.2) — implementation risk if taken literally: a naive implementation attempting to derive per-tax-code figures from `journal_lines` alone is architecturally impossible with the current schema (no `tax_code_id` on `journal_lines`). Flagged prominently, not silently worked around.
- **Manual/legacy tax lines** (no `tax_code_id`) mean the per-tax-code breakdown can, by construction, never claim to be 100% of the entity's tax activity unless the `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` figures are always shown alongside it (§7) — a report that silently omitted these would understate the true position without any error or warning.
- **No coverage of manually-posted journal entries carrying tax.** `JournalEntriesService`'s own hand-posted-entry path can, in principle, book directly to `ap_settings.tax_input_account_id`/`ar_settings.tax_output_account_id` (e.g. a manual adjustment) without going through any of the four AP/AR document types this report reads. Such activity would appear in the optional GL cross-check's `glOutputTaxMovementMinor`/`glInputTaxMovementMinor` figures (§6.3) but **not** in the per-tax-code breakdown, and would show up as a nonzero `outputDifferenceMinor`/`inputDifferenceMinor` — which is exactly what the cross-check is for, but this expected-mismatch behavior needs to be documented in the report's own output, not treated as a bug once the report ships.
- **No Expense Management module exists yet** (`roadmap.md`: "PLANNED", not built) — a real business's recoverable input tax is not fully captured by Supplier Bills alone once that module exists; today's report is complete for the current subledger surface but is not future-proofed against that later Finance capability without a follow-up phase.
- **No FX/multi-currency** — Tax/VAT Phase 1–3 and this report all assume the legal entity's single functional currency (confirmed: `currencyCode` is fixed at journal-entry creation, no real FX exists anywhere in this codebase per `roadmap.md`'s own "Multi-Currency — PLANNED" note). A report combining AP and AR tax activity implicitly assumes both sides share one functional currency per legal entity, which is true today and requires no special handling — but is worth stating as a standing assumption, not a silent one.
- **Half-open vs. inclusive date-boundary convention** must exactly match every other movement report's own established convention (`dateTo` inclusive) — getting this inconsistent with P&L/AP-AR ageing would produce a report that doesn't reconcile against the very statements it is meant to sit alongside.

## 11. Explicit CTO Decision Required

These are presented as options with a recommendation, not silently resolved, per the governing instruction:

1. **Module placement** (§6.1): new top-level `src/tax-reports/` module (recommended, matching `FinancialStatementsModule`'s own precedent) vs. nesting under `tax-configuration/` vs. splitting into two reports (`ap-reports`/`ar-reports` each growing their own "input tax"/"output tax" endpoint). Recommendation: top-level module — the report is inherently cross-subledger and a split would force the client to call two endpoints and reconcile them itself.
2. **Response shape** (§6.3): whether `netSupplyValueMinor` (taxable base per code) is in scope for this phase, or a tax-amounts-only report is sufficient for now with supply-value breakdown deferred. Recommendation: include it — it costs nothing extra to compute (same `GROUP BY`) and a tax report without any visible base amount is of limited practical use even internally.
3. **Unclassified (legacy, no-`tax_code_id`) tax handling** (§7, §10): roll into `unclassifiedOutputTaxMinor`/`unclassifiedInputTaxMinor` headline figures (recommended) vs. exclude entirely from all totals vs. reject/error if any exist within the reporting window. Recommendation: roll up and surface, never silently drop or hard-fail — a real business will have legacy/manual tax entries and the report must still balance.
4. **GL cross-check section** (§6.3, §6.4): include as part of this phase (recommended, low incremental cost given the AP/AR reconciliation-report pattern already exists to copy) vs. defer to a later phase as a separate "VAT/GL Reconciliation" report mirroring `ap-gl-reconciliation`/`ar-gl-reconciliation`'s own separate-endpoint precedent.
5. **Overridden-tax-line semantics** (§7): report the authoritative (possibly overridden) `tax_amount_minor` (recommended — matches what actually posted) vs. also surfacing the calculated `tax_amount_calculated_minor` as a secondary column so a reviewer can see where actual collected/paid tax diverged from the system's own calculation. Recommendation: include both columns in the per-tax-code breakdown (`netTaxMinor` = authoritative, an additional `netCalculatedTaxMinor` alongside it) — this is exactly the kind of divergence a VAT position report exists to surface, and the calculated figure is already stored, so there is no cost to exposing it.
6. **Roadmap documentation hygiene** (§1): the stale "Financial Reporting — PARTIAL" paragraph in `docs/roadmap.md` should be corrected to reflect that P&L/Balance Sheet/AP-AR ageing/reconciliation/statement reports are already COMPLETE, independent of and prior to Phase 4 implementation — flagged here since it was discovered during this task, not to be silently fixed without confirmation given it touches a document under this repository's change-control discipline.

None of these block writing this discovery document; all six should be resolved (or explicitly deferred with a stated reason) before implementation authorization, exactly as Phase 2's Decision 1 correction and Phase 3's re-confirmation of Phase 2's decisions were both resolved before their own implementation began.

## 12. Final readiness status

**READY.**

The architecture is fully understood, evidence-based, and requires zero new schema/migration — every fact in this document was verified directly against the live repository, the live (empty, dev-only) database, and the actual GitHub `main` ref during this session, not assumed from prior context or stale documentation. The six items in §11 are ordinary scope/shape decisions of the same kind and size Phase 2's Decision 1 and Phase 3's confirmation both already were — they do not represent an architecture conflict, a missing capability, or a blocked dependency. Implementation may proceed directly once §11 is resolved, following the same discovery → CTO decision → implementation → verification → push → completion-report chain used for Phases 2 and 3.
