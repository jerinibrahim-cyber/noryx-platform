# On-Account (Unapplied) Supplier Payments & Customer Receipts — Completion Report

Binding specification: `docs/finance-work-item-on-account-payments-proposal.md` (fully approved; committed to the repo in this work item's implementation commit, having never been committed previously).

## 1. Commit lineage

| Step                                  | SHA                                                                         | Description                                                              |
| ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Baseline (verified before any change) | `742f5d65b4d986677e031cb88eb6b6d3e06d03ea`                                  | "Add Cash Flow Statement completion report"                              |
| Implementation commit                 | `6fba550b8296420a835a4af798cda77136891579`                                  | "Implement On-Account (Unapplied) Supplier Payments & Customer Receipts" |
| Completion-report commit              | _(created immediately after this file is committed — see Final Git Status)_ | Adds this report only                                                    |

No amend, rebase, squash, or history rewrite was performed at any point. `git diff --stat` against baseline was reviewed before staging, and `git status --short` was reviewed both before and after `git add` to confirm only the intended files were staged (the implementation commit's own `git add` file list is reproduced in Section 12).

Note: this repo runs a `lint-staged` pre-commit hook (`eslint --fix` + `prettier --write` against staged files). It ran automatically during the implementation commit and made only automatic formatting/lint-autofix adjustments to the already-authored, already-reviewed changes — no files outside the intended list were touched (`git status --short` immediately after the commit showed a clean tree except the disclosed `_to_delete/` scratch folder, see Section 14). Typecheck, lint, and the full unit suite were **re-run after the commit**, against the final committed content, to ensure the reported gate results in Sections 9–10 reflect what is actually on disk in the implementation commit, not a pre-hook snapshot.

## 2. Exact scope implemented

Implemented exactly the approved architecture from the proposal:

- A posted Supplier Payment / Customer Receipt may now carry zero, partial, or full allocations at post time. Header-amount-driven GL posting is unchanged — the payment/receipt journal entry always posts for the full header amount regardless of how much (if any) is allocated.
- Two new endpoints: `POST /v1/finance/payments/:id/allocations` and `POST /v1/finance/receipts/:id/allocations`, both `finance.poster`-gated, POSTED-only, non-reversed-only, append-only, enforcing the DB-backed allocation ceiling (`0 <= SUM(allocatedAmountMinor) <= document amount`).
- Allocation-date/period rules per proposal §9.4: cap at `todayUtc()`, floor at the parent document's own date, default to `todayUtc()` when omitted, validated against the allocation's own period via the existing OPEN/CLOSED/NOT_FOUND helpers (`resolveOpenPeriodOrThrow`), with period-open enforcement applying even though `applyAllocation()` itself creates no new journal entry.
- Reversal (`unsettleTarget()`, auto-unwind, permanent post-reversal block) was **not** redesigned — reused exactly as it existed pre-work-item. No second reversal mechanism was introduced.
- Reporting: `unappliedCashMinor()` (§11.2) is now the single shared formula behind reconciliation, as-of, and balance-visibility reads, for both AP and AR. `asOfTotals()` (§11.4) now keys off each allocation's own `allocation_date` with a reversal-timing gate.
- Audit: `applyAllocation()` reuses the existing `UPDATE` audit-event type on the parent payment/receipt row — no new audit-event type was introduced.
- RBAC: both new routes require `finance.poster`, matching every other posting-adjacent route in this module; no existing role/permission was broadened.

Not in scope, and not touched: Expense Management, Fixed Assets, Multi-Currency, Budgeting, Recurring JEs, Manual-JE tax coverage, any Phase 6 feature, or any unrelated refactor/UX/schema cleanup. See Section 13 for explicit confirmation of the four named out-of-scope files/directories.

## 3. Schema / migration changes

`services/sphere-finance/src/db/schema.ts`:

- `supplierPaymentAllocations`: added `allocationDate: date("allocation_date").notNull()`; replaced the `unique("supplier_payment_allocations_payment_bill_unique")` constraint with a non-unique `index("supplier_payment_allocations_payment_bill_idx").on(t.paymentId, t.billId)` (the pre-existing, unrelated `supplier_payment_allocations_bill_idx` was left untouched).
- `customerReceiptAllocations`: byte-mirror — `allocationDate` column added, `customer_receipt_allocations_receipt_invoice_idx` replaces the old unique constraint.

`services/sphere-finance/drizzle/migrations/0022_on_account_allocation_date.sql` (hand-written to the exact proposal §15.1 safe sequence — `drizzle-kit generate`'s auto-produced body used an unsafe direct `ADD COLUMN ... NOT NULL` and was replaced):

For each of `supplier_payment_allocations` / `customer_receipt_allocations`, in order: (1) `ADD COLUMN "allocation_date" date` (nullable), (2) `UPDATE ... SET allocation_date = <parent>.<date column>` backfill from the parent payment/receipt, (3) `ALTER COLUMN "allocation_date" SET NOT NULL`, (4) `DROP CONSTRAINT` on the old unique constraint, (5) `CREATE INDEX IF NOT EXISTS` on the new non-unique index. `meta/0022_snapshot.json` and `meta/_journal.json` were regenerated by `drizzle-kit generate` (final-state schema diff; unaffected by the hand-rewritten intermediate step ordering).

`services/sphere-finance/drizzle/constraints/026_supplier_payment_allocations_immutability_trigger_v2.sql` and `027_customer_receipt_allocations_immutability_trigger_v2.sql` (exact §15.3 SQL): `CREATE OR REPLACE FUNCTION` re-declaring the same function and trigger names as the original `008`/`012` files. UPDATE and DELETE remain unconditionally rejected at every parent status, unchanged from the original. INSERT is now permitted, but only against a POSTED, non-reversed parent. `apply-db-constraints.ts` applies every `drizzle/constraints/*.sql` file in filename-sorted order on every deploy, idempotently, so `026`/`027` run after `008`/`012` and supersede them in place — `008`/`012` were not modified or deleted.

## 4. API summary

```
POST /v1/finance/payments/:id/allocations   (finance.poster)
POST /v1/finance/receipts/:id/allocations   (finance.poster)
```

Both: `200 OK` on success (HTTP status explicitly set via `@HttpCode(200)`, since this appends to an existing posted document rather than creating a new resource). Body: `{ allocations: [{ billId|invoiceId, allocatedAmountMinor }, ...], allocationDate?: string }`. Rejects: non-POSTED parent, reversed parent, ceiling violation, cross-entity bill/invoice, invalid/out-of-range allocation date, closed period. `route-role-matrix.spec.ts` was updated for both new routes (route count 135 → 137) and passes.

`CreateSupplierPaymentDto` / `CreateCustomerReceiptDto`: `@ArrayMinSize(1)` removed from `allocations` (kept `@IsArray()`) to permit posting with zero allocations — this DTO-layer guard was a third, proposal-unflagged gate beyond `post()`'s own two allocation-sum checks (documented as Discrepancy #2 below).

## 5. Accounting behavior

Header-amount-driven GL posting is unchanged: `post()` always posts the journal entry for the full `paymentAmountMinor`/`receiptAmountMinor`, independent of allocation state. `post()`'s own Steps 3/7/9 were relaxed from "at least one allocation, sum == header amount" to "`0 <= total allocations <= document amount`" — this is the only change to `post()`'s accounting behavior. `applyAllocation()` (new, ~230-line method in each service) inserts new allocation rows against an already-POSTED parent: validates the ceiling against the current allocated total (read inside the same transaction as the insert, under the row lock established by the existing update-parent-then-insert-children pattern used elsewhere in these services), validates the allocation date per §9.4, and updates the bill's/invoice's running paid/received total. No new journal entry is created by `applyAllocation()` itself — the header-amount journal entry already exists from `post()`.

## 6. Reporting / as-of behavior

`unappliedCashMinor()` (new private helper, `ap-reports.service.ts` / `ar-reports.service.ts`, exact §11.2 SQL) computes unapplied cash as of a given cutoff date, using `LEFT JOIN LATERAL` against posted, non-reversed (as of the cutoff) payments/receipts minus their allocated total as of that same cutoff. It is the single formula behind both `getSupplierBalance()`/`getCustomerBalance()` and `getApReconciliation()`/`getArReconciliation()` — `cutoffDate = query.asOf ?? todayUtc()` is the one shared parameter shape. `ApReconciliationResult`/`ArReconciliationResult` and the balance-result interfaces gained `unappliedPaymentsMinor`/`unappliedReceiptsMinor`; `differenceMinor` in the reconciliation was corrected to `subLedgerTotalOutstandingMinor - unappliedPaymentsMinor - glApControlAccountBalanceMinor` (AR mirrors with `unappliedReceiptsMinor`).

`asOfTotals()` (both AP and AR) — the only change is to the payment/receipt-allocation subquery: the predicate moved from `sp.payment_date <= cutoffDate` / `cr.receipt_date <= cutoffDate` to `spa.allocation_date <= cutoffDate` / `cra.allocation_date <= cutoffDate`, plus a new reversal-timing gate (`LEFT JOIN journal_entries` on the reversing JE, keeping the allocation counted as of a cutoff only when `reversed_by_journal_entry_id IS NULL OR <reversing JE>.transaction_date > cutoffDate`). The debit-note-allocation and credit-note-allocation subqueries, from the earlier, separate Credit/Debit Notes work item, were deliberately left untouched as out of scope.

Both methods were read in full, end to end, before this rewrite, per the CTO's explicit instruction.

## 7. Reversal behavior

Not redesigned. `unsettleTarget()` is reused exactly as it existed before this work item; reversal continues to auto-unwind any existing allocations and to permanently block any further posting-adjacent action (including `applyAllocation()`) once a document is reversed. No second reversal mechanism exists anywhere in the new code.

## 8. Audit / RBAC / isolation

`applyAllocation()` writes a single `UPDATE` audit event against the parent payment/receipt row, reusing the existing audit-event type and audit-write call pattern already used by other mutating actions on these entities — no new audit-event type was introduced. Both new routes require `finance.poster`; `route-role-matrix.spec.ts` (updated, passing) asserts this and every other route's required role set. Cross-tenant/cross-entity/cross-supplier(customer) isolation for `applyAllocation()` is asserted in the new e2e specs (Table 19.1 scenario coverage — see Section 9) via the existing `withTenant`/tenant-scoped-repository pattern already used by every other write path in these services; no new isolation mechanism was introduced.

## 9. Quality-gate results (proposal §19)

**What was actually executed in this environment, and what was written but could not be executed:**

This `device_bash` environment (an isolated Linux VM on the user's machine, reached via the device bridge) has **no Docker, no root/sudo, and no reachable local PostgreSQL instance** — confirmed by absence of `docker`/`podman`/`nerdctl`/`lima`/`colima`/`postgres`/`pg_ctl`/`initdb` and a failing `sudo -n true`. This is disclosed as a major, environment-level blocker. An in-memory Postgres-compatible engine (`pg-mem`) was explicitly considered as a substitute and **rejected**, because claiming verification against it would misrepresent genuine PostgreSQL verification, directly contrary to the CTO's instruction: _"Do not claim 'verified' unless the corresponding verification actually ran."_

**Actually executed (real, honest results):**

- `npx tsc --noEmit` — **0 errors.**
- `npx eslint src test` — **0 errors, 37 warnings.** 34 of these warnings are pre-existing/in files this work item did not touch (baseline had 10 such warnings; the count is higher here because this run scanned the full `src`+`test` tree rather than a touched-files-only diff, surfacing pre-existing warnings not previously enumerated). The remaining 3 are new, harmless `no-unused-vars` warnings introduced in this work item's own new e2e spec files: `test/on-account-allocation.e2e-spec.ts:23` (`apSettings`, imported but unused) and `test/on-account-allocation-ar.e2e-spec.ts:12-13` (`auditLogs`, `and`, imported but unused). These do not affect correctness or type-safety. They were caught after the implementation commit had already landed; per the CTO's own two-commit lineage requirement (implementation commit, then a separate completion-report commit — no third commit), they are disclosed here rather than fixed via an additional commit. **Recommendation:** remove these three unused imports in the next work item's first commit, or via a small standalone follow-up commit if the user prefers it fixed immediately.
- Unit test suite (`npx jest`, no live DB required, `src/**/*.spec.ts`) — run twice: once mid-implementation (**618 passed, 2 failed** — the 2 failures were the two DTO tests asserting the old, pre-work-item "empty allocations array is rejected" rule, i.e. exactly the rule this work item is authorized to change), and again after fixing those two tests and after the commit's pre-commit hook ran (**620 passed, 620 total**, 65 suites, 0 failures). This second run is against the exact content of the implementation commit.

**Written but NOT executed (no live Postgres available):**

- The 50 named scenarios in Table 19.1: the large majority have corresponding, specifically-written e2e test code across the three new spec files (`on-account-allocation.e2e-spec.ts`, `on-account-allocation-ar.e2e-spec.ts`, `on-account-allocation-concurrency.e2e-spec.ts`), asserting real accounting outcomes (DB row states, computed totals) rather than HTTP status alone, per the CTO's explicit requirement. **Not written as dedicated new tests** (relying instead on unmodified pre-existing code paths and pre-existing regression suites that were themselves not rewritten by this work item): scenarios 14, 15, 34, 35, 37, 38, 39, 40, 47, 48, 49, 50. Scenario 44's second concurrency ordering (the CTO's suggested `jest.spyOn` private-seam technique for deterministically forcing both orderings) was **not** implemented — only the probabilistic real-HTTP race (`Promise.all`) is covered, which reliably exercises one ordering per run but not both deterministically in the same run.
- The 12-point raw-SQL trigger/schema verification checklist (§19.2 item 3): written as raw-SQL assertions inside `on-account-allocation.e2e-spec.ts`/`on-account-allocation-ar.e2e-spec.ts`, using the same `sql` tagged-template convention as `ap-reports.service.ts`. Not executed.
- The 10-point migration-safety checklist (§19.2 item 5): the migration SQL was manually reviewed against every point on the checklist (safe column-add ordering, backfill-before-not-null, no unconditional lock-holding statement, idempotent index creation, no data loss on the dropped unique constraint since it is superseded by a non-unique index over the same columns) but **not executed against a live database**, so this is a static-review pass, not an execution-verified pass.
- Full existing e2e regression suite (baseline 989 tests) and the genuine concurrency test (`on-account-allocation-concurrency.e2e-spec.ts`, scenarios 42/43/44): written, not executed.
- Route-role matrix: this ONE test **is** part of the unit suite (no live DB) and **did execute and pass** as part of the 620/620 run above.

**Recommendation:** run the full suite on a machine with Docker available: `docker compose up --build`, then `pnpm --filter @noryx/db-core run migrate:dev`, then `pnpm test:e2e` from `services/sphere-finance`, per the repo's own README, before this work item is considered fully verified end-to-end.

## 10. Full regression results

| Suite                                 | Result                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`npx jest`, no DB)              | **620 passed, 620 total, 65 suites, 0 failed** (executed, against final committed content)                                                |
| `route-role-matrix.spec.ts`           | Included in the above; passes; route count 135 → 137 documented                                                                           |
| Typecheck (`tsc --noEmit`)            | **0 errors** (executed)                                                                                                                   |
| Lint (`eslint`)                       | **0 errors, 37 warnings** (executed; 3 new warnings disclosed above, all in this work item's own new test files, none in production code) |
| e2e (baseline 989 tests)              | **Not executed — no live Postgres in this environment** (written coverage per Section 9)                                                  |
| Concurrency test                      | **Not executed — no live Postgres in this environment** (written, scenarios 42/43/44)                                                     |
| Migration/schema raw-SQL verification | **Not executed — no live Postgres in this environment**; migration SQL manually reviewed against the 10-point checklist                   |

No pre-existing failure was encountered outside the two DTO tests described above, both of which were determined to be genuine, minimal, CTO-authorized test updates (Section 11) rather than test-weakening.

## 11. Defects found / fixed

1. **`insertAllocations()` signature bug (AP and AR, independently discovered and fixed in both).** The method was called with 5 arguments from `create()`/`update()` but only declared 4 parameters, silently never setting the new NOT NULL `allocation_date` column. Fixed by adding the 5th `allocationDate: string` parameter and including it in the insert.
2. **DTO-layer `@ArrayMinSize(1)` gap (Discrepancy #2).** `CreateSupplierPaymentDto`/`CreateCustomerReceiptDto` each had a third guard, beyond `post()`'s own two, requiring at least one allocation at the DTO validation layer — not called out explicitly in the proposal's own text, but incompatible with the approved zero-allocation-posting architecture. Fixed by removing `@ArrayMinSize(1)` (kept `@IsArray()`). The two pre-existing unit tests asserting the old "rejects an empty allocations array" behavior were updated to assert the new, intentional "accepts an empty allocations array" behavior, since they encoded exactly the old rule this work item is authorized to change — this is the narrow case-1 sense of "genuine regression caused by this implementation," not test-weakening to hide a defect. The adjacent "rejects a missing allocations array" tests (field absent entirely, as opposed to present-but-empty) were left unchanged — `@IsArray()` still rejects `undefined`, so that behavior is correctly unaffected.
3. **3 new lint warnings (unused imports) in the work item's own new e2e spec files** — disclosed in Section 9, not fixed post-commit to preserve the CTO's required two-commit lineage.

No other defects were found. No production code outside the scope of this work item was modified.

## 12. Files changed

Implementation commit `6fba550b8296420a835a4af798cda77136891579` — 23 files, +10271/-93:

```
docs/finance-work-item-on-account-payments-proposal.md                                    (new — binding spec, never previously committed)
services/sphere-finance/drizzle/constraints/026_supplier_payment_allocations_immutability_trigger_v2.sql  (new)
services/sphere-finance/drizzle/constraints/027_customer_receipt_allocations_immutability_trigger_v2.sql  (new)
services/sphere-finance/drizzle/migrations/0022_on_account_allocation_date.sql            (new)
services/sphere-finance/drizzle/migrations/meta/0022_snapshot.json                        (new)
services/sphere-finance/drizzle/migrations/meta/_journal.json                             (modified)
services/sphere-finance/src/accounts-payable/ap-reports/ap-reports.service.ts             (modified)
services/sphere-finance/src/accounts-payable/supplier-payments/dto/apply-supplier-payment-allocation.dto.ts (new)
services/sphere-finance/src/accounts-payable/supplier-payments/dto/create-supplier-payment.dto.spec.ts (modified)
services/sphere-finance/src/accounts-payable/supplier-payments/dto/create-supplier-payment.dto.ts (modified)
services/sphere-finance/src/accounts-payable/supplier-payments/supplier-payments.controller.ts (modified)
services/sphere-finance/src/accounts-payable/supplier-payments/supplier-payments.service.ts (modified)
services/sphere-finance/src/accounts-receivable/ar-reports/ar-reports.service.ts          (modified)
services/sphere-finance/src/accounts-receivable/customer-receipts/customer-receipts.controller.ts (modified)
services/sphere-finance/src/accounts-receivable/customer-receipts/customer-receipts.service.ts (modified)
services/sphere-finance/src/accounts-receivable/customer-receipts/dto/apply-customer-receipt-allocation.dto.ts (new)
services/sphere-finance/src/accounts-receivable/customer-receipts/dto/create-customer-receipt.dto.spec.ts (modified)
services/sphere-finance/src/accounts-receivable/customer-receipts/dto/create-customer-receipt.dto.ts (modified)
services/sphere-finance/src/db/schema.ts                                                  (modified)
services/sphere-finance/src/route-role-matrix.spec.ts                                     (modified)
services/sphere-finance/test/on-account-allocation-ar.e2e-spec.ts                         (new)
services/sphere-finance/test/on-account-allocation-concurrency.e2e-spec.ts                (new)
services/sphere-finance/test/on-account-allocation.e2e-spec.ts                            (new)
```

## 13. Out-of-scope files confirmation

Confirmed untouched (checked via `git status --short` against each path immediately before the implementation commit — no output, meaning no modification of any kind):

- `docs/hardening/`
- `docs/finance-work-item-next-discovery.md`
- `docs/finance-work-item-next-discovery-post-reversal.md`
- `docs/finance-work-item-next-discovery-current.md`

No other Finance work item was selected or started. Phase 6 was not begun.

## 14. Final git status

Immediately after the implementation commit, `git status --short` showed exactly one entry:

```
?? services/sphere-finance/_to_delete/
```

This is `services/sphere-finance/_to_delete/tsconfig.testcheck.json` — a scratch file used mid-session to typecheck the `test/` directory against `tsconfig.json`'s own settings without permanently modifying `tsconfig.json`'s `include` list. `device_bash` cannot delete files in a connected folder (`rm`/`unlink` fail with "Operation not permitted" until the user separately grants delete permission for that session), so per the established workaround it was moved into a `_to_delete/` subfolder instead of being deleted, and is disclosed here for the user to delete manually. It was never staged or committed, and is not part of this work item's implementation.

After this completion-report file is committed (Section 1), `git status --short` is expected to again show only this same single `_to_delete/` entry.

## 15. Push status

**NOT PUSHED.** No push was performed, and none will be, absent a separate explicit instruction.
