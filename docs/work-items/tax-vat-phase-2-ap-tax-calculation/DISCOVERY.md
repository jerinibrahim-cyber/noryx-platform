# Tax / VAT Phase 2 — AP Tax Calculation — Discovery

**Status:** Discovery / architecture gate. No Phase 2 code, schema, or migration changes have been made. This document is the sole artifact of this discovery round.

**Scope of this discovery:** wire `taxCodeId` and resolved/snapshotted tax rates into **Supplier Bills** and **Supplier Debit Notes** only (AP side). AR (Customer Invoices, Customer Credit Notes) and the VAT report are explicitly out of scope — see "Out of scope / deferred."

**Baseline verified against:** `main` @ `e5846cc` (`e5846cca0933a0cb0b7de33e87fcd357514d7975`), which includes Tax/VAT Phase 1 (`dd6d135`, Tax Configuration Foundation) and its own roadmap update. Working tree clean except the pre-existing, unrelated untracked `docs/hardening/` directory.

---

## 1. Verified current state

1. **Tax/VAT Phase 1 is complete and on `main`.** `tax_codes` and `tax_rates` exist, with full CRUD/create+list APIs, RBAC, audit, RLS, and the `tax_rates` non-overlap `EXCLUDE USING gist` constraint verified live at the DB level. `tax_rates` is **create-only** — no update/delete route exists; corrections are new rows. `tax_codes.isActive` governs **future selectability only** and is explicitly documented as non-retroactive (schema.ts comment, Phase 1).
2. **Supplier Bills** (`supplier_bills` / `supplier_bill_lines`) already carry a line-level `taxAmountMinor` (`bigint`, not null, default 0) that is purely manual today — nothing resolves it from a rate. `SupplierBillsService.computeTotals()` = `subtotalMinor = SUM(line.amountMinor)`, `taxMinor = SUM(line.taxAmountMinor ?? 0)`, `totalMinor = subtotalMinor + taxMinor`, matching the `supplier_bills_total_equals_subtotal_plus_tax` CHECK by construction. Tax posts as **one aggregate line** at posting time: `Dr apSettings.taxInputAccountId, debitMinor: taxTotal`, only when `taxTotal > 0`, guarded by a 422 if `taxInputAccountId` is unset.
3. **Supplier Debit Notes** (`supplier_debit_notes` / `supplier_debit_note_lines` / `supplier_debit_note_allocations`) are structurally **independent documents**, not corrections tied to a single original bill:
   - A debit note has its own `lines` (own `accountId`, `amountMinor`, `taxAmountMinor` — exact structural mirror of a bill line), computed into its own `subtotalMinor`/`taxMinor`/`totalMinor` via the identical `computeTotals()` shape.
   - A debit note settles against supplier bills only via a **separate `supplier_debit_note_allocations` table**, at **header level**: `(debitNoteId, billId, allocatedAmountMinor)`, unique on `(debitNoteId, billId)`. **A single debit note may allocate against more than one bill** (the service loops `before.allocations`, locking every allocated bill "in a fixed ascending-id order").
   - There is **no FK, join, or any other structural link between a debit-note line and a specific bill line.** Lines and allocations are two independent partitions of the same `totalMinor` — lines say _where the amount is charged (GL account)_, allocations say _which bill(s) it settles_. `allocatedTotal` must equal `totalMinor` to post; there is no per-line correspondence requirement at all.
   - Posting reverses the bill's polarity: `Dr apSettings.apControlAccountId` (whole `totalMinor`) / `Cr` each line's account / `Cr apSettings.taxInputAccountId` if `taxTotal > 0` — same tax-input account as bills, same 422 guard if unconfigured.
4. **Immutability.** `supplier_bill_lines` and `supplier_debit_note_lines` both use a **blanket, zero-exception** BEFORE INSERT/UPDATE/DELETE trigger keyed on the parent's status (`006_supplier_bill_lines_immutability_trigger.sql`, `017_supplier_debit_note_lines_immutability_trigger.sql`): once the parent is `POSTED`, **no** mutation of any kind is permitted, INSERT included. `supplier_debit_notes` itself is also zero-exception (`016_...sql`). `supplier_bills` itself has the **one** documented exception (`paid_minor`/`payment_status`, via an **explicit column-by-column whitelist**, not a blanket check) — `005_supplier_bills_immutability_trigger.sql`.
5. **RLS** on all four tables (`supplier_bills`, `supplier_bill_lines`, `supplier_debit_notes` and its two child tables) is the standard tenant-only `tenant_isolation` policy (`FORCE ROW LEVEL SECURITY`, `= ''`-bypass-fix included), with `legal_entity_id` isolation enforced explicitly in the service layer — identical mechanism as every other Finance table, verified in `drizzle/rls/004_ap_bills_rls.sql` and `drizzle/rls/010_ap_debit_notes_rls.sql`.
6. **RBAC.** Both `SupplierBillsController` and `SupplierDebitNotesController` split roles by document nature, not module: `finance.poster` for all writes (create/update/delete/post), `finance.viewer`+`finance.poster`+`finance.admin` for reads. Confirmed identical shape in both controllers.
7. **`apSettings.taxInputAccountId`** is nullable, optionally typed (no LIABILITY/ASSET restriction — deliberately jurisdiction-agnostic per its own schema comment), unchanged by Phase 1, and already the single tax-input account for both bills and debit notes.
8. **No rounding helper exists anywhere in the codebase.** A repo-wide search for a `round(...)`/tax-calculation utility returned nothing — every `round` match found was prose in a comment. Phase 2 is the first feature to need one.
9. **The migration-constraint pipeline is generic and already fixed (Phase 1, Decision 7).** `apply-db-constraints.ts` applies every `*.sql` file in `drizzle/constraints/` in filename order, wired into both `migrate`/`migrate:dev` and CI. It exists only for the class of constraint Drizzle's schema DSL cannot express (EXCLUDE, triggers). **Ordinary FKs and CHECK constraints are declared directly in `schema.ts`** (as Phase 1 did for `tax_codes`/`tax_rates`) and ride the normal `pnpm run generate` / `pnpm run migrate` path — no new plumbing is needed for Phase 2 unless it needs an EXCLUDE constraint or a new trigger (it does not, see §9 below).
10. **No existing e2e test currently exercises tax on bills or debit notes** beyond the existing manual `taxAmountMinor` totals arithmetic. Current regression surface: `test/supplier-bills.e2e-spec.ts` (29 tests), `test/supplier-debit-notes.e2e-spec.ts` (33 tests), `test/ap-bill-concurrency.e2e-spec.ts` (3 tests), `test/tax-configuration.e2e-spec.ts` (27 tests, Phase 1), plus `src/route-role-matrix.spec.ts`.

---

## 2. Exact affected files / modules

**Modified:**

- `services/sphere-finance/src/db/schema.ts` — new nullable columns on `supplierBillLines` and `supplierDebitNoteLines` (see §9).
- `services/sphere-finance/src/accounts-payable/supplier-bills/dto/create-supplier-bill-line.dto.ts` — add optional `taxCodeId`.
- `services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.service.ts` — `insertLines()` gains tax resolution; `create()`/`update()` gain a tax-code validation pass alongside the existing `validateLineAccountsOrThrow`.
- `services/sphere-finance/src/accounts-payable/supplier-debit-notes/dto/create-supplier-debit-note-line.dto.ts` — add optional `taxCodeId` (this DTO is also reused verbatim by `UpdateSupplierDebitNoteDto.lines`, so no separate update-DTO change is needed).
- `services/sphere-finance/src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts` — same shape of change as bills, applied to `insertLines()`/`create()`/`update()`.
- `services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.module.ts` and `.../supplier-debit-notes/supplier-debit-notes.module.ts` — import `TaxConfigurationModule` to inject `TaxRatesService`/`TaxCodesService` (see §3 for why DI, not duplication, is recommended here).
- `services/sphere-finance/drizzle/migrations/00xx_*.sql` (+ `meta/*.json`) — one new Drizzle-generated migration for the new columns/FKs/CHECKs.
- `test/supplier-bills.e2e-spec.ts`, `test/supplier-debit-notes.e2e-spec.ts` — new "tax calculation" describe blocks (recommended location — see §11).

**Not touched:** `apSettings`/`arSettings` schema, any RLS file, any `drizzle/constraints/*.sql` file, the AP/AR posting journal-line shape (single aggregate tax line, unchanged per Decision 5), `tax-configuration` module's own files (Phase 1 is consumed, not modified), any AR file (`customer-invoices`, `customer-credit-notes` — structurally identical to the AP pair on inspection of `schema.ts`, but explicitly out of scope for this phase).

---

## 3. Proposed architecture and data flow

Add a small, explicit tax-resolution step, identical in shape on both documents, executed at line-write time (create, and full-replace update) inside the existing `withTenant()` transaction — not at posting time:

```
for each line (bill line or debit-note line):
  if taxCodeId is not supplied:
      # legacy path — completely unchanged
      taxAmountMinor = client-supplied value ?? 0
      taxCodeId = null, taxRateId = null,
      taxAmountCalculatedMinor = null, taxAmountOverridden = false
  else:
      taxCode = load tax_codes row (scoped to legalEntityId); 400 if missing or isActive = false
      taxRate = resolve the tax_rates row for (taxCodeId) whose
                [effectiveFrom, effectiveTo) half-open range covers
                the document's OWN transaction date
                (bill.billDate / debitNote.debitNoteDate — Decision 6);
                400 if none found ("no effective rate")
      calculated = round(line.amountMinor * taxRate.rateBasisPoints / 10000)   # integer minor-unit, Decision 2
      if client also supplied an explicit taxAmountMinor:
          taxAmountMinor = client-supplied value        # authoritative (Decision 4)
          taxAmountCalculatedMinor = calculated          # retained for audit/reconciliation
          taxAmountOverridden = true
      else:
          taxAmountMinor = calculated                    # authoritative
          taxAmountCalculatedMinor = calculated
          taxAmountOverridden = false
      taxRateId = taxRate.id                              # snapshot — immutable FK, tax_rates is create-only
```

Header totals (`subtotalMinor`/`taxMinor`/`totalMinor`) are unchanged: still `SUM(line.amountMinor)` / `SUM(line.taxAmountMinor)` / their sum — `taxAmountMinor` remains the single authoritative per-line figure that feeds every existing total/CHECK/posting computation, so **no change is needed to `computeTotals()`, the CHECK constraints, or the posting journal-line logic on either service.** This is the direct, minimal-surface-area consequence of Decision 5 (no GL-mapping change) plus the fact that Decision 4 designates `taxAmountMinor` — the column that already exists — as authoritative in every case.

**Resolution timing:** at line create/replace time only, never re-resolved at posting. Posting-time behavior is completely unchanged other than the tax total it sums already reflecting resolved/overridden amounts — `SupplierBillsService.post()` / `SupplierDebitNotesService.post()` need **no code changes**, since `taxTotal` is still `SUM(line.taxAmountMinor)`.

**Where the resolution logic lives:** Phase 1 already establishes a working precedent for exactly this need — `TaxRatesService` is DI-injected into `TaxCodesService`'s sibling and does the "load code, validate scope, then act" sequence. Recommend adding one new method to `TaxRatesService`:

```ts
async resolveEffectiveRate(
  tx: TxClient, legalEntityId: string, taxCodeId: string, onDate: string,
): Promise<TaxRate | undefined>
```

and importing `TaxConfigurationModule` into `SupplierBillsModule`/`SupplierDebitNotesModule` to inject `TaxCodesService` (active-code validation) and `TaxRatesService` (rate resolution). This is a deliberate departure from this codebase's usual "duplicate the trivial single-table lookup locally" convention (seen in `resolveCurrency`, `allocateJournalNumber`, etc.) — tax resolution is non-trivial business logic with its own module and its own future evolution (VAT report, AR wiring), so it should be owned once and consumed via DI, exactly as `TaxRatesService` already consumes `TaxCodesService`. This is a discovery judgment call, not a CTO gate item — it doesn't change data model, security, or posting behavior, only where a helper method lives.

---

## 4. Supplier Bill and Supplier Debit Note behavior

Both documents get **line-level** tax resolution, applied identically:

- **Supplier Bill** — `CreateSupplierBillLineDto.taxCodeId` (new, optional). Resolution uses `bill.billDate`. Behavior is otherwise unchanged: `create()`, `update()` (full line-array replace), `post()`.
- **Supplier Debit Note** — `CreateSupplierDebitNoteLineDto.taxCodeId` (new, optional; this DTO already backs both create and the full-replace update path). Resolution uses `debitNote.debitNoteDate` — **not** any allocated bill's date, and **not** any allocated bill's tax code (see §13, Decision Required #1 — this is a required deviation from the literal wording of the original Decision 1).

Because debit-note lines are already structurally independent of bill lines (§1.3), no new linkage code is needed or possible without a schema redesign that is out of this phase's scope.

---

## 5. Tax resolution / calculation and snapshot semantics

- **Trigger:** `taxCodeId` present on a line at create or full-replace-update time.
- **Scope check:** `taxCodeId` must resolve to a `tax_codes` row in the caller's own `legalEntityId` (mirrors every other cross-reference in this codebase) **and** `isActive = true` — Phase 1's own schema comment establishes `isActive` as gating _future selectability_, and this is the first code that actually selects a tax code, so this is a direct, unambiguous consequence of already-recorded intent, not a new decision.
- **Rate resolution:** query `tax_rates` for `(tenantId, legalEntityId, taxCodeId)` where the half-open `[effectiveFrom, effectiveTo)` range covers the document's own date. Phase 1's EXCLUDE constraint guarantees at most one row can ever match — no ambiguity, no ordering/tie-break logic needed.
- **No effective rate found** → reject the write (400/422, matching this codebase's existing "reject, never silently zero" posture for tax-input-account-missing and similar cases) rather than silently treating the line as tax-free.
- **Snapshot:** store the resolved `tax_rates.id` as `taxRateId` on the line. Because `tax_rates` is **create-only** (no update/delete route exists at all — verified in §1), an FK reference is a safe, permanent snapshot; a later rate change (a new `tax_rates` row for a later period) can never retroactively alter an already-resolved line. This satisfies "snapshotted tax rate" more robustly than denormalizing `rateBasisPoints` onto the line would, while still being reconstructable/auditable via the FK join.
- **Historical rate changes** (proposal's Case 6) therefore require **no special-case code** — each line simply resolves against whatever `tax_rates` row was effective on its own document's date at the moment the line was written, and that resolution never changes afterward.

---

## 6. Override behavior

Directly implements Decision 4, unchanged from the original approval:

| `taxCodeId` | explicit `taxAmountMinor` | Result                                                                                                                                    |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| omitted     | omitted                   | `taxAmountMinor = 0` (unchanged legacy default)                                                                                           |
| omitted     | supplied                  | `taxAmountMinor` = supplied value, exactly as today (legacy manual path, fully preserved)                                                 |
| supplied    | omitted                   | resolve + calculate; `taxAmountMinor` = calculated; `taxAmountOverridden = false`                                                         |
| supplied    | supplied                  | resolve + calculate (`taxAmountCalculatedMinor`); `taxAmountMinor` = the **supplied** value (authoritative); `taxAmountOverridden = true` |

Both the calculated and the overriding value are always retained (nothing is silently discarded), satisfying Decision 4 verbatim.

---

## 7. Date / rounding rules

- **Resolution date:** the document's own transaction date — `supplier_bills.bill_date` / `supplier_debit_notes.debit_note_date` — never `posted_at`/posting date. This is Decision 6, applied per-document (see §13 for why "per document's own date," not "the original bill's date," is required for debit notes).
- **Rounding:** integer minor-unit arithmetic only, at line level, per Decision 2: `taxAmountCalculatedMinor = round(line.amountMinor * taxRate.rateBasisPoints / 10000)`. Header `taxMinor` remains exactly `SUM(line.taxAmountMinor)` — no separate header-level rounding step, no floating point anywhere. `rateBasisPoints` is already an integer (Phase 1), so this is pure integer math; "round" here is round-half-up on the single division, matching the only other numeric-derivation pattern in this codebase (bigint minor-unit columns throughout, zero decimal/float usage anywhere in `schema.ts`).

---

## 8. Transaction / concurrency considerations

No new concurrency primitive is required:

- Tax-rate resolution reads an **immutable** row (`tax_rates` is create-only) inside the existing `withTenant()` transaction — nothing else can be racing to mutate what's being read, so no additional locking is needed beyond the transaction boundary that already exists for `create()`/`update()`.
- The EXCLUDE constraint already guarantees the resolution query returns at most one row; Phase 2 introduces no new opportunity for the two-layer pre-check/catch race pattern Phase 1 needed for `tax_rates.create()` — that race is specific to _creating_ an overlapping rate, not _reading_ one.
- Bill/debit-note posting concurrency (`ap-bill-concurrency.e2e-spec.ts`'s scenarios — concurrent posts, concurrent-post-vs-period-close) is entirely unaffected, since posting itself does not touch tax resolution (§3) — only pre-resolved, already-stored `taxAmountMinor` values.
- **One genuine edge case worth naming, not a blocker:** a bill/debit-note is editable while `DRAFT`, and `billDate`/`debitNoteDate` can be changed independently of `lines` in a separate `PATCH`. If a caller changes the document's date **without** resubmitting `lines` in the same call, already-resolved line-level tax snapshots are **not** automatically re-resolved against the new date — they remain frozen from whenever `lines` was last written. This is consistent with "snapshot" semantics (deliberately sticky, not live-tracking) and carries no correctness/audit risk because the document is still unposted and fully re-editable; it is a UX consideration for whichever client consumes this API (e.g., resubmit `lines` after changing the date, or have the UI re-resolve client-side before displaying). Flagged here for awareness, not raised as a CTO decision — it is a direct, low-risk consequence of the already-approved "full-array-replace on `lines`" update pattern (pre-existing, unrelated to this phase) combined with Decision 6.

---

## 9. Schema / migration impact

New nullable columns on **both** `supplier_bill_lines` and `supplier_debit_note_lines` (identical shape on each):

```ts
taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
taxAmountCalculatedMinor: bigint("tax_amount_calculated_minor", { mode: "number" }),
taxAmountOverridden: boolean("tax_amount_overridden").notNull().default(false),
```

plus two CHECK constraints per table (declared inline in `schema.ts`, same `check()` helper already used throughout — **not** the `drizzle/constraints/*.sql` mechanism, which is reserved for EXCLUDE/triggers Drizzle can't express and is not needed here):

```sql
CHECK (tax_amount_overridden = false OR tax_code_id IS NOT NULL)   -- override requires a resolved code
CHECK (tax_rate_id IS NULL OR tax_code_id IS NOT NULL)             -- a resolved rate implies a code
```

`taxAmountMinor` itself is **unchanged** (already `bigint not null default 0`) — it continues to be the one authoritative column every existing total/CHECK/posting-journal computation already reads.

This is one ordinary Drizzle-generated migration (`pnpm run generate` + review + `pnpm run migrate`), following the exact same review/rename convention Phase 1 used (`0017_tax_configuration.sql`, not the auto-generated random name). **No changes are needed to:**

- `drizzle/rls/*.sql` (row-level policies aren't column-scoped),
- `drizzle/constraints/*.sql` (no EXCLUDE or new trigger required — see §1.4/§1.9),
- `apply-db-constraints.ts` / `apply-rls.ts` (Decision 7's pipeline fix from Phase 1 already covers whatever migration Phase 2 adds, generically),
- the immutability triggers on `supplier_bill_lines` (006) or `supplier_debit_note_lines` (017) — both are **blanket** ("no mutation of any kind once parent POSTED"), so the new columns are automatically covered without touching the trigger SQL.

**One forward-looking note, not an action item for this phase:** `005_supplier_bills_immutability_trigger.sql` (the _header_ trigger) uses an **explicit column-by-column whitelist**, unlike the blanket line-level and debit-note-header triggers. Phase 2 adds no new columns to `supplier_bills` or `supplier_debit_notes` headers, so this does not need to change now — but if a future phase ever adds a header-level column to `supplier_bills` that must be immutable post-POSTED, that trigger's function must be explicitly extended (a new `CREATE OR REPLACE FUNCTION` constraint file), or the new column would silently escape the immutability check. Recorded here so it isn't rediscovered the hard way later.

---

## 10. RLS / RBAC / audit impact

- **RLS:** none. No new tables; existing `tenant_isolation` policies on both `*_lines` tables already cover every column, present and future (verified §1.5).
- **RBAC:** none. Tax-code selection is just new optional fields on the existing `finance.poster`-gated create/update routes; no new routes, no new roles.
- **Audit:** none needed beyond what already exists. `SupplierBillsService`/`SupplierDebitNotesService` already audit-log the full `before`/`after` row state (including all line data) on every CREATE/UPDATE/POST — the new columns ride along automatically since audit payloads are the full Drizzle row object, not a hand-maintained field list.

---

## 11. Regression and new test plan

**Regression (must stay green, unmodified in intent):**

- `test/supplier-bills.e2e-spec.ts` (29 tests) — all existing legacy manual-`taxAmountMinor` behavior must be byte-for-byte unchanged when `taxCodeId` is omitted.
- `test/supplier-debit-notes.e2e-spec.ts` (33 tests) — same, for debit notes and their allocation logic (entirely untouched by this phase).
- `test/ap-bill-concurrency.e2e-spec.ts` (3 tests) — unaffected; confirms posting concurrency behavior is unchanged.
- `test/tax-configuration.e2e-spec.ts` (27 tests) — Phase 1 regression, unaffected (Phase 2 only reads `tax_codes`/`tax_rates`, never writes them).
- `src/route-role-matrix.spec.ts` — unaffected; no new routes.

**New tests (recommended location: new "Tax calculation" `describe` blocks inside the existing `supplier-bills.e2e-spec.ts` and `supplier-debit-notes.e2e-spec.ts` files, mirroring how those files are already organized by feature area, rather than a new cross-cutting spec file):**

1. `taxCodeId` omitted → legacy manual `taxAmountMinor` behavior exactly preserved (both explicit value and default-0).
2. `taxCodeId` supplied, no explicit `taxAmountMinor` → correct calculation at the line's own `amountMinor`/`rateBasisPoints`, correct rounding, `taxAmountOverridden = false`, `taxRateId` snapshot set, header totals correct.
3. `taxCodeId` + explicit `taxAmountMinor` both supplied → supplied value authoritative, `taxAmountCalculatedMinor` populated and correct, `taxAmountOverridden = true`.
4. Inactive `taxCodeId` → rejected (400) at create and at update.
5. `taxCodeId` valid but no `tax_rates` row covers the document's date → rejected, not silently zero.
6. Two different lines on the same document resolving two different tax codes/rates correctly and independently.
7. Rate-effective-date boundary: a rate change between two `tax_rates` rows resolves the correct one on each side of the boundary date (reuses Phase 1's non-overlap fixture pattern).
8. Historical correctness: after a newer `tax_rates` row is created for a later period, a previously-created line's already-snapshotted `taxRateId`/`taxAmountMinor` is provably unchanged (re-`GET` the document).
9. Cross-tenant / cross-legal-entity isolation: a `taxCodeId` from another legal entity is rejected exactly like an out-of-scope `accountId` today (400).
10. Debit-note-specific: a debit note allocating to **two different bills**, with its own lines independently tax-coded on the debit note's own date, unaffected by either allocated bill's own tax coding — proves the "no inheritance, independent per-document resolution" design decision in §13 holds end-to-end.
11. Posting unaffected: post a bill/debit note with tax-coded lines and confirm the journal's aggregate tax line still equals `SUM(line.taxAmountMinor)`, identical shape to the pre-Phase-2 posting tests.
12. DB-level proof (matching Phase 1's `tax-configuration.e2e-spec.ts` style): the two new CHECK constraints (`taxAmountOverridden` implies `taxCodeId`; `taxRateId` implies `taxCodeId`) reject a raw-SQL attempt to violate them, bypassing the service layer.

---

## 12. Risks and interactions

- **Decision 1 vs. the actual data model** — the single largest risk in this phase; see §13, Decision Required #1. Implementing literal "inheritance" is not just harder, it is **structurally undefined** given the current one-to-many debit-note-to-bills allocation shape. Proceeding without CTO confirmation of the reinterpretation in §13 risks building the wrong thing.
- **Draft-date-change-without-line-resubmit** edge case (§8) — no correctness risk, but worth the implementer's and any future UI's awareness.
- **`005`'s explicit-whitelist immutability trigger** (§9) — not a Phase 2 risk (no header columns added), but a landmine for whichever future phase does touch `supplier_bills` header columns; recorded so it isn't missed.
- **No interaction with AP-1c payment posting or `ap-bill-concurrency` scenarios** — verified: tax resolution happens at line-write time, strictly before any posting-time code path both features already exercise.
- **No interaction with the AR side** — `customerInvoices`/`customerInvoiceLines`/`customerCreditNotes`/`customerCreditNoteLines` are structurally near-identical to the AP pair (confirmed by inspecting their `schema.ts` definitions), which means the same design (§3–§9) should transfer cleanly to a future AR phase — but AR's own posting/immutability/RLS files were not re-verified in this discovery round (out of scope, AP-only per the authorized task), so a future AR phase needs its own discovery, not a blind copy of this document.

---

## 13. Decisions requiring CTO confirmation

### Decision Required #1 — Debit-note tax "inheritance" is not mechanically definable as originally worded; recommend independent per-document resolution instead

The approved Decision 1 states: _"Credit/debit notes inherit the original document's tax code and snapshotted tax rate... must NOT independently select a different tax code/rate."_ Verified against the actual repository, this cannot be implemented literally:

- A supplier debit note has **no single "original document."** Its only link to any bill is the `supplier_debit_note_allocations` table, which is **many-to-many at header level** — one debit note can (and the service explicitly supports and locks for) allocate against **multiple** bills in one posting.
- Even for a debit note allocated to exactly one bill, there is **no line-level correspondence** between a debit-note line and a bill line — debit-note lines are freely authored with their own `accountId`/`amountMinor`, structurally unconnected to any bill line's own account or amount. There is nothing to "inherit from" at the granularity tax needs to be calculated at (the line).
- Decision 6, approved in the **same** CTO turn, already lists "supplier debit note date" as its **own** independent rate-resolution date — separate from "supplier bill date." Read literally, Decision 1 (no independent resolution, pure inheritance) and Decision 6 (resolve using the debit note's own date) are in tension: if a debit note purely inherited its rate, its own date would never need to enter into resolution at all. The most consistent reading of the two decisions together is that Decision 6 already anticipates independent, date-based resolution per document — which is what this discovery recommends implementing outright.

**Recommendation:** treat `supplier_debit_note_lines` exactly like `supplier_bill_lines` — an independent, optional `taxCodeId` per line, resolved via the same mechanism, using the debit note's **own** `debitNoteDate` (per Decision 6). This is the "better/safer approach the repository shows" per this task's own mandate: it requires no schema redesign (no new line-to-line FK, no change to the allocation model), it is consistent with Decision 6 as approved, and it avoids the undefined "which of N allocated bills" question entirely. It does **not** literally satisfy Decision 1's "inherit... must not independently select" wording — this document surfaces that gap explicitly rather than silently reinterpreting an approved decision. **This phase should not proceed on the debit-note side until the CTO either (a) approves this reinterpretation of Decision 1, or (b) specifies an alternative** (the only structurally faithful alternative found is a materially larger schema change — line-level allocation linking debit-note lines to specific bill lines — which is a different, bigger feature than "Phase 2" was scoped as, and is not recommended).

### Decision Required #2 (minor, flagged for completeness, not blocking) — CHECK constraints on the new line columns

§9 proposes two CHECK constraints (`taxAmountOverridden` implies `taxCodeId`; `taxRateId` implies `taxCodeId`) as defense-in-depth, matching this codebase's general style of backing every service-layer invariant with a DB-level CHECK. These are new invariants not explicitly itemized in the original 7 decisions (they're a direct mechanical consequence of Decision 4, similar in nature to the `taxAmountCalculatedMinor` column already flagged as a mechanical consequence during the Phase 1 planning turn). Noted here for visibility; recommend proceeding with them as part of normal implementation rather than treating them as a separate gate item, consistent with how the equivalent Phase 1 addition was handled.

---

## 14. Implementation sequence (once authorized)

1. Resolve Decision Required #1 (blocking for the debit-note half of this phase; the bill half has no equivalent ambiguity and could in principle proceed independently, but implementing both together is recommended since they share the same DTO/service/migration shape).
2. Schema: add the four new columns + two CHECK constraints to both `supplierBillLines` and `supplierDebitNoteLines` in `schema.ts`; generate, review, rename, and apply the migration.
3. `TaxRatesService.resolveEffectiveRate()` (new method); wire `TaxConfigurationModule` into `SupplierBillsModule` and `SupplierDebitNotesModule`.
4. DTOs: add optional `taxCodeId` to `CreateSupplierBillLineDto` and `CreateSupplierDebitNoteLineDto`.
5. Service logic: extend `insertLines()`/the validation pass in both `SupplierBillsService` and `SupplierDebitNotesService` per §3.
6. Tests per §11 — unit (DTO validation) + e2e (both files' new describe blocks) + the DB-level CHECK-constraint proof.
7. Full regression run (§11's existing suites) + typecheck + lint.
8. Verification report in the same format Phase 1 used: files changed, schema changes, endpoints changed, tests executed/results, migration verification, any deviations from this document.

---

## 15. Acceptance criteria

- [ ] `taxCodeId` omitted on any bill or debit-note line → byte-for-byte identical behavior to pre-Phase-2 (all existing regression tests pass unmodified).
- [ ] `taxCodeId` supplied → correct rate resolved by the document's own transaction date, correct integer minor-unit line-level rounding, header totals unchanged in formula.
- [ ] `taxCodeId` + explicit `taxAmountMinor` → override recorded per Decision 4's exact table (§6), nothing silently discarded.
- [ ] Inactive tax code, or no effective rate for the document's date → rejected, never silently defaulted to zero.
- [ ] Snapshot is permanent: a later `tax_rates` change never alters an already-written line.
- [ ] No changes to posting logic, journal-line shape, RLS policies, or RBAC roles.
- [ ] Debit-note tax resolution is independent per line, using the debit note's own date — explicitly verified by a test with multi-bill allocation (§11 item 10).
- [ ] All CHECK constraints verified directly at the DB level, bypassing the service layer.
- [ ] Full existing regression suite green; no unintended diff outside the files listed in §2.

---

## 16. Out of scope / deferred (unchanged from the roadmap's own framing)

- AR wiring (Customer Invoices, Customer Credit Notes) — later phase, own discovery required (§12).
- VAT report / return — later phase.
- Per-tax-code GL account mapping — out of MVP per Decision 5, unaffected by this phase.
- Reverse charge — out of MVP per Phase 1's own schema comment.
- FX — untouched; tax calculation operates purely in the document's own already-resolved `currencyCode`/minor units, same as every other amount on these documents.
- UI/frontend work.
- Any change to `tax_codes`/`tax_rates` themselves (Phase 1 is consumed read-only).

---

## 17. Reconciliation with roadmap/state documents

- **`docs/roadmap.md`** — read in full. Already accurate: explicitly names "Tax/VAT Phase 2 — AP Tax Calculation" as the next approved work item, with a description matching this document's scope, and states the execution gate requires separate CTO authorization. **No update made** (none needed).
- **`docs/project/CURRENT_PHASE.md`** — read in full. Describes the NOAH orchestrator workstream's own Stage 1A/1B boundary, unrelated to Finance. **No update made** (none needed — accurate for its own subject).
- **`docs/project/NEXT_TASK.md`** — read in full. Describes the orchestrator's own Stage 1B implementation task, explicitly out of Finance/`services/` scope. **No update made** (none needed — accurate for its own subject).
- **`docs/project/PROJECT_STATE.md`** — read in full. Its "Repository implementation state" section was stale: it still named "Scheduled Reversal... (Revision 2)" as the current `main` commit and referenced commit `733c3070...`, predating both Tax/VAT Phase 1 (`dd6d135`) and the subsequent Stage 1A-close/Stage 1B-ratification commits now on `main`. **This document's author corrected that one paragraph** to name the actual current `main` state (Tax/VAT Phase 1 complete, this discovery as the pending next gate) — see the diff in the accompanying commit. No other section of that file needed correction.

---

## 18. Summary for the implementer

Everything needed to implement Phase 2 without a further discovery round is in this document: exact files (§2), exact schema (§9), exact service-layer algorithm (§3, §5, §6), exact test plan (§11), and the one real open question (§13 #1) that must be answered by the CTO before the debit-note half can proceed. The bill half of this phase has no equivalent open question and is fully specified.

**DISCOVERY STATUS: BLOCKED — Decision Required #1 (§13): the approved Decision 1 ("credit/debit notes inherit the original document's tax code and snapshotted tax rate... must not independently select a different tax code/rate") is not mechanically implementable against the actual `supplier_debit_notes`/`supplier_debit_note_allocations` data model (no single original document; many-to-many bill allocation; no line-level linkage). This document recommends a specific, narrowly-scoped reinterpretation (independent per-line resolution on the debit note's own date, consistent with the already-approved Decision 6) that requires explicit CTO confirmation before the debit-note half of Phase 2 is implemented. The Supplier Bill half of this phase has no equivalent blocker and could proceed on its own if the CTO prefers to split authorization.**
