# Acceptance Matrix: TAX-VAT-PHASE-7-VAT-POSITION-DETAIL-DRILL-DOWN

**Status: FINAL ACCEPTANCE MATRIX — hardened under "NORYX CTO MASTER EXECUTION AUTHORIZATION" (this session), 40 scenarios (DRILL-001–DRILL-040).** Every scenario below defines what the implementation in this same authorized execution must prove. This document's "Expected Result" column states specified behavior; whether each scenario was actually implementation-tested, and with what result, is tracked separately in the implementation-stage completion report, which distinguishes SPECIFIED / VERIFIED-BY-REPOSITORY-INSPECTION / IMPLEMENTATION-TESTED / NOT-EXECUTED — no PASS is claimed here from inspection alone.

Every scenario traces to a specific `CONTRACT.md` section; no scenario tests anything outside the contract, and no contract clause is left without a corresponding scenario. Two scenarios were added in this pass beyond the prior 38 (DRILL-039 for Correction 3's partial-page reconciliation distinction, DRILL-040 for Hardening Requirement 5's zero-result behavior), and DRILL-032 was rewritten from a code-inspection check into a behavioral test (Correction 2).

Format per scenario: **ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract §**

## 1. Source-Line Granularity

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-001 | A single POSTED Supplier Bill with two lines, each carrying a different `taxCodeId`. | Query the detail endpoint for the bill's legal entity/date window. | Exactly two detail rows are returned for this document, one per line — not one row for the document. | One row per persisted tax-bearing source line, never per document (§6). | §6 |
| DRILL-002 | A single POSTED Customer Invoice with three lines, two of which share the same `taxCodeId` and one of which carries a different `taxCodeId`. | Query the detail endpoint. | Exactly three detail rows are returned — never collapsed into one or two rows by shared tax code. | Detail is never one row per tax code (§6). | §6 |

## 2. Every Source Type

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-003 | One POSTED, tax-tagged line of each: Supplier Bill, Supplier Debit Note, Customer Invoice, Customer Credit Note, and a manual journal entry with a tax-tagged line. | Query the detail endpoint for a window covering all five. | At least one detail row exists with each of the five `sourceType` values (`SUPPLIER_BILL`, `SUPPLIER_DEBIT_NOTE`, `CUSTOMER_INVOICE`, `CUSTOMER_CREDIT_NOTE`, `MANUAL_JOURNAL`). | All five source types (§5) are independently represented. | §5, §6 |

## 3. Tax-Code Filtering

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-004 | Fixture with two distinct tax codes, each with activity across at least two source types. | Query with `taxCodeId` set to one of the two codes. | Only rows for that `taxCodeId` are returned; the other code's rows are absent; `reconciliationTotals` contains only that code's entry/entries. | Optional `taxCodeId` filter narrows correctly (§8). | §8 |
| DRILL-005 | Same fixture as DRILL-004. | Query with no `taxCodeId`. | Rows for both codes are returned. | Omitting `taxCodeId` returns all codes (§8). | §8 |

## 4. INPUT / OUTPUT Direction

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-006 | A POSTED Supplier Bill line with `taxCodeId` set. | Query the detail endpoint. | Row's `direction = INPUT`, `sourceType = SUPPLIER_BILL`, `signedTaxContributionMinor = +tax_amount_minor`. | §7's `SUPPLIER_BILL` row. | §7 |
| DRILL-007 | A POSTED Customer Invoice line with `taxCodeId` set. | Query the detail endpoint. | Row's `direction = OUTPUT`, `sourceType = CUSTOMER_INVOICE`, `signedTaxContributionMinor = +tax_amount_minor`. | §7's `CUSTOMER_INVOICE` row. | §7 |

## 5. AP/AR Polarity (Contra Documents)

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-008 | A POSTED Supplier Debit Note line with `taxCodeId` set, against the same code as an existing bill. | Query the detail endpoint. | Row's `signedTaxContributionMinor = −tax_amount_minor` (negative of the stored value); `reconciliationTotals` for that code nets the bill's positive and the debit note's negative contribution correctly. | §7's `SUPPLIER_DEBIT_NOTE` contra polarity. | §7 |
| DRILL-009 | A POSTED Customer Credit Note line with `taxCodeId` set, against the same code as an existing invoice. | Query the detail endpoint. | Row's `signedTaxContributionMinor = −tax_amount_minor`; nets correctly against the invoice's positive contribution in `reconciliationTotals`. | §7's `CUSTOMER_CREDIT_NOTE` contra polarity. | §7 |

## 6. Manual Journal Polarity

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-010 | A POSTED manual journal line tagged `tax_direction = OUTPUT`, `credit_minor = X`, `debit_minor = Y`. | Query the detail endpoint. | Row's `sourceType = MANUAL_JOURNAL`, `direction = OUTPUT`, `signedTaxContributionMinor = X − Y`. | §7's manual OUTPUT formula. | §7 |
| DRILL-011 | A POSTED manual journal line tagged `tax_direction = INPUT`, `debit_minor = X`, `credit_minor = Y`. | Query the detail endpoint. | Row's `sourceType = MANUAL_JOURNAL`, `direction = INPUT`, `signedTaxContributionMinor = X − Y`. | §7's manual INPUT formula. | §7 |

## 7. Manual Journal Reversal

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-012 | A POSTED, tax-tagged manual journal entry, then reversed (Phase 6 reversal — same `taxCodeId`/`tax_direction`, swapped debit/credit). | Query the detail endpoint for a window covering both. | **Both** the original and the reversal appear as independent detail rows (not omitted, not merged) — two rows, same `taxCodeId`/`direction`, `signedTaxContributionMinor` values that are exact additive inverses. | §7's "not excluded" rule for manual reversals — structurally different from AP/AR's exclusion. | §7 |
| DRILL-013 | Same fixture as DRILL-012. | Inspect `reconciliationTotals` for that `(taxCodeId, direction)`. | The net total contribution from this pair is exactly zero. | Original+reversal net to zero via arithmetic, not omission (§7, §11A). | §7, §11 |

## 8. AP/AR Document Reversal Exclusion

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-014 | A POSTED, tax-tagged Supplier Bill, subsequently reversed via the Document-Level Reversal mechanism (`journal_entries.reversed_by_journal_entry_id` set on the bill's own journal entry). | Query the detail endpoint for a window covering the bill's date. | **Zero** detail rows are produced for this bill — full-document omission, not a negative counterpart row. | §7's AP/AR exclusion-on-reversal rule, structurally different from manual journal's inclusion rule. | §7 |
| DRILL-015 | Same fixture as DRILL-014, but a second, non-reversed bill exists with the same tax code in the same window. | Query the detail endpoint. | Only the non-reversed bill's line(s) appear; the reversed bill contributes nothing. | Reversal exclusion is per-document, does not suppress unrelated documents. | §7 |

## 9. Untagged-Line Exclusion

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-016 | A POSTED Supplier Bill line with `taxCodeId = NULL` (legacy/untagged), alongside a tagged line on the same document. | Query the detail endpoint. | Only the tagged line appears as a detail row; the untagged line produces none. | §16's untagged-exclusion invariant, reusing the existing `tax_code_id IS NOT NULL` filter. | §16 |
| DRILL-017 | A POSTED manual journal line with both `tax_code_id`/`tax_direction` `NULL`. | Query the detail endpoint. | This line produces no detail row. | Same invariant, manual-journal path. | §16 |

## 10. Date-Range Filtering

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-018 | A tagged line dated inside the query window and another dated one day after `dateTo`. | Query with explicit `dateFrom`/`dateTo`. | Only the in-window line appears. | Date-window scoping matches each source type's own date column (§5, §8). | §8 |

## 11. Period Filtering

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-019 | A tagged line dated inside a defined accounting period. | Query with `periodId` set to that period. | The line appears, using the period's own resolved `startDate`/`endDate`, identical to the aggregate report's own `periodId` resolution. | `periodId` resolution matches the existing report (§8). | §8 |
| DRILL-020 | — | Query with both `periodId` and an explicit `dateFrom`/`dateTo`. | Request rejected 400 (`PeriodIdExcludesDateRangeConstraint`). | Mutual exclusivity enforced identically to the existing report/DTOs. | §8 |
| DRILL-021 | — | Query with neither `periodId` nor `dateFrom`/`dateTo`. | Request rejected 400. | A VAT detail query requires an explicit window, matching the aggregate report's own rule. | §8 |

## 12. Tenant Isolation

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-022 | Tenant A and Tenant B each have tax-tagged activity across all five source types in the same date window. | Authenticate as a Tenant B user; query the detail endpoint. | Zero Tenant A rows are returned, across all five source types. | §12's tenant isolation, exercised across every source type, not just one. | §12 |

## 13. Legal-Entity Isolation

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-023 | Two legal entities under the same tenant, each with tax-tagged activity across all five source types. | Authenticate scoped to legal entity A; query the detail endpoint. | Zero legal-entity-B rows are returned, across all five source types. | §13's legal-entity isolation, exercised across every source type. | §13 |

## 14. RBAC

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-024 | — | Query as `finance.viewer`, `finance.poster`, `finance.admin` respectively. | All three succeed (200) and return identical results for identical scope. | Read roles match the existing report exactly (§14). | §14 |
| DRILL-025 | — | Query with no token, and with a token carrying no `finance.*` role. | 401 and 403 respectively. | Denial behavior matches the existing report exactly. | §14 |

## 15. Deterministic Ordering

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-026 | A fixture with several lines sharing the identical `sourceDocumentDate`. | Query the same scope twice in immediate succession, with no intervening writes. | The two responses return rows in the byte-identical order. | Deterministic ordering — no row order depends on unspecified database behavior (§9). | §9 |
| DRILL-027 | A fixture with at least two rows sharing the identical `sourceDocumentDate` AND identical `sourceType` (e.g., two lines on two different Supplier Bills dated the same day). | Inspect the returned order. | Rows are ordered by `sourceDocumentDate ASC` first, then `sourceType ASC`, then `sourceLineId ASC` as the final tie-breaker, with zero unresolved ties — matching Correction 1's frozen `ORDER BY sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC` exactly, column by column. | The mandated total order (§9), including that `sourceType` — not `sourceLineId` alone — is what disambiguates same-date rows from different source tables. | §9 |

## 16. Pagination Correctness

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-028 | A fixture with more rows than one `pageSize`. | Request `page=1` and `page=2` at a fixed `pageSize`, with no intervening writes between the two requests. | The two pages contain disjoint rows, whose union (by `sourceLineId`) equals the complete filtered result with no duplicate and no omitted row. | Pages partition the complete result correctly for a stable snapshot (§9), read together with §10B's explicit no-cross-request-snapshot-guarantee caveat — this scenario is run in a no-concurrent-write test environment, not claimed as a production guarantee. | §9, §10B |
| DRILL-029 | Same fixture. | Request the identical scope at `pageSize` large enough to cover the complete result in one call. | `totalItems` equals the row count; `totalPages = 1`; every expected row is present. | `totalItems`/`totalPages` computed correctly (§9). | §9 |

## 17. Pagination Metadata

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-030 | A fixture with a known row count `N` and a chosen `pageSize`. | Query at that `pageSize`. | `totalItems = N`; `totalPages = ceil(N / pageSize)`, matching `getLedger()`'s own formula exactly. | Pagination metadata correctness (§9). | §9 |
| DRILL-031 | — | Request `page=0` or `pageSize=0` or `pageSize=201`. | Request rejected 400, matching `LedgerQueryDto`'s own validators. | Pagination bounds enforced identically to the existing precedent. | §9 |

## 18. Consistent-Read Semantics

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-032 | (Correction 2 — behavioral, not code-inspection.) A qualifying reporting scope with at least one existing tax-tagged source line. Two independent database sessions/connections are used: Session A drives the detail-query transaction under test; Session B is a separate connection used only to commit a concurrent write. | Session A begins the detail-query transaction (`REPORT_TX_CONFIG`: `REPEATABLE READ`, `READ ONLY`) and issues its first read (establishing the MVCC snapshot). Before Session A's transaction commits, Session B independently inserts and commits one new POSTED, tax-tagged source line that would otherwise qualify for Session A's exact scope. Session A then issues a second read inside the **same, still-open** transaction (e.g., the `reconciliationTotals` sub-query or a repeat of the page query). | Session A's second read does **not** include Session B's newly committed row — the row count/sum is identical to Session A's first read. After Session A's transaction commits or closes, a **new**, separate request against the same scope **does** include Session B's row. | §10A's within-request consistency is proven behaviorally: the transaction's snapshot is pinned at first read and unaffected by a concurrent commit, and no stale over-caching persists into a genuinely new request. | §10A |

## 19. Same-Snapshot Reconciliation

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-033 | A fixture exercising all five source types, including at least one AP/AR reversal (excluded) and one manual-journal reversal (included, nets to zero). | Query the detail endpoint once, with `pageSize` covering the complete filtered result. | `SUM(returned rows' signedTaxContributionMinor)`, grouped by `(taxCodeId, direction)`, equals that **same response's own** `reconciliationTotals` exactly, for every code/direction present. | §11A's single-request, same-snapshot internal accounting invariant — proven without relying on any cross-request comparison. | §11A |
| DRILL-039 | (Correction 3.) Same fixture as DRILL-033, but chosen/parameterized so its complete filtered result spans **more than one page** at a deliberately small `pageSize` (e.g., `pageSize=1` against a fixture with at least 3 qualifying rows spanning at least 2 `(taxCodeId, direction)` groups). | Query the detail endpoint at `page=1` with that small `pageSize`. Separately, within the same no-concurrent-write test window, walk every page at that `pageSize` and sum all returned rows' `signedTaxContributionMinor`, grouped by `(taxCodeId, direction)`. | `SUM(page 1's one row)` alone does **not** equal `reconciliationTotals` for that row's `(taxCodeId, direction)` in this fixture (it is a strict subset). `reconciliationTotals` instead equals the full cross-page sum computed by walking every page — confirming `reconciliationTotals` represents the complete filtered result, not the current page. | `reconciliationTotals` is defined over the complete filtered result set, never merely the current page (Correction 3) — DRILL-033 alone (single page covering everything) cannot catch a bug that computed `reconciliationTotals` from only the returned page. | §11A |

## 20. Regression Against the Existing VAT Position Report

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-034 | Same fixture as DRILL-033, no writes between the two calls (controlled test environment). | Query the detail endpoint's `reconciliationTotals` and separately query `GET /tax-reports/vat-position` for the identical scope. | The two agree exactly, per `(taxCodeId, direction)` — `reconciliationTotals`'s OUTPUT/INPUT sums equal the aggregate report's `outputByTaxCode`/`inputByTaxCode netTaxMinor` (and `manualTaxMinor` sub-component). | §11B's regression comparison — explicitly labeled as a test-environment check, not a claimed same-snapshot production guarantee (§10B). | §11B |
| DRILL-035 | — | Run the full pre-existing e2e suite (including `vat-position-report.e2e-spec.ts` and the Phase 6 suite) after the detail capability is added. | All pre-existing tests continue to pass unmodified; no field of the existing aggregate route changes name, shape, or meaning. | §21's regression constraint. | §21 |

## 21. Response / API Validation

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-036 | — | Query with a syntactically invalid `taxCodeId` (not a UUID). | 400. | Input validation matches every other Finance report's convention. | §15 |
| DRILL-037 | — | Query with a `taxCodeId` that does not exist, or belongs to a different legal entity. | 400, matching the "resolve or 400" convention (e.g. `resolvePeriodInScope`). | Tax-code resolution validated the same way as elsewhere in this service. | §13, §15 |

## 22. No Mutation / No Accounting-State Change

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-038 | Capture a full snapshot of every source table's row count and content hash before querying. | Query the detail endpoint (including error-path and boundary-value queries from other scenarios above). | The snapshot is byte-identical after the query — zero rows inserted, updated, or deleted anywhere; no `auditLogs` row is written (no mutation occurred to audit). | §16/§17 — this capability performs no mutation of any kind. | §16, §17 |

## 23. Zero-Result Behavior

| ID | Precondition/Setup | Action/Query | Expected Result | Invariant Proven | Contract § |
| --- | --- | --- | --- | --- | --- |
| DRILL-040 | (Hardening Requirement 5.) A valid reporting scope (tenant/legal-entity/date-window-or-`periodId`, optional `taxCodeId`) with zero qualifying tax-bearing source lines. | Query the detail endpoint. | `200` response; `rows: []`; `totalItems: 0`; `totalPages`/pagination metadata computed by the same formula as any other count, matching `getLedger()`'s own existing zero-row convention exactly; `reconciliationTotals: []`. No error is raised merely because zero rows qualify. | Zero-result behavior is well-defined and reuses the existing pagination convention rather than inventing a new one. | §9, §11A |

## Metrics

**N/A.** No MDCRAFT/Metrics Protocol document exists anywhere in this repository (consistent with every prior Finance work item's own completion report). No performance threshold or arbitrary metric is asserted by this acceptance matrix, per instruction.
