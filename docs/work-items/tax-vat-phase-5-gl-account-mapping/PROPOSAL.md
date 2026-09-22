# Tax/VAT Phase 5 — Architecture & Implementation Proposal

**Prepared by:** Architect + Principal Engineer role, this iteration, architecture/proposal only.
**Baseline verified:** local `main` == `origin/main` == GitHub `main` @ `8ccdec5da3ab663dc896660d0b92e646e46f30e3` (Tax/VAT Phase 4 completion report). Re-confirmed by `git fetch origin main` at the start of this iteration.
**Scope of this iteration:** architecture review and proposal ONLY. No production code, schema, or migration was written or modified. No commit or push was made. `docs/roadmap.md` and `docs/project/PROJECT_STATE.md` were read but not edited. Nothing was marked complete.
**Input reviewed:** `docs/finance-work-item-tax-vat-phase-5-discovery.md` (284 lines, read in full) — treated as a claim set to independently verify, not as approved fact.

---

## 1. Executive Recommendation

**MODIFY BEFORE IMPLEMENTATION.**

The core architectural direction in the existing discovery document is sound and should proceed: additive nullable schema, a per-line GL-account resolution that falls back to today's singleton behavior when unconfigured, and a historically-immutable snapshot so the VAT Position Report's GL cross-check stays correct regardless of later remapping. None of that is wrong, and none of it should be reopened.

But independent verification against the actual repository (not the discovery document's description of it) found one real mechanical defect in _how_ the discovery says the snapshot gets written, one materially under-costed implementation detail, and one API-contract question the discovery never addresses at all. None of these invalidate the phase. All three are correctable without changing the phase's scope, size, or the six decisions already reasoned through in the discovery. This is not a rubber stamp of an existing document — §3 below identifies exactly what was confirmed, what was wrong, and what was missing, with the code citations backing each finding.

## 2. What I Verified

Read directly from the live repository during this iteration (not assumed from the discovery document's description):

- `git branch --show-current` = `main`; `git fetch origin main` → `origin/main` = `8ccdec5...` = local `HEAD`. `git status --short` → only `?? docs/hardening/` and the two Phase 5 discovery-only Markdown files from prior iterations — no code, schema, or migration changes exist in the working tree.
- `services/sphere-finance/src/db/schema.ts`: `taxCodes` (no GL account field), `taxRates` (effective-dated, immutable), `apSettings.taxInputAccountId`/`arSettings.taxOutputAccountId` (nullable singleton FKs, no `accountType` constraint, doc-commented as deliberately jurisdiction-agnostic), `chartOfAccounts` (tenant + **legal-entity**-scoped, confirms tax-account validation must stay legal-entity-scoped).
- `services/sphere-finance/drizzle/migrations/`: latest is `0019_tax_vat_phase_3_ar_calculation.sql` — Phase 4 added zero migrations, confirmed; next would be `0020`.
- `services/sphere-finance/drizzle/constraints/`: all 25 files listed and the immutability-trigger set inspected directly, in particular `006_supplier_bill_lines_immutability_trigger.sql`, `010_customer_invoice_lines_immutability_trigger.sql`, `014_customer_credit_note_lines_immutability_trigger.sql`, `017_supplier_debit_note_lines_immutability_trigger.sql` — **read in full**, not assumed from naming. Also `002_balance_invariant_trigger.sql` (the deferred double-entry balance check).
- `SupplierBillsService`: `create()` (full, lines 101–170), `post()` (full, lines 392–600+), `resolveLineTax()` (full, lines 891–938), `update()`'s immutability guard (line 247–249), `revalidateLineAccountsForPostingOrThrow` call site (line 423). The AR/AP siblings (`SupplierDebitNotesService`, `CustomerInvoicesService`, `CustomerCreditNotesService`) were spot-checked for the same `resolveLineTax` signature and call-site shape (confirmed identical, including the debit-note/credit-note "no `allocations` parameter" no-inheritance signature already established in Phase 2/3).
- `TaxRatesService.resolveEffectiveRate()` (full) — a finding not in the discovery document, see §3.
- `TaxReportsService`: `VatPositionGlCrossCheck`/`VatPositionMeta`/`VatPositionResult` interfaces (full), `getGlCrossCheck()` (full), `glMovement()` (full) — read directly, not assumed from the discovery's prose description.
- `route-role-matrix.spec.ts`: `TaxCodesController`'s current 7-route `EXPECTED` entries, confirmed exact route strings and role sets.
- `docs/roadmap.md`, `docs/project/PROJECT_STATE.md` — both re-read in full this iteration; both consistent with the discovery's baseline claims (Phases 1-4 COMPLETE, Phase 5 "not yet discovered or authorized" language now superseded by the discovery document itself, still not authorized for implementation).
- `docs/project/CURRENT_PHASE.md`/`NEXT_TASK.md`/`DECISIONS.md` — confirmed (again) to describe the unrelated NOAH/Orchestrator Stage 1B workstream, out of scope.
- Phase 2/3/4 discovery and completion reports — used as the precedent baseline for every "matches established convention" claim below; not re-quoted at length here since they are already fully cited inside the Phase 5 discovery document itself.

## 3. Discovery Validation

Every load-bearing claim in `docs/finance-work-item-tax-vat-phase-5-discovery.md`, assessed against the actual repository:

**§3.1 "`tax_codes` has no GL account field; the same code is used on both AP and AR lines with no direction restriction"** — **CONFIRMED.** Verified directly in `schema.ts`; no direction column, no check constraint restricting a code to one subledger.

**§3.2 "All four posting services write exactly one aggregate tax journal line, always at the singleton account"** — **CONFIRMED** for `SupplierBillsService.post()` (read in full — the discovery's quoted snippet is a verbatim, accurate excerpt of the real code, lines 508–518). The discovery's claim that the AR/AP siblings mirror this "reversed" is **CONFIRMED by the pattern's consistency** across the codebase (identical `resolveLineTax` shape, identical settings-account dependency), though this iteration did not re-read every line of all three sibling `post()` methods byte-for-byte — a targeted spot-check found no deviation, and none is expected given how tightly Phase 2/3 already enforced this symmetry.

**§3.3 "The VAT Position Report's GL cross-check reads only the two singleton accounts, and this must change"** — **CONFIRMED**, and more precisely than the discovery states it. Direct read of `getGlCrossCheck()`/`glMovement()` shows the cross-check doesn't just "read the singleton accounts" abstractly — it hardcodes a **single-account response shape** (`VatPositionGlCrossCheck.taxOutputAccountId: string | null`, singular, not an array) and `glMovement()`'s signature takes exactly one `accountId: string`, not a set. The discovery's §6.4/§13.4 fix describes the _query_ logic changing to a union of accounts, but never once addresses that the **public API response shape** of an already-shipped, already-tested endpoint would also need to change to expose more than one account per direction. This is a real gap — see §8 below for the resolution.

**§3.4 "`tax_codes` is create-only + deactivate/reactivate, no general edit route"** — **CONFIRMED**, verified directly against `route-role-matrix.spec.ts`'s `EXPECTED` array (exact 7 routes match the discovery's list).

**§6.3 "The GL account is resolved and the snapshot written inside `post()`"** — **INCORRECT, and this is the central finding of this review.** The discovery's own pseudocode places `resolvedTaxAccount()`/the new snapshot write inside `post()`, alongside `taxByAccount` construction. Direct read of `SupplierBillsService.post()` in full shows:

- `post()` **never writes to `supplier_bill_lines` at all** — it only reads `before.lines` (already fully resolved during `create()`/`update()`, while the document was still `DRAFT`) and writes to `journal_entries`/`journal_lines`/the `supplier_bills` header.
- `supplier_bill_lines` (and its three AR/AP siblings) carry a **database-level** trigger (`prevent_posted_supplier_bill_line_mutation()`, `006_supplier_bill_lines_immutability_trigger.sql`, and its three siblings) that fires `BEFORE INSERT OR UPDATE OR DELETE` and raises an exception if the **parent document's current status** is `POSTED` — with no exceptions, explicitly including appending new data ("Blocks INSERT as well as UPDATE/DELETE — appending a new line to an already-posted bill would be just as much a rewrite of history as editing an existing one").
- `post()`'s own Step 10 (the last write in the transaction) is exactly the statement that flips `supplier_bills.status` to `POSTED`. If a _new_ write to `supplier_bill_lines` (to set a snapshot column) were inserted into `post()` as the discovery describes, it would have to be sequenced **before** that flip — a real, previously-undocumented ordering hazard the discovery never mentions, in a method the discovery never actually re-reads in full for this specific claim.
- **The correct fix is not "be careful about ordering inside `post()`" — it is "don't write the snapshot in `post()` at all."** `resolveLineTax()` (called only from `create()`/`update()`, never from `post()`) is _already_ exactly where the equivalent Phase 2/3 snapshot fields (`taxRateId`, `taxAmountCalculatedMinor`, `taxAmountOverridden`) are resolved and written — while the document is still `DRAFT`, before any immutability trigger is in play at all. The GL-account resolution belongs in the same method, at the same time, for the same reason. `post()` should only ever _read_ the already-resolved value back (exactly as it already reads `line.taxAmountMinor`, `line.accountId`, etc.) — it needs zero new write path.

**§13.4 "Named `postedTaxAccountId`... populated whenever `resolvedTaxAccount()` runs"** — **PARTIALLY CONFIRMED.** The _mechanism_ (a per-line snapshot column, populated once, read back unconditionally by the report) is correct and is retained in this proposal. The _name_ is now misleading given the corrected timing (§4 below): it is resolved at the document's last `DRAFT` edit, not literally "at posting," and per-precedent naming (`taxRateId`, not `postedTaxRateId`) supports dropping the "posted" qualifier.

**§13.4 "one extra `SELECT`... negligible cost"** — **INCORRECT in a way that makes the design _better_, not worse.** Direct read of `TaxRatesService.resolveEffectiveRate()` shows it **already** calls `this.taxCodes.findByIdInTx(tx, legalEntityId, taxCodeId)` internally — fetching the full `tax_codes` row (for its existing `isActive`/`code` validation) — and then discards everything except the resolved `TaxRate`. The GL-account fields this phase needs (`apTaxAccountId`/`arTaxAccountId`) are **already being fetched on every line resolution today**; they are simply not returned. Extending `resolveEffectiveRate()`'s return shape to also expose them costs **zero additional queries**, not "one extra `SELECT` per line" as estimated. See §5/§15.

**§13.5 "Immutability verified directly in code"** — **CONFIRMED**, but the discovery cited only the _service-layer_ `ConflictException` guard (`update()`'s `if (before.status !== "DRAFT")`). This iteration additionally found and verified the **database-level** trigger, which is the authoritative enforcement (the service-layer check is a fast, friendly 409 in front of it; the trigger is what actually makes the invariant true even against a bug or a raw SQL client). This strengthens the discovery's conclusion; it does not weaken it — but the discovery under-cited its own strongest piece of evidence, and that same trigger is exactly what the §6.3 timing error above collides with.

**§6.4/§13.8 Decision 4/6 "GL cross-check must be updated this phase"** — **CONFIRMED as a requirement**; the _shape_ of the required change is bigger than described (§3.3 above — an API response-shape decision, not only a query-logic one).

**§2's candidate-exclusion table (statutory filing / reverse charge / multi-jurisdiction / tax-inclusive pricing require external input; manual-journal-entry coverage is real but smaller)** — **CONFIRMED**, and independently re-derived rather than taken on faith — see the CTO-level question section below.

**Overall:** the discovery's _destination_ (additive schema, per-line snapshot, historically-correct cross-check) is correct. Its _route_ to that destination — specifically, writing the snapshot inside `post()` — is wrong in a way that would have caused a real implementation defect (either a database exception from the immutability trigger, if sequenced after the status flip, or a fragile "insert this new write very carefully before this other write" instruction if sequenced correctly by luck rather than by design). This is exactly the kind of thing an independent review is for.

## 4. Architectural Assessment

The corrected architecture, in one paragraph: a tax code optionally carries an `apTaxAccountId`/`arTaxAccountId` override (unchanged from the discovery, §6.1/Decision 3). When a document line is resolved — in `resolveLineTax()`, at `create()`/`update()` time, while the document is `DRAFT` — the effective tax GL account for that line is computed (the code's direction-appropriate override, else the legal entity's singleton settings account) and stored on the line alongside the already-existing `taxRateId`/`taxAmountCalculatedMinor` snapshot fields. `post()` is **unchanged in shape**: it still only reads already-resolved line data to build journal entries; the one behavior change is that it now **groups** tax by each line's already-resolved account (instead of assuming every line shares the settings account) when constructing `journalLineValues`, exactly as the discovery's §6.3 pseudocode already showed — the correction is only about _where the resolution and the write happen_, not what `post()` does with the result.

This fits NoryX's established architecture on every axis that matters here: it reuses the exact "optional override, fallback to existing behavior, resolved once at draft-time, immutable snapshot" shape Phase 2/3 already established for `taxCodeId`/`taxRateId`/`taxAmountCalculatedMinor`; it introduces no new resolution algorithm (unlike the rejected effective-dated-history alternative); it touches the Journal Engine not at all (unlike the rejected journal-derived alternative); and it treats the VAT Position Report exactly the way Phase 4 itself treated `journal_lines` — as a secondary cross-check layer that must move in lockstep with the posting change, never as the primary source of truth for tax-code attribution.

## 5. Data Model

**On `tax_codes`** (unchanged from discovery §6.1/Decision 3 — still correct):

```sql
ALTER TABLE tax_codes
  ADD COLUMN ap_tax_account_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN ar_tax_account_id uuid REFERENCES chart_of_accounts(id);
```

- **Why two independent columns, not one + a direction enum, not a join table:** a single tax code is usable on both AP and AR documents today (§3, confirmed no direction constraint exists); a single `glAccountId` + `direction` field would force an artificial one-direction-only restriction the schema has never had. A join table (`tax_code_gl_accounts(tax_code_id, direction, account_id)`) would be more "normalized" but buys nothing — there are exactly two directions, ever, for the life of this schema's design (AP/input, AR/output), so two named columns are simpler to read, simpler to index, and match the exact precedent `ap_settings.taxInputAccountId`/`ar_settings.taxOutputAccountId` already set.
- **Ownership:** `TaxConfigurationModule` (owns `tax_codes` already).
- **Scope:** inherits `tax_codes`' existing `(tenant_id, legal_entity_id)` RLS scope — no new RLS policy needed.
- **FK behavior:** references `chart_of_accounts.id`, same as every other tax-account FK in this schema (`ap_settings.taxInputAccountId`, `ar_settings.taxOutputAccountId`) — no `ON DELETE` behavior needed because `chart_of_accounts` rows are never hard-deleted (deactivate-only, same convention as `tax_codes` itself).
- **Uniqueness:** none required — nullable, independent, no composite constraint.
- **Nullability:** both nullable, no default. `NULL` means "no override — use the legal entity's singleton settings account," identical in shape to how `taxCodeId` being `NULL` on a line means "legacy manual tax, no code resolution."
- **Historical immutability:** **not applicable to this table** — `tax_codes` rows are ordinary mutable configuration (like `ap_settings`/`ar_settings` already are); the historical-immutability requirement applies to the _line tables_ below, not to this configuration table itself. This is precisely the distinction §13 of the discovery draws and this proposal preserves.
- **Effective-dating:** **not required.** See §7 for the full reasoning (unchanged from discovery §13.6, independently re-affirmed in this review): GL-account mapping is an operational bookkeeping choice with no calendar-driven regulatory shape, unlike `tax_rates`. Modeling it as effective-dated would add a second, parallel "resolve what applied on date D" algorithm for no correctness benefit, since the _actual_ historical fact is captured directly on each line (below) regardless of what the configuration says later.
- **Deletion behavior:** none — these are plain nullable columns on an existing table, no delete semantics of their own.
- **Migration strategy:** one new file, `0020_tax_vat_phase_5_gl_account_mapping.sql`, purely additive `ALTER TABLE ... ADD COLUMN` statements (see below for the full six-column set) — no backfill required for these two columns (unset = today's behavior, by construction).

**On the four tax-bearing line tables** (corrected from discovery §13.4 — same columns, corrected purpose/name/timing):

```sql
ALTER TABLE supplier_bill_lines        ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE supplier_debit_note_lines  ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_invoice_lines     ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_credit_note_lines ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
```

- **Renamed** from the discovery's `postedTaxAccountId` to `resolvedTaxAccountId` — it is written at `resolveLineTax()` time (draft create/last edit), matching `taxRateId`'s naming register (which also does not say "posted") rather than implying a post-time write that, per §3 above, does not and should not exist.
- **Why it exists:** this is the historical-fact record the VAT Position Report's GL cross-check reads back, so that a later change to `tax_codes.apTaxAccountId`/`arTaxAccountId` (or to the singleton settings account) can never retroactively alter what a historical window's cross-check computes. See §7 for the full correctness argument (carried over from discovery §13.4's proof, unchanged in substance — only the write-site is corrected).
- **Ownership:** each line table's own owning service (`SupplierBillsService`, etc.) — same as every other field on these lines.
- **Scope:** inherits the line table's existing `(tenant_id, ...)` RLS scope; no new policy.
- **FK behavior:** references `chart_of_accounts.id`; no `ON DELETE` behavior, consistent with `accountId`'s own existing FK on the same tables.
- **Uniqueness:** none.
- **Nullability:** nullable — `NULL` for a zero-tax line (nothing was resolved, matching `taxRateId`'s own `NULL`-when-`taxCodeId`-is-`NULL` behavior) and, until backfilled, for every line posted before this migration ships (§9).
- **Historical immutability:** enforced by the **existing** DB-level triggers (`006`/`010`/`014`/`017`) with **zero trigger changes needed** — those triggers block any mutation to the row once the parent is `POSTED`, and they check "any column changed," not a specific column list, so the new column is automatically covered the instant it exists. This is also exactly _why_ the write must happen before the parent leaves `DRAFT` (§3's central finding) — the same protection that makes the column trustworthy is what makes writing it inside `post()` impossible.
- **Effective-dating:** not applicable — a stored fact, not a resolved-on-demand value.
- **Deletion behavior:** none of its own; deleted only as part of the line row's own (already-existing, DRAFT-only) deletion path.
- **Migration strategy:** same single `0020` file as above, four more additive `ALTER TABLE ... ADD COLUMN` statements. No backfill required to ship correctly (§9 covers the legacy tail); an optional, separate, explicitly-audited backfill is described there for tenants who want the pre-migration tail exact rather than best-effort.

**Full migration file contents (six columns, one file, no other schema change):**

```sql
ALTER TABLE tax_codes
  ADD COLUMN ap_tax_account_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN ar_tax_account_id uuid REFERENCES chart_of_accounts(id);

ALTER TABLE supplier_bill_lines
  ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE supplier_debit_note_lines
  ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_invoice_lines
  ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_credit_note_lines
  ADD COLUMN resolved_tax_account_id uuid REFERENCES chart_of_accounts(id);
```

No new table. No new index required beyond what the four line tables' report-query already relies on (they are already scanned by `tenant_id`/`legal_entity_id`/status/date for the report's existing net-tax computation; adding one more selected column to an already-scanned row costs nothing extra). No new constraint, no new trigger — the existing immutability triggers already cover the new columns for free.

## 6. Posting Flow

**Where resolution happens (corrected):** `resolveLineTax()`, called from `create()` and `update()`, while the document is `DRAFT`. Not `post()`.

**Resolution logic, per line, identical shape for all four document types:**

1. If `line.taxCodeId` is unset → legacy manual line. `resolvedTaxAccountId = NULL` if `taxAmountMinor` is 0; otherwise falls back to "the direction's singleton settings account, evaluated now" purely for the _journal posting_ to use later — but the discovery's own point stands: without a code, there is nothing more specific to snapshot than "whatever the singleton is," so the honest design is to snapshot the singleton's _current_ value into `resolvedTaxAccountId` at this same draft-time moment too (unconditional population, per discovery §13.4/§13.6 — retained in this proposal), so legacy lines get exactly the same historical-attribution correctness as coded lines, at no extra cost.
2. If `line.taxCodeId` is set → `TaxRatesService.resolveEffectiveRate()` is called exactly as today (unchanged signature, unchanged rate resolution), **extended** to also return the resolved tax code's direction-appropriate account field (`apTaxAccountId` for `SupplierBillsService`/`SupplierDebitNotesService`, `arTaxAccountId` for `CustomerInvoicesService`/`CustomerCreditNotesService`) — reusing the `tax_codes` row `resolveEffectiveRate()` already fetches internally today for its `isActive` check (§3 — zero new queries).
3. `resolvedTaxAccountId = taxCode.<direction>TaxAccountId ?? <the direction's singleton settings account>`. This requires `resolveLineTax()` (and therefore `create()`/`update()`) to also load `ap_settings`/`ar_settings` — a cheap, single-row-by-primary-key lookup already performed elsewhere in these same services (`loadApSettingsOrThrow`, currently only called from `post()`) — reused, not duplicated.

**Where posting behavior changes:** only in how `post()` builds `journalLineValues` for the tax portion. Today: one line, `taxTotal`, the singleton account, unconditionally. Proposed: group `before.lines` by each line's **already-resolved** `resolvedTaxAccountId` (a plain in-memory `Map<accountId, summedMinor>`, iterated in insertion order for deterministic `lineNumber` assignment) and emit one journal line per distinct account. `post()` reads; it does not resolve, and it does not write to the line tables.

**Debit/credit polarity — unchanged from Phase 2/3/4, for all four document types, regardless of how many distinct accounts a document's tax decomposes into:**

- **Supplier Bill** — each resolved account gets a **debit** line for that account's summed tax (input tax, asset/expense-side per the account's own configured nature — deliberately unconstrained by `accountType`, per §3.1's cited doc comment).
- **Supplier Debit Note** — the exact reversal: each resolved account gets a **credit** line (reversing the bill's debit), same grouping logic, same accounts a bill would have used for the same codes.
- **Customer Invoice** — each resolved account gets a **credit** line (output tax, liability-side).
- **Customer Credit Note** — the exact reversal: each resolved account gets a **debit** line.

**Multiple tax codes / multiple tax lines on one document:** fully supported by the grouping — if two lines use two codes that both resolve to the _same_ account (the common case, and every existing fixture/test), the output is byte-identical to today (one journal line). If they resolve to _different_ accounts, the document now posts two (or more) tax journal lines instead of one — still balanced (the double-entry balance-invariant trigger checks `SUM(debit) = SUM(credit)` per journal entry, unaffected by how many lines carry the debit or credit side, verified directly against `002_balance_invariant_trigger.sql`).

**Overridden tax amounts:** unaffected — `taxAmountOverridden`/`taxAmountCalculatedMinor` govern _how much_ tax a line carries; `resolvedTaxAccountId` governs _where_ it posts. The two are orthogonal and this phase does not touch the override mechanism at all.

**Legacy lines without `taxCodeId`:** continue to resolve to the singleton settings account exactly as today, now additionally snapshotted (point 1 above) for the same historical-correctness reason coded lines get it.

**Journal-line description disambiguation (a refinement this review adds, not present in the discovery):** today's single tax line is always described `"Tax on bill {ref}"`. Once a document can legitimately produce more than one tax journal line, a GL statement reader needs to tell them apart. Recommend appending the resolved account's own code to the description when more than one distinct account is in play for that document (e.g., `"Tax on bill {ref} (2210-STD)"`), falling back to today's exact unqualified string when only one account is involved (byte-identical to current output in the common case, per the backward-compatibility bar). Small, cheap, and closes a real audit-trail gap the discovery never raised.

**Pre-post validation (Decision 5, refined):** the existing check (`taxTotal > 0 && !settings.taxInputAccountId`) must be re-expressed against the now-precomputed `resolvedTaxAccountId` values rather than the current settings value directly — throw only if some tax-bearing line's `resolvedTaxAccountId` is `NULL` at post time (meaning: at its last draft-time resolution, neither an override nor the singleton was configured). Additionally, `revalidateLineAccountsForPostingOrThrow` (§2, already re-validates `line.accountId` at post time independent of draft-time validation, because an account can be archived in between) must be **extended** to also re-validate each distinct `resolvedTaxAccountId` the same way — a real requirement the discovery flagged as risk #2 but did not fold into the concrete implementation plan.

## 7. Historical / Snapshot Semantics

The correctness argument is unchanged in substance from the discovery's §13.4 proof, restated against the corrected write-site:

1. `resolveLineTax()` resolves and writes `resolvedTaxAccountId` exactly once, at `create()`/`update()` time, while the document is `DRAFT` — a state where the immutability triggers permit writes.
2. The moment the document is later posted, the line row (this column included) can never be mutated again — enforced not only by the service-layer `ConflictException` guard but by the database-level trigger itself (§3), which is unconditional and has no bypass.
3. `post()` reads this already-frozen value to decide which account(s) to post to; it performs no resolution and no write of its own.
4. Therefore, for any report window `W`, `accounts(W)` — the set of `resolvedTaxAccountId` values actually present on `POSTED` lines whose document date falls in `W` — is exactly the set of accounts that genuinely carried AP/AR-sourced tax movement in `W`, regardless of anything `tax_codes` or `ap_settings`/`ar_settings` are configured to _now_. This is the discovery's §13.4 proof, and it holds unchanged under the corrected write-site — if anything, it is now _simpler_ to state, because there is no longer any need to reason about a hypothetical write ordering inside `post()` at all.

**What is explicitly NOT immutable, and correctly so:** the `tax_codes.apTaxAccountId`/`arTaxAccountId` configuration itself, and `ap_settings`/`ar_settings`' singleton accounts — these remain ordinary mutable configuration, exactly as `ap_settings`/`ar_settings` already are today. Historical correctness comes entirely from the per-line snapshot, never from freezing the configuration tables themselves — which is the right trade-off, because freezing configuration would contradict the very reason this phase exists (letting an admin change GL wiring going forward).

## 8. VAT Position Report Impact

**What must change:** `getGlCrossCheck()`'s account-resolution step. Instead of reading the current singleton `ap_settings.tax_input_account_id`/`ar_settings.tax_output_account_id` as the _only_ candidate accounts, it must derive `accounts(W)` per direction from `SELECT DISTINCT resolved_tax_account_id FROM <line table> WHERE ... POSTED AND document date ∈ W`, unioned across the two AP tables (input) and the two AR tables (output) respectively, then compute movement across that whole set (`glMovement()` extended to accept a set of account IDs — `WHERE jl.account_id = ANY(${accountIds})` — rather than exactly one).

**What must NOT change, and this is a finding this review adds that the discovery never raised:** the **public response shape**. `VatPositionGlCrossCheck` today is `{ taxOutputAccountId: string | null; glOutputTaxMovementMinor: number; outputDifferenceMinor: number; outputReconciled: boolean; taxInputAccountId: ...; ... }` — a **single account per direction**, already shipped, already tested by 17 e2e tests. Silently turning `taxOutputAccountId` into an array, or renaming any of these four-per-direction fields, is a **breaking API change** to an already-delivered endpoint — exactly the kind of change CLAUDE.md's operating rules require explicit approval for, and one the original discovery's §6.4/§13 never even acknowledges as a question.

**Recommended design (additive-only, preserves the existing contract):**

- Keep `taxOutputAccountId`/`taxInputAccountId` meaning exactly what they mean today — the legal entity's **singleton** settings account (or `null` if unconfigured) — untouched, so any existing consumer reading only these four original fields sees identical behavior for any legal entity that has not adopted a per-code override.
- Keep `glOutputTaxMovementMinor`/`glInputTaxMovementMinor`/`outputDifferenceMinor`/`inputDifferenceMinor`/`outputReconciled`/`inputReconciled` **redefined** to reflect the full, historically-correct multi-account movement (§7) rather than only the singleton account's movement — this is a behavior refinement, not a shape change, and it is the whole point of this phase; a legal entity that has never used a per-code override sees byte-identical numbers, because `accounts(W)` degenerates to exactly `{singleton}` for them.
- **Add** new fields — e.g. `perCodeTaxAccounts: { accountId: string; direction: "INPUT" | "OUTPUT"; movementMinor: number }[]` — so a consumer that wants the full per-account breakdown can see it, without any existing field changing meaning or type.
- This is additive-only by construction: every field that exists today keeps its name, its type, and (for the four "account identity" fields) its exact meaning; only the _movement/difference_ numbers now reflect a correctly-scoped calculation, and new fields are pure additions.

**What is unaffected, confirmed unchanged:** `netByCode`/`netTaxMinor`/`netCalculatedTaxMinor`/the unclassified-bucket mechanism/supply-value breakdown — none of these read a GL account at all; they are computed purely from the four source-line tables' `tax_code_id`/`tax_amount_minor` columns, entirely independent of which GL account a line's tax happened to post to. This is confirmed by direct read of the report's main query path (§2), not merely asserted.

## 9. Legacy Compatibility

Pre-Phase-5 posted rows have `resolved_tax_account_id = NULL` (the column didn't exist when they posted). Two layers, not mutually exclusive:

1. **Correctness floor (mandatory, ships with this phase):** the GL cross-check treats a `NULL` `resolved_tax_account_id` row as if it resolved to that direction's **current** singleton settings account — identical to what Phase 4 already does for every row today. This is never a regression: for any legal entity that has never touched a per-code override, _and_ never changed its singleton settings account, this is exactly correct, not approximate. For a legal entity that _has_ changed its singleton account since some pre-migration rows posted, this exact same imprecision **already exists today, in Phase 4, right now** — it is not introduced by this phase, only inherited and left exactly as accurate (or inaccurate) as it already is.
2. **Optional one-time backfill (recommended, not required for READY status):** `UPDATE <line table> SET resolved_tax_account_id = <that direction's singleton account at migration time> WHERE status = 'POSTED' AND resolved_tax_account_id IS NULL AND tax_amount_minor > 0`. This is **exact**, not a guess, specifically for any tenant whose `audit_logs` show **zero** prior `UPDATE`s to `ap_settings`/`ar_settings`'s tax-account fields (auditable directly — `ApSettingsService`/`ArSettingsService` already write an `auditLogs` row on every create/update, confirmed in code) — proving the singleton never changed, so "current" and "historical" are provably identical for that tenant's entire posted history. Recommended as a follow-up migration step, not a blocker to this phase's own rollout.

No existing posted transaction is altered, re-posted, or reclassified by either layer — both are purely additive/read-side.

## 10. RBAC

No new role. Consistent with every other tax-configuration write in this repository:

- **View** (the new fields surfacing on `GET /tax-codes/:id`/`GET /tax-codes`): `finance.viewer`, `finance.poster`, `finance.admin` — unchanged from today's read roles on this controller.
- **Create/Update the mapping** (`PATCH /tax-codes/:id/gl-accounts`, new route): `finance.admin` only — matches `POST /tax-codes`, `PATCH /tax-codes/:id/deactivate`, `PATCH /tax-codes/:id/reactivate`'s existing write restriction exactly.
- **Deactivate/delete a mapping specifically:** there is no separate "delete a mapping" concept — clearing an override is expressed by `PATCH /tax-codes/:id/gl-accounts` with an explicit `null` for the field being cleared (§discovery §6.2, retained), not a distinct route or permission tier. This keeps the permission surface identical to every other tax-configuration write rather than inventing a new one.
- `route-role-matrix.spec.ts` gains exactly one new entry: `role("PATCH", "tax-codes/:id/gl-accounts", "TaxCodesController", ["finance.admin"])`; route count 126→127, `TaxCodesController` 7→8 routes.

## 11. Testing Strategy

Corrected and consolidated from the discovery's §9 (which tested the right _behaviors_ but assumed the wrong _write-site_ for the snapshot — these are the same tests, retargeted at `resolveLineTax()`/`create()`/`update()` instead of `post()`):

1. **DTO validation** — the new `update-tax-code-gl-accounts.dto.spec.ts`: valid/malformed UUIDs, explicit `null` clears an override, an omitted field leaves the other field unchanged, RBAC-restricted.
2. **Resolution-timing regression (new, added by this review):** creating a draft line with a tax code that carries an override immediately shows the resolved `resolvedTaxAccountId` on the created/updated draft response — **before** the document is ever posted — proving resolution happens at draft time, not deferred to `post()`. This is the test that would have caught the discovery's original write-site error, and it did not exist in the discovery's own §9 list.
3. **Backward-compatibility regression (load-bearing, unchanged):** the entire existing 865-test e2e suite re-run with zero edits to existing test files, proving "no override configured ⇒ byte-identical single tax line" holds.
4. **Posting-decomposition e2e** (one representative document type is sufficient depth; the other three follow the identical, already-proven-symmetric shape rather than needing independent re-derivation): two lines, two tax codes, one overridden account and one falling back to the singleton — posts two distinct tax journal lines, correct amounts, correct polarity; a document where every code shares the same account still posts exactly one line.
5. **Immutability regression (new, added by this review):** attempt to mutate a posted line's `resolvedTaxAccountId` directly (a raw update against the table, bypassing the service layer) and confirm the existing database trigger rejects it — proving the column is protected by the trigger the same as every other line field, with no new trigger code required.
6. **Account revalidation at post time (new, added by this review, closing discovery risk #2):** a code's mapped account is deactivated in Chart of Accounts between draft creation and posting attempt — posting is rejected with the same class of error `revalidateLineAccountsForPostingOrThrow` already produces for a deactivated `accountId`.
7. **GL cross-check e2e — response-shape backward compatibility (new, added by this review, closing the §8 gap):** for a legal entity with no per-code overrides configured, the report's `glCrossCheck` object is asserted field-for-field identical in shape and meaning to Phase 4's existing contract (no field removed, none renamed, none retyped) — the concrete proof that the "additive-only" design in §8 was actually delivered, not just intended.
8. **GL cross-check e2e — multi-account correctness:** with a per-code override configured and used, the cross-check nets to zero against the source-line total; the existing Phase 4 "manual journal entry mismatch" test continues to pass unmodified.
9. **Historical-remapping regression (from discovery §9.5, retained):** post under the singleton, remap the code, post again, run the report over a window spanning both — cross-check still nets to zero; a variant that also changes the singleton account between postings reproduces the discovery's §13.1 worked failure case and confirms it does _not_ reproduce under this design.
10. **RBAC** — `route-role-matrix.spec.ts`, full 127-route suite.
11. **Full regression** — typecheck, lint, full unit suite, full e2e suite.

Not inflated beyond this: no separate "effective-date" test category (this design has no effective-dating, per §5/§7 — correctly absent, unlike a design built on discovery's rejected Option B); no per-document-type repetition of tests 2/4/5/6 beyond one representative type plus the symmetry argument already established by Phase 2/3's own precedent and re-affirmed in this review's §2 spot-check.

## 12. Migration / Rollout Strategy

1. Ship migration `0020` (six additive nullable columns, §5) — safe at any time, zero behavior change on its own since every existing row has every new column `NULL` and no code yet reads them.
2. Ship the `resolveLineTax()`/`TaxRatesService.resolveEffectiveRate()` extension and the four posting services' `journalLineValues`-grouping change together (they are inseparable — the grouping change is meaningless without the resolved field to group by, and vice versa).
3. Ship the `TaxReportsService` cross-check change (§8) in the same release as step 2 — **mandatory**, not optional, because deploying step 2 without it would immediately regress the already-shipped Phase 4 cross-check's correctness for the first legal entity that configures an override (discovery Decision 4, re-confirmed by this review).
4. Ship `TaxCodesController`'s new `PATCH :id/gl-accounts` route and its RBAC/route-role-matrix entry in the same release (no override can be configured without it).
5. All four are one coherent phase, one migration, one deploy — there is no safe intermediate state to roll out partially (e.g., shipping the schema without the posting change is safe/inert; shipping the posting change without the report change is not).
6. The optional backfill (§9) is a separate, later, independently-schedulable follow-up — never a blocker to the above.
7. Rollback: since every change is additive (new nullable columns, new route, extended-not-replaced report fields), a rollback is a straightforward revert of the same commit set; no destructive migration exists to reverse.

## 13. Risks and Failure Modes

Real, specific risks — not generic ones:

1. **The exact defect this review found and corrected** (§3/§6): if implementation reintroduces the discovery's original "write inside `post()`" instinct, the first tax-bearing bill posted after the change either raises a database-trigger exception (if the write happens after the header flips to `POSTED` within the same transaction) or requires implementers to carefully reason about statement ordering inside an already-complex ten-step `post()` method. **Mitigation:** this proposal moves the write to `resolveLineTax()` specifically to make this class of bug structurally impossible, not just "documented against."
2. **Journal-line description ambiguity once a document can post more than one tax line** (§6): without the recommended description disambiguation, a GL statement reader (or an auditor) sees two lines both labeled `"Tax on bill {ref}"` with no way to tell which account/code each represents from the line itself. **Mitigation:** append the account code to the description when more than one account is in play (§6); zero cost, zero schema impact, pure string formatting.
3. **API-contract risk on the VAT Position Report** (§3/§8): the single biggest risk this review found that the discovery missed entirely — shipping a naive "turn the singleton fields into arrays" change would break any existing consumer of the Phase 4 report. **Mitigation:** the additive-only design in §8.
4. **Cross-legal-entity or cross-tenant account reference on the new `tax_codes` columns:** mitigated by reusing the exact existing `validateTaxAccountOrThrow`-equivalent validation `ap_settings`/`ar_settings` already enforce — no new validation code path to get wrong.
5. **A tax code's override account deactivated between draft creation and posting:** mitigated by extending `revalidateLineAccountsForPostingOrThrow` (§6/§9), an existing, already-tested pattern.
6. **Backfill imprecision for legacy rows whose singleton account changed pre-migration:** this is a genuinely irreducible risk _given no data exists to reconstruct it exactly_ — mitigated, not eliminated, by the audit-log-gated backfill in §9 (exact where provably possible, honestly best-effort elsewhere, and no worse than Phase 4's own current behavior).
7. **Scope creep risk:** it would be easy, while touching all four posting services, to also "improve" unrelated posting logic. **Mitigation:** this proposal's exact implementation scope (§15) is deliberately narrow — the tax-line grouping change only, nothing else in any of the four `post()` methods.

## 14. Alternatives Considered

**For the schema shape (§5):** a join table (`tax_code_gl_accounts`) or a single column + direction enum — both rejected; see §5's reasoning (two named columns match the exact `ap_settings`/`ar_settings` precedent and correctly allow independent per-direction configuration on one shared code).

**For historical attribution (§7, carried from discovery §13.2/§13.3, independently re-affirmed, not merely copied):**

- **Mapping-history table, mirroring `tax_rates`' effective-dating** — rejected. GL-account mapping has no calendar-driven regulatory shape (unlike a government-mandated rate change), so effective-dating buys a second, independently-maintained resolution algorithm for no correctness benefit the line-snapshot doesn't already provide for free.
- **Journal-derived (`tax_code_id` on `journal_lines` itself)** — rejected. The only alternative that touches the Journal Engine, which this review's mandate and Phase 4's own prior discovery both treat as a boundary not to cross without a materially stronger reason than this phase has.

**For where the snapshot is written (this review's own contribution, not in the discovery at all):** writing it inside `post()` (the discovery's original design) was considered and rejected in this review specifically because `post()` never writes to the line tables today and doing so would either collide with the immutability trigger's ordering (if sequenced wrong) or require new, fragile-to-maintain sequencing discipline (if sequenced right by care rather than by structure). Writing it in `resolveLineTax()` — already the site of every other Phase 2/3 snapshot field — was chosen because it requires no new write path into `post()` at all.

**For the VAT Position Report's contract (this review's own contribution):** a full breaking redesign (`taxOutputAccountId` → `taxOutputAccountIds: string[]`) was considered and rejected in favor of the additive-only design in §8, specifically to avoid an unapproved breaking API change to an already-shipped endpoint.

## 15. Exact Implementation Scope

**Files/modules expected to change** (nothing edited in this iteration — proposal only):

- `services/sphere-finance/src/db/schema.ts` — six new nullable columns (§5).
- `services/sphere-finance/drizzle/migrations/0020_tax_vat_phase_5_gl_account_mapping.sql` — new, additive-only (§5).
- `services/sphere-finance/src/tax-configuration/tax-rates.service.ts` — `resolveEffectiveRate()`'s return shape extended to also expose the resolved tax code's `apTaxAccountId`/`arTaxAccountId` (§3/§6) — no new query.
- `services/sphere-finance/src/tax-configuration/dto/update-tax-code-gl-accounts.dto.ts` — new DTO (§discovery §6.2, retained).
- `services/sphere-finance/src/tax-configuration/tax-codes.service.ts` — new `setGlAccounts()` method (validation reused from `ApSettingsService`'s pattern).
- `services/sphere-finance/src/tax-configuration/tax-codes.controller.ts` — new `PATCH /tax-codes/:id/gl-accounts` route, `@Roles("finance.admin")`.
- `services/sphere-finance/src/accounts-payable/supplier-bills/supplier-bills.service.ts` — `resolveLineTax()` extended to resolve/store `resolvedTaxAccountId` (§6); `post()`'s tax-journal-line construction changed to group-by-resolved-account (§6); `revalidateLineAccountsForPostingOrThrow` extended to also re-validate the resolved tax account (§6/§9); pre-post validation re-expressed against `resolvedTaxAccountId` (§6).
- `services/sphere-finance/src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts` — identical shape, reversed polarity.
- `services/sphere-finance/src/accounts-receivable/customer-invoices/customer-invoices.service.ts` — identical shape, output direction.
- `services/sphere-finance/src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts` — identical shape, reversed, output direction.
- `services/sphere-finance/src/tax-reports/tax-reports.service.ts` — `getGlCrossCheck()`/`glMovement()` updated to resolve the historical account set from the four line tables and sum across it (§8); `VatPositionGlCrossCheck` interface extended additively (§8).
- `services/sphere-finance/src/route-role-matrix.spec.ts` — one new route entry (§10).

**Schema/migrations:** one file, six columns, no new table, no new index, no new trigger, no new constraint beyond the FKs themselves (§5).

**Services:** `TaxRatesService`, `TaxCodesService`, all four subledger posting services, `TaxReportsService` (§ above).

**DTOs:** one new (`update-tax-code-gl-accounts.dto.ts`).

**Controllers:** one new route on an existing controller (`TaxCodesController`); no new controller.

**Reports:** `TaxReportsService`/its controller response shape, additive only (§8).

**Tests:** per §11 — DTO spec, resolution-timing e2e, immutability-trigger e2e, account-revalidation e2e, posting-decomposition e2e, GL cross-check shape + correctness e2e, historical-remapping e2e, RBAC matrix update, full regression re-run. No new test files beyond what's already implied by the files above; no dedicated new e2e file mandated (extending `tax-configuration.e2e-spec.ts` and `vat-position-report.e2e-spec.ts` is sufficient, matching discovery §4's own file-reuse plan).

**Documentation:** a completion report (`docs/finance-work-item-tax-vat-phase-5-completion-report.md`) and roadmap/`PROJECT_STATE.md` updates — **only upon actual implementation and CTO authorization**, not part of this iteration's output.

## 16. Final Recommendation

**Proceed to implementation, with the corrections in this proposal folded in — not as written in the original discovery document.**

The underlying idea — let a tax code override where its tax posts, fall back to today's singleton behavior when it doesn't, and make the VAT Position Report's cross-check read history rather than current configuration — is sound, appropriately scoped, and consistent with every established NoryX Tax/VAT convention to date. It is also, on the evidence gathered in §2's candidate comparison (independently re-derived, not merely trusted from the discovery), the most defensible "next" item among the deferred Tax/VAT scope: the other deferred items each require an external business/jurisdiction input this repository doesn't have, and the one comparably-sized internal alternative (manually-posted tax journal entry coverage) is smaller, already correctly surfaced as a non-silent gap by Phase 4's own shipped design, and remains available as an independent fast-follow at any time — it is not a prerequisite to, or blocked by, this phase.

What tips this from a plain "implement as discovered" to "implement, corrected" is that independent verification — reading the actual `post()` method, the actual immutability triggers, and the actual `resolveEffectiveRate()`/`VatPositionGlCrossCheck` code, rather than trusting the discovery's description of them — found a real mechanical defect (§3/§6, the `post()` write-site), a real cost overestimate that happens to also simplify the design (§3/§6, `resolveEffectiveRate()` already has the data), and a real gap the discovery never engaged with at all (§3/§8, the report's public contract). None of these are reasons to reject the phase. All of them are reasons the phase should not begin from the discovery document as currently written without this correction folded in first.

This iteration produced architecture and proposal only. No code, schema, or migration was written; no commit or push was made; no bundle was created; `docs/roadmap.md`/`docs/project/PROJECT_STATE.md` were not modified; Phase 5 was not marked complete. Implementation authorization remains a decision for the CTO review this proposal is submitted for.
