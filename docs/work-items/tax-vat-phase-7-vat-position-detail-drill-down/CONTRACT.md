# Contract: TAX-VAT-PHASE-7-VAT-POSITION-DETAIL-DRILL-DOWN

**Status: FINAL SPECIFICATION / CONTROL ARTIFACT — hardened and frozen for implementation under "NORYX CTO MASTER EXECUTION AUTHORIZATION" (this session).** This document freezes the business/accounting semantics for Tax/VAT Phase 7 so implementation cannot reinterpret them. It contains no production code and prescribes no internal code structure beyond what is required to guarantee the invariants below.

Per `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md`'s controlled lifecycle: this document was produced at the **PROPOSAL** stage; this pass performs the CTO-directed **Phase 1: Final Specification Hardening** step and, on passing its own verification gate, treats the work item as cleared into **CLAUDE IMPLEMENTATION + VERIFICATION** for the remainder of this same authorized execution. The established convention for the `CONTRACT.md`/`ACCEPTANCE.md` file names comes from prior Finance work items' own practice (e.g. `docs/work-items/budgeting-phase-1-foundation/`, `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/`).

**Phase 1 hardening pass (this pass):** three further corrections applied on top of the prior hardening pass — (1) §9's deterministic-ordering invariant no longer relies on `sourceLineId` alone as a cross-table-unique tie-breaker; `sourceType` is now a mandatory intermediate ordering column, and the claim of `sourceLineId`'s global cross-table uniqueness is withdrawn. (2) ACCEPTANCE.md's DRILL-032 is rewritten as a behavioral snapshot-isolation test rather than code-level inspection. (3) §11A is clarified that `reconciliationTotals` equals the **complete filtered result** for the request's scope, and is explicitly **not** expected to equal the sum of a single page's rows when the result spans multiple pages (new ACCEPTANCE.md DRILL-039 exercises this distinction). Fourteen further hardening clarifications (canonical source date, detail eligibility, reconciliation identity, zero-result behavior, pagination validation, database-side pagination, `UNION ALL` composition, security scope, read-only guarantee) are folded into the relevant sections below. No frozen decision from the prior pass (§4's Option A scope, §7's polarity table, §10/§11's A/B splits) was reopened — repository evidence did not require it.

## 0. Work Item Identity

- **ID:** TAX-VAT-PHASE-7-VAT-POSITION-DETAIL-DRILL-DOWN
- **Product area:** Sphere Finance → Tax/VAT
- **Candidate origin:** discovery proposal "Tax/VAT Extension — Next Finance Work Item" (this session), recommended Candidate 2, unchanged and not re-derived or replaced by this pass.
- **Authoritative baseline SHA:** `2bcb13130eb322cf5810410c0e3ffe06e8f0d8e6` (verified: `git fetch origin main` → identical; `git log --oneline -1` on a fresh worktree checked out at this SHA → `2bcb131`).

## 1. Phase Identity

**Tax/VAT Phase 7 — VAT Position Detail / Source-Document Drill-Down Report (Tax-Contribution Scope).** The work-item name and candidate are unchanged from the discovery proposal; this contract freezes its scope precisely to the tax-contribution figure only (§4).

## 2. Objective

Expose, read-only, the individual persisted tax-bearing source lines whose **tax contribution** composes the existing VAT Position Report's (`GET /tax-reports/vat-position`, Phase 4/5/6) per-tax-code `netTaxMinor` (and its `manualTaxMinor` sub-component) — no new tax logic, no new accounting behavior, no change to how tax is calculated, validated, or posted anywhere.

## 3. Verified Current-State Evidence (re-confirmed this pass, not re-derived from scratch)

- `TaxReportsService.getVatPosition()` and `GeneralLedgerService.getLedger()` both run their full body inside one `withTenant(tenantId, callback, undefined, REPORT_TX_CONFIG)` transaction, `REPORT_TX_CONFIG = { isolationLevel: "repeatable read", accessMode: "read only" }`.
- `GeneralLedgerService.fetchLedgerPage()` — the repository's only existing paginated Finance read query — orders `ORDER BY je.transaction_date ASC, je.journal_number ASC, jl.line_number ASC` before `LIMIT/OFFSET`, and its `countLedgerLines()`/`fetchLedgerPage()` both run inside the same transaction as each other.
- `LedgerQueryDto` is the repository's only existing pagination DTO: `page` (default 1, `@IsInt`, `@Min(1)`), `pageSize` (default 50, `@IsInt`, `@Min(1)`, `@Max(200)`).
- No cross-request/cross-transaction snapshot or cursor mechanism (`pg_export_snapshot`, `SET TRANSACTION SNAPSHOT`, a keyset/cursor token, txid pinning) exists anywhere in this repository — confirmed by a repository-wide search this pass. No such mechanism is introduced by this contract (§10).
- `TaxReportsService.codeRows()`/`totalTax()` (AP/AR) exclude an entire document's tax lines when its own `journal_entries.reversed_by_journal_entry_id IS NOT NULL` (Document-Level Reversal work item). `TaxReportsService.manualTaxRows()` (manual journal, Phase 6) applies no such exclusion — a reversal is a second, independent POSTED `journal_lines` row that nets to zero only via signed-sum arithmetic. Both mechanisms are reused unmodified (§7).
- Every AP/AR document table carries `internalReference`; `journal_entries` carries the analogous `journal_number`. Both are reused for source-document identity (§6).
- `VatPositionCodeRow` (existing) has `netSupplyValueMinor`, `netTaxMinor`, `netCalculatedTaxMinor`, `manualTaxMinor`. Manual-journal rows hardcode `netSupplyValueMinor: 0` and `netCalculatedTaxMinor == netTaxMinor` (Phase 6, frozen decision — manual lines have no base/supply-value concept). This is the direct evidence for §4's scope decision.

## 4. Exact Functional Boundary — Scope Decision (Correction 3, FROZEN)

**Phase 7 is a TAX-CONTRIBUTION DRILL-DOWN (Option A).** Source rows reconcile to `netTaxMinor` (and its `manualTaxMinor` sub-component) only.

**Explicitly NOT in scope:** reconciliation of `netSupplyValueMinor` or `netCalculatedTaxMinor` at line grain. Reasoning, frozen here and not reopened at implementation time:

1. Manual journal lines structurally have no supply/base-value concept — this is a Phase-6-frozen decision (`netSupplyValueMinor: 0` for manual rows), not an oversight this phase should "fix." Reconciling supply value at line grain would require inventing a manual-journal supply-value semantic that does not exist in the approved architecture — exactly the "Manual Journal Line Supply-Value Capture" candidate (Candidate 3) the original discovery proposal ranked below this one and explicitly did not select.
2. `netCalculatedTaxMinor` differs from `netTaxMinor` only through AP/AR's calculated-vs-overridden mechanism; exposing it at line grain would require also exposing an override flag per line — a related but separate reporting decision with no evidenced need from the discovery.
3. The tax amount (`netTaxMinor`) is the figure the entire VAT Position Report chain (Phases 4–6) has been built around and the figure a VAT return/audit actually needs traced to source — the correct, minimal, evidenced scope for a drill-down.

## 5. Data / Source Model

Unchanged from the specification proposal — five source-line tables:

| Source type | Line table | Parent table | Parent FK | Date column | Reference field | Direction |
| --- | --- | --- | --- | --- | --- | --- |
| `SUPPLIER_BILL` | `supplier_bill_lines` | `supplier_bills` | `bill_id` | `bill_date` | `internal_reference` | INPUT |
| `SUPPLIER_DEBIT_NOTE` | `supplier_debit_note_lines` | `supplier_debit_notes` | `debit_note_id` | `debit_note_date` | `internal_reference` | INPUT (contra) |
| `CUSTOMER_INVOICE` | `customer_invoice_lines` | `customer_invoices` | `invoice_id` | `invoice_date` | `internal_reference` | OUTPUT |
| `CUSTOMER_CREDIT_NOTE` | `customer_credit_note_lines` | `customer_credit_notes` | `credit_note_id` | `credit_note_date` | `internal_reference` | OUTPUT (contra) |
| `MANUAL_JOURNAL` | `journal_lines` | `journal_entries` | `journal_entry_id` | `transaction_date` | `journal_number` | INPUT or OUTPUT, per `tax_direction` |

No new table, no new column, no migration.

## 6. Result-Row Semantics

**One detail row = one persisted tax-bearing source line** contributing to `netTaxMinor` — never one row per document, one row per tax code, or an aggregated result. A document with N tax-tagged lines produces N detail rows. Every row carries: `sourceType`, `sourceDocumentId`, `sourceLineId` (the line's own primary key — the mandatory ordering tie-breaker, §9), `sourceDocumentReference` (`internalReference` or `journal_number`), `sourceDocumentDate`, `taxCodeId`, `code`, `direction`, `signedTaxContributionMinor` (§7).

## 7. Tax Polarity Semantics

Frozen exactly as verified in `codeRows()`/`totalTax()`/`manualTaxRows()`, reused unmodified — no new polarity rule:

| Source type | `signedTaxContributionMinor` | Reversal handling |
| --- | --- | --- |
| `SUPPLIER_BILL` (INPUT, primary) | `+tax_amount_minor` | Row omitted entirely if the bill's journal entry has `reversed_by_journal_entry_id IS NOT NULL` — full-document exclusion, no negative counterpart row exists. |
| `SUPPLIER_DEBIT_NOTE` (INPUT, contra) | `−tax_amount_minor` | Same exclusion rule, on the debit note's own journal entry. |
| `CUSTOMER_INVOICE` (OUTPUT, primary) | `+tax_amount_minor` | Same exclusion rule, on the invoice's own journal entry. |
| `CUSTOMER_CREDIT_NOTE` (OUTPUT, contra) | `−tax_amount_minor` | Same exclusion rule, on the credit note's own journal entry. |
| `MANUAL_JOURNAL`, `tax_direction = OUTPUT` | `credit_minor − debit_minor` | **Not excluded.** A reversal is a second, independent POSTED row (same `tax_code_id`/`tax_direction`, swapped debit/credit — Phase 6). Both rows appear; they net to zero only through the caller's own sum, never by omission. |
| `MANUAL_JOURNAL`, `tax_direction = INPUT` | `debit_minor − credit_minor` | Same as above. |

## 8. Date / Period Semantics

Identical to the existing VAT Position Report: `periodId` XOR (`dateFrom` AND `dateTo`), same `PeriodIdExcludesDateRangeConstraint` shape and service-layer "one or the other required" rule. An optional `taxCodeId` filter narrows the result to one code; omitted means all codes, matching the aggregate report's own all-codes behavior. Date column per source type per §5's table.

## 9. Pagination Model and Deterministic Ordering (Corrections 1 & 2, FROZEN)

**Pagination:** reuses `LedgerQueryDto`'s exact shape and exact validation bounds — `page` (default 1, `@IsInt`, `@Min(1)`), `pageSize` (default 50, `@IsInt`, `@Min(1)`, `@Max(200)`); `page < 1`, `pageSize < 1`, and `pageSize > 200` are all rejected with 400, identically to every other consumer of this DTO shape. No new pagination validation model is invented. `totalItems`/`totalPages` computed via `COUNT(*)` inside the same transaction as the page fetch, matching `getLedger()`'s own `meta` shape and formula (`totalPages = ceil(totalItems / pageSize)`) exactly.

**Zero-result behavior (Hardening Requirement 5, FROZEN).** A valid reporting scope containing zero qualifying tax-bearing source lines is not an error: the response is `200` with an empty `rows` array, `totalItems: 0`, pagination metadata computed by the same formula as any other count (following `getLedger()`'s own existing zero-row convention exactly — this contract does not invent a different zero-row shape), and an empty `reconciliationTotals` array (no `(taxCodeId, direction)` group exists to report on). No error may be raised merely because zero rows qualify.

**Database-side filtering, ordering, and pagination (Hardening Requirement 7, FROZEN).** Filtering, the §9 ordering, and `LIMIT`/`OFFSET` pagination **must** all be performed at the database/query layer, on the already-filtered-and-ordered union of all five source queries. The implementation **must not** load the complete five-source result set into application memory and then sort or slice it in JavaScript for pagination — this is a correctness requirement (it is also what makes the §9 ordering and §11A `reconciliationTotals` actually consistent with each other within one transaction), not merely a performance preference.

**Source composition via `UNION ALL` (Hardening Requirement 12, FROZEN).** The five per-source-type row-producing queries **must** be combined with SQL `UNION ALL`, never bare `UNION` — a bare `UNION` would silently deduplicate any two rows that happened to produce identical column values (e.g., two different lines with the same date, tax code, and contribution amount), directly violating §6's one-row-per-source-line guarantee and Hardening Requirement 8's uniqueness invariant below.

**Source-line uniqueness (Hardening Requirement 8, FROZEN).** Every qualifying persisted source line **must** appear in the detail result exactly once — no accidental duplication (e.g., from an unintended join fan-out against a one-to-many relation) and no accidental deduplication (e.g., from an incorrect `GROUP BY`, or from `UNION` instead of `UNION ALL` per the paragraph above).

**Deterministic ordering (frozen invariant, Correction 1 applied):** for an identical reporting scope (same `tenantId`/`legalEntityId`/date-window-or-`periodId`/optional `taxCodeId`) queried against an identical accounting snapshot, the complete ordered result set is deterministic — no row may move between pages merely because the database returned an unspecified order. The ordering **must** be exactly:

```
ORDER BY sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC
```

or an exactly equivalent total order. `sourceDocumentDate` is the **canonical source date** defined per source type by §5's "Date column" (`bill_date`, `debit_note_date`, `invoice_date`, `credit_note_date`, or `transaction_date` for `MANUAL_JOURNAL` — the same column each source type's row already carries, not a newly invented "period-equivalent" concept). `sourceType` is a fixed, small enumeration (`SUPPLIER_BILL`, `SUPPLIER_DEBIT_NOTE`, `CUSTOMER_INVOICE`, `CUSTOMER_CREDIT_NOTE`, `MANUAL_JOURNAL`, compared as text) and is now a **mandatory** intermediate ordering column, not optional. `sourceLineId` is the line's own primary-key UUID and remains the final tie-breaker — but this contract **withdraws** the prior pass's claim that a UUID primary key is "globally unique across all five source tables" as the basis for correctness: the five source tables are five **independent** UUID namespaces/sequences, and while a collision between two different tables' primary keys is astronomically unlikely with the platform's UUID generation, the ordering invariant must not depend on that assumption for its correctness. `sourceType` is therefore interposed **before** `sourceLineId` precisely so the total order is provably unambiguous (same date, different table) without relying on cross-table UUID uniqueness at all; `sourceLineId` only needs to be unique *within* its own table's rows for a fixed `sourceType`, which its role as that table's primary key already guarantees unconditionally.

Precedent: `fetchLedgerPage()`'s own `ORDER BY je.transaction_date ASC, je.journal_number ASC, jl.line_number ASC` establishes the identical shape (date first, increasingly specific identifiers, ending in a value unique within its own scope) — Phase 7 adapts this to a multi-source-table read by interposing the small, fixed `sourceType` enumeration before the line's own id, since no single per-document numbering scheme is shared across all five source tables and no single id column is safe to treat as unique across them.

## 10. Consistent-Read / Concurrency Semantics (Corrections 1 & 4, FROZEN)

Two distinct concepts, kept explicitly separate per the correction authorization's own instruction:

**(A) Within-request consistency (the accounting invariant this phase guarantees).** A single HTTP request's page of detail rows, its `totalItems` count, and its accompanying `reconciliationTotals` (§11) are all computed inside one `withTenant(tenantId, callback, undefined, REPORT_TX_CONFIG)` transaction (`REPEATABLE READ`, `READ ONLY` — identical config to `getVatPosition()`/`getLedger()`). Because that transaction's MVCC snapshot is fixed at its first query and held for its duration, every value returned in one response is guaranteed mutually consistent with every other value in that same response, regardless of concurrent posting activity elsewhere. No new locking is introduced — this is a read-only transaction acquiring no row locks. No new concurrency mechanism is invented; the existing repository mechanism is reused unmodified.

**(B) Across-request consistency (explicitly NOT guaranteed, and not to be implied).** No cross-request/cross-transaction snapshot or cursor mechanism exists anywhere in this repository (§3), and this contract does **not** introduce one — per the correction authorization's own instruction not to build server-side snapshot infrastructure the repository has no established pattern for. Therefore: walking pages `1..N` across **separate** HTTP requests does **not** guarantee that all pages were read against one single historical accounting snapshot; concurrent posting activity between two such requests can change what a later page reflects. This is not a new or additional limitation — it is the exact, pre-existing, already-accepted characteristic of `GET /accounts/:id/ledger`'s own pagination, restated explicitly here rather than left implicit. Complete-result reconciliation (§11) is therefore defined and provable **within one request**, never by summing across independently-issued page requests. **This is an intentional scope boundary of Phase 7, not a defect to be fixed here** — introducing cross-request/server-side snapshot or cursor infrastructure is explicitly out of scope (§19) and is not implied by any wording elsewhere in this contract.

## 11. Same-Snapshot Internal Reconciliation (Correction 4, FROZEN)

Two distinct invariants:

**(A) Internal accounting invariant (this phase's own correctness proof).** Every response includes, alongside its page of rows, a `reconciliationTotals` array — one entry per `(taxCodeId, direction)` present in the **complete filtered result** for that request's scope (not just the returned page), each giving `SUM(signedTaxContributionMinor)` for that code+direction, computed inside the exact same `REPORT_TX_CONFIG` transaction as the page's own rows. This is a same-snapshot, same-request value, not a separately-queried one, and is therefore always exactly consistent with the rows returned in that response, independent of `page`/`pageSize`. A test proves this invariant by requesting `pageSize` large enough to cover a fixture's complete result in one call and asserting `SUM(returned rows' signedTaxContributionMinor)` grouped by `(taxCodeId, direction)` equals that same response's `reconciliationTotals` — a strictly single-request, single-snapshot proof.

**(B) Regression comparison (a separate, weaker guarantee).** Phase 7's `reconciliationTotals`, for an identical scope, is additionally expected to agree with the existing, separately-queried aggregate `GET /tax-reports/vat-position` route's `netTaxMinor`/`manualTaxMinor`. This is a **cross-request** comparison between two independently-executed HTTP calls and therefore does **not** carry the same-snapshot guarantee of (A) — it is a regression/consistency check meaningful in a controlled test environment with no concurrent write activity between the two calls (the existing e2e test convention throughout this repository), not a runtime guarantee claimed for live concurrent production traffic. This contract does not claim, and acceptance must not test, (B) as if it were (A).

**Correction 3 (FROZEN): `reconciliationTotals` is the complete filtered result, never merely the current page.** `reconciliationTotals` is computed once per request over the request's **entire filtered result set** (every row matching the scope, across however many pages it would span), inside the exact same transaction/snapshot as the page fetch — it is not a per-page aggregate and it is not recomputed per page. Consequently, for a fixture whose complete filtered result spans more than one page at the request's `pageSize`, `SUM(that response's own page of rows)` is **not** expected to equal `reconciliationTotals` for the same `(taxCodeId, direction)` — only `SUM(the complete filtered result)` equals it. Treating a single page's sum as equivalent to `reconciliationTotals` on a multi-page result is an implementation or test error, not an acceptable simplification; ACCEPTANCE.md's DRILL-039 exercises this distinction directly, alongside DRILL-033's single-page-covers-everything case which alone would not catch this class of bug.

**Detail eligibility (Hardening Requirement 3, FROZEN).** A detail row is eligible if and only if its underlying persisted source line is eligible for the existing `getVatPosition()` calculation under the identical reporting scope — covering, per source type, the same posted/POSTED-only status check, the same reporting date/period resolution, the same tax-code-tagged (`tax_code_id IS NOT NULL`) requirement, the same reversal-state rule (§7), and the same tenant/legal-entity/source-specific inclusion-exclusion rules `codeRows()`/`manualTaxRows()` already apply. This contract creates **no second, independent interpretation of VAT eligibility** — the detail query's WHERE-clause predicates must be the same predicates the aggregate query already uses, restated at row grain (§20 already requires this at the implementation-constraint level; this paragraph states it as an accounting invariant).

**Reconciliation grouping identity (Hardening Requirement 4, FROZEN).** The accounting identity for every reconciliation total, in both (A) and (B), is the tuple `(taxCodeId, direction)` — never the human-readable tax `code` string alone. `code`/`name` are descriptive metadata carried on each row for display only. Two different `(taxCodeId, direction)` combinations that happen to render the same display `code` (this can occur if a tax code's INPUT and OUTPUT activity are both present) are never collapsed into one `reconciliationTotals` entry merely because their display code matches — INPUT and OUTPUT for what looks like "the same code" remain two separate entries, mirroring how `codeRows()`/`totalTax()` already key by `(tax_code_id, tax_direction)`, not by the code string.

## 12. Tenant Isolation

Every underlying source query filters `tenant_id = tenantId` explicitly on **both** the line table and its parent (document or journal entry) — defense-in-depth beyond the standard `tenant_isolation` RLS policy present on every source table — reusing `codeRows()`/`manualTaxRows()`'s own existing predicates verbatim, restated at row grain instead of aggregate grain. No new isolation model.

## 13. Legal-Entity Isolation

Every underlying source query filters `legal_entity_id = legalEntityId` explicitly on the parent (document or journal entry), matching every other Finance report's convention (never delegated to RLS, which is tenant-only and does not model legal-entity scoping at all).

## 14. RBAC

Identical to the existing VAT Position Report: `@Roles("finance.viewer", "finance.poster", "finance.admin")`, `JwtAuthGuard` + `RolesGuard`, `tenantId`/`legalEntityId` from `requireTenantContext(user, ...)` only (never a request param/body). No new role. No write-side RBAC — this capability performs no mutation.

## 15. API Boundary

A new read-only route (or an extension of the existing `GET /tax-reports/vat-position` route) accepting `periodId` XOR `dateFrom`/`dateTo`, optional `taxCodeId`, and `page`/`pageSize`; returning a page of detail rows (§6), pagination `meta` (§9), and `reconciliationTotals` (§11). Exact route path/shape (new endpoint vs. `detail=true` flag) is an implementation-design decision explicitly not frozen by this contract — the response's semantic content (§6, §7, §11) is what is frozen, not its exact transport shape.

## 16. Accounting Invariants

- No tax is calculated, recalculated, or re-derived by this phase — every value is read verbatim (or sign-adjusted per the already-existing §7 rules) from already-posted, already-validated source rows.
- No write path is touched — zero mutation, zero new posting behavior, zero new validation rule affecting what can be posted.
- §11(A) is this phase's own internal correctness proof; if it fails for any fixture, the implementation is wrong, not the invariant.
- An untagged (no `taxCodeId`) source line never produces a detail row — reuses the existing `tax_code_id IS NOT NULL` filter in `codeRows()`/`manualTaxRows()` unmodified.

## 17. Security Invariants

- No new authentication/authorization surface — reuses `JwtAuthGuard`/`RolesGuard`/`requireTenantContext` unmodified.
- No new data exposure beyond what the existing aggregate report already discloses in summed form — this phase reveals the same underlying facts at finer grain, to the same three roles that can already see the aggregate.
- **Security scope (Hardening Requirement 10, FROZEN):** every source query preserves tenant isolation (§12) and legal-entity isolation (§13) as unconditional predicates, never as an optional or bypassable filter. This endpoint accepts no `sourceDocumentId`/`sourceLineId` request parameter (§8's only filters are `periodId`/`dateFrom`/`dateTo`/`taxCodeId`); no such identifier may ever be introduced as a lookup path that resolves a source line without the same tenant/legal-entity predicates applied — an id-based lookup must never become an authorization bypass.
- **Read-only guarantee (Hardening Requirement 11, FROZEN):** this endpoint must not write to tax records, accounting records, journals, source documents, or reconciliation state, under any request — including error-path and boundary-value requests. No reporting-side audit-log write is introduced; the existing analogous routes (`getVatPosition()`, `getLedger()`) write no audit entry for a read, and this phase does not diverge from that unless a platform-wide requirement independently mandates one (none currently does).

## 18. Explicit In-Scope

Tax-contribution-grain detail rows (§4, §6) for all five source types (§5); pagination with deterministic ordering (§9); within-request consistent-read (§10A) with same-response reconciliation totals (§11A); tenant/legal-entity isolation (§12/§13); RBAC identical to the existing report (§14); date/period/tax-code filtering (§8); regression comparison against the existing aggregate report as a test-environment check (§11B, §21).

## 19. Explicit Out-of-Scope

Statutory VAT filing; jurisdiction-specific filing formats; reverse charge; multi-jurisdiction tax; tax-inclusive pricing; tax calculation changes; AP tax changes; AR tax changes; manual journal tax-posting changes; tax adjustments/new correction primitives; **supply-value capture and any `netSupplyValueMinor`/`netCalculatedTaxMinor` line-grain reconciliation (§4)**; FX/Multi-Currency; Fixed Assets; Expense Management; WIP/Accrual; broad Financial Reporting; AI features; UI work; any cross-request/server-side snapshot infrastructure (§10B); any change to the existing aggregate `GET /tax-reports/vat-position` route's response shape (additive/separate only).

## 20. Implementation Constraints

The detail-row query logic **must** be built from the same predicate-construction logic `codeRows()`/`manualTaxRows()` already use (shared/factored, not hand-duplicated), so that headline and detail can never silently drift apart through independent edits. The `REPORT_TX_CONFIG` transaction config **must** be reused unmodified, not redefined. The ordering invariant in §9 (`sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC`) is mandatory in full, including the `sourceType` column — it is no longer merely "date-first, id-last with free middle columns." Database-side filtering/ordering/pagination and `UNION ALL` composition (§9) are mandatory implementation constraints, not preferences. Route path, exact transport-level field names, and controller placement (Hardening Requirement 13) remain implementation-design decisions provided the frozen semantics above are preserved unchanged.

## 21. Regression Constraints

Full pre-existing unit and e2e suites (including `vat-position-report.e2e-spec.ts` and the Phase 6 suite) must pass unmodified. No existing route, DTO, service method, or response field of the aggregate `GET /tax-reports/vat-position` route may change shape, name, or meaning.

## 22. One-Phase Boundary

No foundation-vs-feature split exists: tax classification, calculation, posting, aggregation, reversal handling, isolation, consistent-read transactions, and pagination all already exist in this exact codebase (§3) and are reused, not built. This phase only restates already-proven query predicates at row grain instead of `SUM()`/`GROUP BY` grain, behind a read-only route.

## 23. Prohibited Scope Expansion

No actor may expand this contract's frozen scope (§4, §19) without a new, explicit CTO instruction. Implementation must not reinterpret §7's polarity table, §9's ordering invariant, §10's consistency split, or §11's reconciliation definitions — any perceived ambiguity encountered during implementation must STOP and surface to the CTO rather than being resolved unilaterally, per `NORYX_ENGINEERING_GOVERNANCE.md`'s Non-Inference Rule.
