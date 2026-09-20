# Tax/VAT Phase 3 — AR Tax Calculation — Architecture Discovery

**Date:** 2026-09-11
**Author:** Claude (Senior Engineer / discovery role, per `CLAUDE.md`)
**Work item:** Tax/VAT MVP Phase 3 — AR Tax Calculation (Customer Invoices, Customer Credit Notes)
**Status of this document:** Discovery only. **No implementation, schema change, migration, commit, or push has been performed.** This document records what exists, what changes are proposed, and which decisions require explicit CTO sign-off before implementation may begin.

---

## 1. Verified baseline

All claims below were checked directly against the repository and a live database, not inferred from prior agent reports.

- **Local `main` == `origin/main` == `6229bc6f01c532e5ebb30797c9ed040107d8591f`.** Confirmed via `git rev-parse HEAD`, `git fetch origin main`, `git rev-parse origin/main`, and `git rev-list --left-right --count origin/main...HEAD` → `0 0`. Working tree is clean except one pre-existing, unrelated untracked directory (`docs/hardening/`), left untouched.
- **Commit history confirms the claimed lineage:** `6229bc6` (Phase 2 completion report) → `ae4b073` (Tax/VAT Phase 2 — AP Tax Calculation) → `e5846cc` (Phase 1 roadmap update) → `dd6d135` (Tax/VAT MVP Phase 1) → three NOAH orchestrator commits (`563046e`, `878da4c`, `8021c36`) → `733c307` (Stage 1A).
- **`docs/roadmap.md`** (current, on disk) names Tax/VAT Phase 3 — AR Tax Calculation as the next Finance work item, explicitly **not yet discovered or authorized**, gated on "a separate CTO discovery/authorization prompt." This document is that discovery.
- **`docs/project/PROJECT_STATE.md`** is consistent with the roadmap: Phase 1 and Phase 2 complete and pushed, Phase 3 named as next and explicitly not yet discovered/authorized.
- **`docs/project/CURRENT_PHASE.md`, `docs/project/NEXT_TASK.md`, `docs/project/DECISIONS.md` are a _different, unrelated workstream_** (the NOAH orchestrator/Stage 1B track — `packages/orchestrator-validator`, `docs/orchestrator/`), not Finance. Per the governing instruction for this task ("Do not select Orchestrator/PR #25 or unrelated workstreams unless the authoritative project state explicitly requires it"), these three files are read and acknowledged but are **not applicable** to this Finance discovery and are not used to gate it. `docs/roadmap.md` and `docs/project/PROJECT_STATE.md`'s "Repository implementation state" section are the authoritative Finance-track sources, and both agree cleanly. `CLAUDE.md` itself still shows a stale `## Current orchestrator phase: Stage 1A` header, inconsistent with `NEXT_TASK.md`'s own Stage-1B-authorized state — noted as an observation in §15, but this is an orchestrator-track staleness outside this discovery's scope and is not touched here.
- **Live database inspection (`noryx_test`), not just code reading:**
  - `tax_codes` and `tax_rates` exist exactly as Phase 1 defined them, `tax_rates` still enforces `tax_rates_no_overlap` as a GiST `EXCLUDE` constraint over the half-open `daterange(effective_from, effective_to, '[)')`, and both are referenced by `supplier_bill_lines`/`supplier_debit_note_lines`'s `tax_code_id`/`tax_rate_id` FKs from Phase 2 — confirming Phase 2 is not just committed but actually applied to this database.
  - `customer_invoice_lines` and `customer_credit_note_lines` currently have **no** `tax_code_id`/`tax_rate_id`/`tax_amount_calculated_minor`/`tax_amount_overridden` columns — confirmed by direct `\d`. Phase 3 has not been started in any form.
  - Both tables carry the same `tenant_isolation` forced-RLS policy shape as `supplier_bill_lines` did pre-Phase-2, and a blanket (zero-exception, INSERT+UPDATE+DELETE) immutability trigger once their parent document is `POSTED`.
  - `drizzle.__drizzle_migrations` has 21 applied rows, consistent with the 19 files in `drizzle/migrations/*.sql` (`0000`–`0018`) plus a fixed +2 historical id offset present since before Phase 2 (not something this session introduced or needs to resolve) — the database is at the same migration head as the tracked migration files, with `0018_tax_vat_phase_2_ap_calculation` the latest applied.
- **Phase 1 APIs/schema/services are present and match the discovery-document contract used for Phase 2**, and Phase 2's AP implementation (`SupplierBillsService`, `SupplierDebitNotesService`, `TaxRatesService.resolveEffectiveRate()`, `calculateTaxAmountMinor()`, `TaxConfigurationModule`) is present, unmodified since its own commit, and is the direct pattern this discovery proposes reusing.

**Conclusion: the repository is in the expected, clean state to begin Phase 3 discovery. No architecture conflict was found between the roadmap's stated intent and the actual code.**

---

## 2. Current AR implementation

`services/sphere-finance/src/accounts-receivable/` is structurally a complete mirror of the AP sub-ledger, one document behind on tax:

| AP (post-Phase-2)                                                                        | AR (current, pre-Phase-3)                                                                   | Structural parity                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supplier_bills` / `supplier_bill_lines`                                                 | `customer_invoices` / `customer_invoice_lines`                                              | Exact mirror (header totals, `taxAmountMinor` per line, `paidMinor`/payment status, posting via direct `journal_entries`/`journal_lines` insert, `SELECT ... FOR UPDATE` transaction discipline)  |
| `supplier_debit_notes` / `supplier_debit_note_lines` / `supplier_debit_note_allocations` | `customer_credit_notes` / `customer_credit_note_lines` / `customer_credit_note_allocations` | Exact mirror — header-level many-to-many allocation against POSTED documents, full-allocation-required-to-post rule, no line-level linkage to the settled document                                |
| `TaxRatesService.resolveEffectiveRate()`                                                 | _(not yet consumed by AR)_                                                                  | Already generic — takes only `(tx, tenantId, legalEntityId, taxCodeId, onDate)`, no AP-specific logic                                                                                             |
| `calculateTaxAmountMinor()`                                                              | _(not yet consumed by AR)_                                                                  | Pure function, already generic                                                                                                                                                                    |
| `TaxConfigurationModule`                                                                 | _(not yet imported by AR)_                                                                  | Its own Phase 1 doc comment already states it is "a top-level sibling ... not owned by either sub-ledger ... tax codes/rates are shared configuration both AP and AR will reference in Phase 2/3" |

**`CustomerInvoicesService`** (`customer-invoices.service.ts`, 891 lines): `create()`/`update()`/`remove()`/`post()`/`list()`/`findOne()`, all `withTenant()`-scoped. `taxAmountMinor` is client-optional per line (`?? 0`), summed server-side into `taxMinor`, and posted as a single `Cr settings.taxOutputAccountId` journal line when `taxTotal > 0`. Resolution date field is `invoiceDate` (create-time) / `dto.invoiceDate ?? before.invoiceDate` (update-time, mirroring `SupplierBillsService`'s exact `documentDate` pattern from Phase 2).

**`CustomerCreditNotesService`** (`customer-credit-notes.service.ts`, 1079 lines): same CRUD/post shape, plus allocation handling that mirrors `CustomerReceiptsService`. Accounting polarity is the invoice's reversed (Dr revenue + Dr tax-output, Cr AR control). Allocations settle directly against `customerInvoices.paidMinor`/`paymentStatus` under multi-row `FOR UPDATE` lock in fixed ascending-id order. **Credit note lines have zero linkage to invoice lines** — a credit note's `lines` array is independently authored (its own accounts, amounts, tax), and `customerCreditNoteAllocations` is a separate table mapping `(creditNoteId, invoiceId) → allocatedAmountMinor` only. This is the exact same shape Phase 2 found for `supplier_debit_note_allocations` and is the direct basis for §8's recommendation.

**AR settings** (`ar_settings` table, `ArSettingsService`) already has `taxOutputAccountId` (nullable `uuid`, FK to `chart_of_accounts`), already validated and consumed by both `CustomerInvoicesService.post()` and `CustomerCreditNotesService.post()` today (`if (taxTotal > 0 && !settings.taxOutputAccountId) throw ...`). **No AR settings schema change is required for Phase 3** — this account was already wired by AR-1b/the Credit/Debit Notes work item, confirmed by direct code inspection, mirroring how `ap_settings.taxInputAccountId` was already wired before AP Phase 2.

**Tax code/rate model has no AP/AR partition.** `tax_codes.treatment` is `STANDARD | ZERO_RATED | EXEMPT` — a rate-treatment classification, not an input/output direction flag. `TaxCodesService`/`TaxRatesService` apply no AP-only or AR-only restriction anywhere. This means a single `taxCodeId` can already be (and after Phase 2, already is) referenced from an AP document; after Phase 3 the same code becomes referenceable from an AR document with no system-level separation between the two. This is a pre-existing Phase 1 characteristic, not something Phase 3 introduces — see §12 (Risks).

---

## 3. Exact affected files/modules

**New files:**

- `services/sphere-finance/drizzle/migrations/0019_tax_vat_phase_3_ar_calculation.sql` — additive migration (see §5).
- `services/sphere-finance/drizzle/migrations/meta/0019_snapshot.json` — drizzle-kit generated.

**Modified files:**

- `services/sphere-finance/src/db/schema.ts` — add 4 columns + 2 CHECK constraints to `customerInvoiceLines` and to `customerCreditNoteLines` (8 columns/4 constraints total), identical shape to Phase 2's `supplierBillLines`/`supplierDebitNoteLines` additions.
- `services/sphere-finance/drizzle/migrations/meta/_journal.json` — new `0019` entry.
- `services/sphere-finance/src/accounts-receivable/customer-invoices/dto/create-customer-invoice-line.dto.ts` — add optional `taxCodeId` (`@IsOptional() @IsUUID()`), mirroring `CreateSupplierBillLineDto`.
- `services/sphere-finance/src/accounts-receivable/customer-invoices/dto/create-customer-invoice-line.dto.spec.ts` — new tests mirroring Phase 2's 3 additions (accepts well-formed `taxCodeId`, rejects non-UUID, accepts with override `taxAmountMinor`).
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/dto/create-customer-credit-note-line.dto.ts` — same `taxCodeId` addition.
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/dto/create-customer-credit-note-line.dto.spec.ts` — same 3 new tests.
- `services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.module.ts` — add `TaxConfigurationModule` to `imports`.
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.module.ts` — same.
- `services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.service.ts` — inject `TaxRatesService`; add `resolveLineTax()`; route `create()`/`update()` through it before `computeTotals()`/`insertLines()`, exactly mirroring `SupplierBillsService`'s Phase 2 shape.
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts` — same, using `creditNoteDate` and, critically, **never** reading `dto.allocations`/invoice data inside `resolveLineTax()` (§8).
- `services/sphere-finance/test/customer-invoices.e2e-spec.ts` (currently 1139 lines) — new `describe("Tax calculation — Tax/VAT Phase 3", ...)` block, mirroring Phase 2's `supplier-bills.e2e-spec.ts` addition (10 tests there).
- `services/sphere-finance/test/customer-credit-notes.e2e-spec.ts` (currently 1638 lines) — new mirror block, mirroring Phase 2's `supplier-debit-notes.e2e-spec.ts` addition (9 tests there), including the cross-invoice independence test (§8).
- `docs/roadmap.md`, `docs/project/PROJECT_STATE.md` — Phase 3 status update, after implementation (not part of discovery).

**Explicitly NOT touched (verified, not assumed):**

- `packages/db-core` — `gt`/`lt` already exported (Phase 2); no new operators needed.
- `services/sphere-finance/src/tax-configuration/*` — `TaxCodesService`, `TaxRatesService`, `calculateTaxAmountMinor()`, `TaxConfigurationModule` are already generic and require zero changes to serve AR.
- Any controller — no new routes; `taxCodeId` rides inside the existing line-array body of existing `POST`/`PATCH` endpoints, identical to Phase 2.
- `src/route-role-matrix.spec.ts` — already discovers and covers `CustomerInvoicesController`/`CustomerCreditNotesController`'s existing routes; no route added, so no update needed (verified: 135 assertions unaffected by Phase 2's identical no-new-route change).
- `ar_settings` schema/service — `taxOutputAccountId` already exists and is already consumed by both services' `post()`.
- Any RLS policy, immutability trigger, or GL-posting logic.

---

## 4. Proposed data flow

Identical shape to Phase 2, applied to the AR side:

1. Client `POST /invoices` (or `POST /credit-notes`) with a `lines[]` array where each line **may** include `taxCodeId`.
2. Inside the existing `withTenant()` transaction, before totals are computed: for each line with `taxCodeId` set, call `TaxRatesService.resolveEffectiveRate(tx, tenantId, legalEntityId, taxCodeId, documentDate)`, where `documentDate` is `dto.invoiceDate` / `dto.creditNoteDate` (create) or `dto.invoiceDate ?? before.invoiceDate` / `dto.creditNoteDate ?? before.creditNoteDate` (update, full-line-array-replace).
3. `resolveEffectiveRate()` validates the code's tenant/legal-entity scope and `isActive`, then resolves the single covering `tax_rates` row by the half-open date range; throws 400 on no code, inactive code, or no covering rate — never silently "no tax."
4. `calculateTaxAmountMinor(amountMinor, rate.rateBasisPoints)` computes the calculated tax.
5. Override resolution (identical to Phase 2 Decision 4 — see §7): client `taxAmountMinor` present and different from/alongside `taxCodeId` → override; `taxCodeId` alone → calculated value becomes `taxAmountMinor`; `taxCodeId` omitted → 100% legacy.
6. `taxRateId` (immutable FK to the resolved `tax_rates` row) and `taxAmountCalculatedMinor` are snapshotted onto the line at write time — never re-resolved at posting.
7. `computeTotals()`/`insertLines()` proceed exactly as today, now reading a `ResolvedCustomerInvoiceLine[]`/`ResolvedCustomerCreditNoteLine[]` shape instead of the raw DTO array — same refactor pattern Phase 2 applied to `SupplierBillsService`/`SupplierDebitNotesService`.
8. `post()` is **unchanged** — it still sums `taxAmountMinor` per line into the single `Cr taxOutputAccountId` (invoices) / `Dr taxOutputAccountId` (credit notes) journal line. No posting-time tax re-resolution, matching Phase 2's explicit non-goal.

---

## 5. Schema/migration changes

Additive only, migration `0019_tax_vat_phase_3_ar_calculation.sql`, structurally identical to `0018_tax_vat_phase_2_ap_calculation.sql`:

```sql
ALTER TABLE customer_invoice_lines
  ADD COLUMN tax_code_id uuid REFERENCES tax_codes(id),
  ADD COLUMN tax_rate_id uuid REFERENCES tax_rates(id),
  ADD COLUMN tax_amount_calculated_minor bigint,
  ADD COLUMN tax_amount_overridden boolean NOT NULL DEFAULT false;

ALTER TABLE customer_invoice_lines
  ADD CONSTRAINT customer_invoice_lines_tax_overridden_requires_code
    CHECK (tax_amount_overridden = false OR tax_code_id IS NOT NULL),
  ADD CONSTRAINT customer_invoice_lines_tax_rate_requires_code
    CHECK (tax_rate_id IS NULL OR tax_code_id IS NOT NULL);

-- identical block for customer_credit_note_lines
```

(Declared in `schema.ts` via the standard `check()` helper, same as Phase 2 — not via `drizzle/constraints/*.sql`, which is reserved for constraints Drizzle's DSL cannot express, such as `EXCLUDE`/triggers.)

**No RLS policy change, no immutability-trigger change.** Verified directly: both tables' existing `tenant_isolation` policy and blanket immutability trigger reference no column list — they gate by `tenant_id`/parent status only, so the new nullable columns are automatically covered, identical to Phase 2's finding for the AP tables.

**Deployment implications:** zero-downtime additive migration, same class as Phase 2's — no backfill, no default-value rewrite of existing rows beyond `tax_amount_overridden`'s `NOT NULL DEFAULT false` (a metadata-only operation on Postgres for a boolean column with a constant default), no lock escalation beyond the brief `ALTER TABLE` DDL lock already accepted for Phase 2.

---

## 6. API/DTO changes

- `CreateCustomerInvoiceLineDto` / `CreateCustomerCreditNoteLineDto`: add `@IsOptional() @IsUUID() taxCodeId?: string;` — the only new field, on the line DTOs only. No header DTO change (`CreateCustomerInvoiceDto`, `CreateCustomerCreditNoteDto`, both `Update*Dto`s, and `CreateCustomerCreditNoteAllocationDto` are all untouched).
- No new routes, no new controllers, no response-shape addition beyond the 4 new columns appearing on returned line objects (additive, non-breaking for existing clients that don't read them).
- `taxAmountMinor` remains present and required-in-meaning on every line DTO exactly as today — Phase 3 does not remove or relax it.

---

## 7. Tax calculation/resolution semantics

Identical to Phase 2, by direct reuse of the same shared code — **no new calculation or resolution logic needs to be written**, only wired:

- **Resolution timing:** at line-write time (create, or full-array-replace update) inside the existing transaction — never at posting time. Same as Phase 2 (§4).
- **Resolution date:** the document's own transaction date (`invoiceDate` / `creditNoteDate`) — never posting date.
- **Rounding:** `calculateTaxAmountMinor(amountMinor, rateBasisPoints) = Math.round((amountMinor * rateBasisPoints) / 10000)` — the existing Phase 2 function, reused unmodified. No new rounding edge case is introduced by AR; the function is already amount/rate-generic.
- **Snapshot:** immutable `taxRateId` FK to the resolved `tax_rates` row — same rationale (`tax_rates` is create-only/immutable).
- **Override semantics (Decision 4, reused verbatim):**
  - `taxCodeId` omitted → 100% legacy: `taxAmountMinor` = client value or 0; `taxRateId`/`taxAmountCalculatedMinor` null; `taxAmountOverridden = false`.
  - `taxCodeId` supplied alone → `taxAmountMinor` = calculated value; `taxAmountOverridden = false`.
  - `taxCodeId` + explicit `taxAmountMinor` both supplied → the supplied value is authoritative in `taxAmountMinor`; `taxAmountCalculatedMinor` retains the calculated value; `taxAmountOverridden = true`.
- **Legacy preservation:** identical guarantee — omitting `taxCodeId` reproduces exactly today's AR behavior, byte-for-byte.

---

## 8. Credit-note treatment — the one decision requiring explicit confirmation

**Recommendation: customer credit note lines must resolve tax entirely independently per line, using only `creditNoteDate` — never inherited from any allocated invoice.** This is not a new architectural question; it is the identical shape Phase 2 already resolved for supplier debit notes, and the underlying data model is verified identical:

- `customer_credit_note_allocations` is a **header-level, many-to-many** table: `(creditNoteId, invoiceId) → allocatedAmountMinor`, with **no** column or relationship connecting a `customer_credit_note_lines` row to any specific `customer_invoice_lines` row.
- A single credit note can allocate across multiple invoices (proven pattern already exists for receipts/`customerReceiptAllocations`; nothing in the schema prevents the analogous case for credit notes).
- There is therefore no well-defined "the invoice line this credit-note line corrects" to inherit a tax code/rate from — exactly the reasoning the CTO confirmed for supplier debit notes in Phase 2 (`docs/finance-work-item-tax-vat-phase-2-discovery.md` §13): "a debit note has no single 'original document' and no line-level linkage to any bill line."

Because this is a direct structural analogy to an already-CTO-confirmed decision, **not** a novel one, this discovery recommends carrying the identical decision forward rather than re-litigating it from first principles. It is nonetheless listed as requiring explicit confirmation in §13 (not silently assumed), because it has real GL/tax-reporting impact and the charter's discovery discipline treats every such decision as requiring sign-off, precedent or not.

`resolveLineTax()` on `CustomerCreditNotesService` must, by construction, take only `(tx, tenantId, legalEntityId, creditNoteDate, lines)` — it must never receive or read `dto.allocations`, mirroring `SupplierDebitNotesService.resolveLineTax()`'s exact signature. The Phase 2 e2e suite proved this end-to-end with a debit note allocating across two different bills, both resolving independently; the equivalent AR test (a credit note allocating across two different invoices, two tax-coded lines resolving to two different codes/rates) is specified in §11 and is the primary proof obligation for this decision.

---

## 9. RLS/RBAC/immutability/audit impact

**None**, verified directly (not assumed):

- **RLS:** `customer_invoice_lines`/`customer_credit_note_lines`'s `tenant_isolation` policy (`USING` clause keys only on `tenant_id`) automatically covers new nullable columns — confirmed via live `\d` inspection.
- **RBAC:** no new routes are added; `taxCodeId` travels inside the existing `lines[]` body of `POST /invoices`, `PATCH /invoices/:id`, `POST /credit-notes`, `PATCH /credit-notes/:id`, all already gated to `finance.poster` in `src/route-role-matrix.spec.ts` (confirmed present, lines 514–611). The regression suite's 135 RBAC-matrix assertions require no update, same as Phase 2.
- **Immutability:** both line tables' triggers (`prevent_posted_customer_invoice_line_mutation`, `prevent_posted_customer_credit_note_line_mutation`) gate purely on parent-document `status`, with no column enumeration — confirmed via direct trigger-function SQL inspection (§1). New columns are automatically covered with zero SQL change.
- **Audit:** `create`/`update`/`remove`/`post` already write full `beforeState`/`afterState` audit rows via `afterState: full as unknown as Record<string, unknown>` — the new columns are captured automatically since the audit payload is the whole row object, not an enumerated field list.

---

## 10. Posting/accounting impact

**None.** `CustomerInvoicesService.post()` and `CustomerCreditNotesService.post()` both already compute `taxTotal = before.lines.reduce((sum, l) => sum + l.taxAmountMinor, 0)` and post a single tax journal line from that sum — this logic is untouched by Phase 3, exactly mirroring Phase 2's finding for AP posting. `taxAmountMinor` remains the single authoritative posted amount regardless of how it was derived (legacy, calculated, or overridden). No change to the journal line count, the account resolution (`settings.taxOutputAccountId`), the credit-note reversed-polarity treatment, or the invoice `paidMinor`/`paymentStatus` settlement logic.

---

## 11. Test strategy

Mirrors Phase 2's proven structure exactly, scaled for AR's two documents:

- **Unit:** no new unit-test surface needed — `calculateTaxAmountMinor()` already has 8 passing unit tests and is reused unmodified.
- **DTO validation:** 3 new tests each for `create-customer-invoice-line.dto.spec.ts` and `create-customer-credit-note-line.dto.spec.ts` (accepts well-formed `taxCodeId`, rejects non-UUID, accepts with override `taxAmountMinor`) — 6 total, mirroring Phase 2's DTO spec additions exactly.
- **E2E — `customer-invoices.e2e-spec.ts`:** new `describe("Tax calculation — Tax/VAT Phase 3", ...)` block, mirroring Phase 2's `supplier-bills.e2e-spec.ts` 10-test suite: legacy behavior preserved; calculation with/without override; inactive/no-rate/cross-legal-entity `taxCodeId` rejection (400); independent multi-line resolution with two different tax codes; half-open boundary resolution + historical snapshot survives a later re-GET; posting unaffected with mixed calculated/overridden lines; DB-level CHECK constraint enforcement against a raw-SQL insert bypassing the service layer.
- **E2E — `customer-credit-notes.e2e-spec.ts`:** new mirror block, mirroring Phase 2's `supplier-debit-notes.e2e-spec.ts` 9-test suite, **plus** the decision-proving test from §8: a single credit note allocating across two different POSTED invoices, with two tax-coded lines resolving to two different tax codes/rates entirely independently of either invoice's own data — the direct AR analogue of Phase 2's "two different bills" debit-note test, and the primary evidence Phase 3's implementation must produce before it can claim the §8 decision is correctly implemented.
- **Regression:** full existing suite must be re-run and pass unchanged (Phase 2 baseline: 583/583 unit, 829/829 e2e, 135/135 RBAC-matrix, typecheck/lint clean) plus the ~19 new tests above, targeting parity with Phase 2's own final numbers (Phase 2 added 34 new tests total: 8 unit + 6 DTO + 10 + 9 e2e — one calculation-module unit suite short, since `calculateTaxAmountMinor()` needs no new unit tests here).
- **DB-level verification:** re-run (not re-derive) the same class of direct `\d`/psql checks used in this discovery and in Phase 2, confirming the new columns, constraints, and continued RLS/trigger coverage post-migration.

---

## 12. Risks/dependencies

- **No new technical risk beyond what Phase 2 already accepted and verified** — the calculation function, the resolution method, the snapshot mechanism, and the override semantics are all reused unmodified, not reimplemented. The primary residual risk is process risk (implementing the AR mirror without preserving some Phase 2 subtlety), not design risk.
- **Shared tax-code master data has no AP/AR direction partition** (§2). After Phase 3, the same `taxCodeId` becomes selectable on both a bill line (input/expense-side) and an invoice line (output/revenue-side) with no system-level restriction preventing a user from picking a semantically wrong code for the document type. This is a **pre-existing Phase 1 characteristic inherited by Phase 3, not a new risk Phase 3 introduces** — Phase 2 already exhibits the identical characteristic on the AP side today, and Phase 1's `tax_codes.treatment` enum (`STANDARD`/`ZERO_RATED`/`EXEMPT`) was deliberately scoped as a rate-treatment classification, not a direction flag. Recorded here as an operational/UX observation for a future phase to consider (e.g., a `direction` or `applicability` field), not a blocker for Phase 3.
- **Dependency: none new.** `TaxConfigurationModule`, `TaxRatesService`, `calculateTaxAmountMinor()`, and the `gt`/`lt` db-core exports Phase 2 added are all already in place and require no changes.
- **Migration risk:** low — additive-only, same class already executed cleanly for Phase 2 against this same database.
- **Credit-note cross-invoice independence (§8) is the one area with real financial/reporting consequence** if implemented incorrectly (e.g., a bug that accidentally reads `dto.allocations` inside `resolveLineTax()`) — mitigated by mirroring Phase 2's proven method signature exactly and by the dedicated cross-invoice test in §11 being a hard requirement, not optional coverage.

---

## 13. Explicit architecture decisions required

Per the governing instruction, these are surfaced for explicit CTO confirmation before implementation, not silently assumed — even where, as here, every one of them is a direct structural analogy to an already-confirmed Phase 2 decision:

1. **Customer Invoices:** `taxCodeId` → resolve effective tax rate by `invoiceDate` → calculate/snapshot rate → preserve existing `taxAmountMinor`/posting behavior. _(Direct analogy to Phase 2 Supplier Bills.)_
2. **Customer Credit Notes:** do **NOT** inherit tax from allocated invoices. Resolve tax independently per line using `taxCodeId` and `creditNoteDate`, because credit notes have header-level many-to-many invoice allocations and no line-level source linkage — verified identical to the debit-note data model Phase 2 already confirmed this decision for. _(Direct analogy to Phase 2 Supplier Debit Notes / the Decision 1 correction.)_
3. **Preserve line-level rounding and existing legacy behavior when `taxCodeId` is omitted** — reuse `calculateTaxAmountMinor()` and the override semantics unmodified. _(Direct analogy to Phase 2 Decisions 3–5.)_
4. **Preserve existing GL posting, totals, RLS, RBAC, and blanket post-immutability** — no posting-time tax re-resolution, no schema change beyond the additive columns/constraints in §5. _(Direct analogy to Phase 2's non-goals.)_
5. **Reuse `TaxConfigurationModule`/`TaxRatesService`/`calculateTaxAmountMinor()` via DI from `CustomerInvoicesModule`/`CustomerCreditNotesModule`, unmodified** — no new shared-logic module, no duplication. _(Extends Phase 1's own stated intent that this module serves both AP and AR.)_

No conflict was found between any of these and the actual data model — every one is directly supported by verified schema/service evidence in §1–§10. This is not a case of an approved decision conflicting with reality; it is a case of an unauthorized-but-architecturally-clean next step awaiting the same explicit authorization Phase 2 received.

---

## 14. Recommended implementation sequence

Mirrors Phase 2's own successful sequence:

1. Schema: add the 8 columns / 4 CHECK constraints (§5) to `schema.ts`; generate, review, rename, and apply migration `0019`.
2. DTOs: add `taxCodeId` to both line-create DTOs; DTO spec tests.
3. Module wiring: import `TaxConfigurationModule` into `CustomerInvoicesModule`/`CustomerCreditNotesModule`.
4. Service implementation: `CustomerInvoicesService` first (simpler — no allocations), then `CustomerCreditNotesService` (verify the §8 independence property explicitly as it's written, not just via the eventual test).
5. E2E test suites for both documents, including the §8 cross-invoice independence test as a first-class required case, not an afterthought.
6. Full regression (unit/e2e/RBAC-matrix/typecheck/lint), DB-level constraint/RLS/immutability re-verification.
7. Roadmap/`PROJECT_STATE.md` update, commit, push, push verification, completion report — same discipline as Phase 2.

---

## 15. Discovery status: **READY**

No architecture conflict, no missing Phase 1/2 dependency, no stale contradiction in the Finance-track documentation (`docs/roadmap.md`, `docs/project/PROJECT_STATE.md`) blocks this work. Every proposed change in §3–§10 is a direct, verified structural mirror of Phase 2's already-implemented, already-tested, already-pushed pattern, applied to a data model confirmed identical in the relevant respects (§1–§2). The only items requiring action before implementation begins are the explicit decision confirmations in §13 — each a restatement of an already-confirmed Phase 2 precedent applied to the AR side, not a new open architectural question.

**Minor observations, not blockers (do not require resolution before implementation):**

- `CLAUDE.md`'s `## Current orchestrator phase` header still reads `Stage 1A`, inconsistent with `docs/project/NEXT_TASK.md`'s Stage-1B-authorized state. This is an orchestrator-track document, outside Finance scope and outside this discovery's mandate to touch ("do not make unrelated changes") — flagged for NOAH's own workstream, not corrected here.
- The original "CTO-approved architecture proposal" for the Tax/VAT MVP referenced in Phase 1 code comments (`tax-rates.service.ts`, `schema.ts`) does not exist as a committed file under `docs/` (only `docs/finance-work-item-tax-vat-phase-2-discovery.md` and its completion report do). This does not block Phase 3 discovery, since Phase 1/2's actual implementation is independently and directly verifiable in the schema/code/database, but is noted for documentation-trail completeness.
- §12's tax-code direction-partition observation is carried forward for awareness, not as a Phase 3 blocker.

**This document does not authorize implementation.** Per the operating contract, Phase 3 implementation begins only after CTO review of §13 and an explicit authorization instruction, exactly as Phase 2's did.
