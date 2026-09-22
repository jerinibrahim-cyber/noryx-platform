# Tax/VAT Phase 5 — Per-Tax-Code GL Account Mapping — Discovery

**Status: READY** (implementation may proceed once the CTO decisions in §11 are confirmed — none of them are irreconcilable conflicts; all have a concrete, evidence-based recommendation below)

**Role:** CTO-level architecture/discovery engineer, discovery-only. No production code, schema, or config was modified to produce this document. No commit or push was made.

---

## 1. Verified baseline

Read directly from the live repository at the start of this discovery:

- `git branch --show-current` → `main`
- `git log --oneline -5` → `8ccdec5` (Add Tax/VAT Phase 4 completion report) → `ba607b8` (Add Tax/VAT Phase 4 — VAT Position Report) → `263354b` (Add Tax/VAT Phase 3 completion report) → `ad71a50` → `6229bc6`
- `git fetch origin main` → `origin/main` = `8ccdec5da3ab663dc896660d0b92e646e46f30e3` — **identical to local `HEAD`**. Local `main` == `origin/main` == live GitHub `main`, confirmed by fetch (read access). A same-session `git push origin main` was additionally attempted and still fails with the git-proxy authorization error (`access denied by the git proxy: ... not in this session's authorized repository set`) — this is a session-local push-permission artifact, not evidence against the confirmed-by-fetch equality above.
- `git status --short` → only `?? docs/hardening/` (pre-existing, unrelated NOAH/hardening milestone documents; untouched by this discovery, not Finance scope).
- `docs/roadmap.md` and `docs/project/PROJECT_STATE.md` both read in full and are consistent with each other and with the commit log: **Tax/VAT Phases 1–4 are COMPLETE for the current MVP scope.**
- `docs/project/CURRENT_PHASE.md` / `docs/project/NEXT_TASK.md` / `docs/project/DECISIONS.md` read in full: all three describe the unrelated **NOAH/Orchestrator Stage 1B** workstream (`ORCH-1B-IMPLEMENTATION`, ratifying `docs/orchestrator/proposals/1B-implementation-plan.md`) — explicitly out of scope for this Finance discovery, consistent with every prior Tax/VAT discovery in this repository.

## 2. What "next" actually is — candidate identification (not assumed from numbering)

`docs/roadmap.md`'s own words: _"Next approved work item: another Finance roadmap item. Not yet discovered or authorized."_ — the roadmap deliberately does **not** name a next item. This discovery therefore first had to establish the real candidate set from the roadmap's own PLANNED/deferred inventory, then filter it by what is actually **discoverable from the repository today** versus what requires an external, non-architectural decision first.

**Full candidate list, from `docs/roadmap.md`'s "SPHERE FINANCE — current functional status" section:**

| Candidate                                                                                 | Roadmap status                                                                                                                                                                                                                                                     | Why it is / isn't ready for architecture discovery right now                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tax/VAT — statutory VAT filing formats                                                    | Deferred ("Later")                                                                                                                                                                                                                                                 | Requires a specific tax authority / jurisdiction's filing schema as an input. No jurisdiction has been named anywhere in the repository. Not an architecture question — a product/business input is missing.                                                                                 |
| Tax/VAT — reverse charge                                                                  | Deferred ("Later")                                                                                                                                                                                                                                                 | `docs/tax-configuration/dto/create-tax-code.dto.ts`'s own comment: _"no reverse charge in MVP"_ was an explicit MVP exclusion, not an oversight. Reverse charge changes who is liable for the tax and needs a CTO product decision on mechanism before architecture discovery is meaningful. |
| Tax/VAT — multi-jurisdiction expansion                                                    | Deferred ("Later")                                                                                                                                                                                                                                                 | Same shape as FX/Multi-Currency (also PLANNED, not started) — requires a jurisdiction/currency scope decision first.                                                                                                                                                                         |
| Tax/VAT — tax-inclusive pricing                                                           | Deferred ("Later")                                                                                                                                                                                                                                                 | Changes how `calculateTaxAmountMinor` derives price-from-tax-inclusive-total vs. today's tax-exclusive-only model — a pricing/UX product decision, not purely an architecture one.                                                                                                           |
| Tax/VAT — **per-tax-code GL account mapping**                                             | Deferred ("Later")                                                                                                                                                                                                                                                 | **Purely an internal architecture gap** (§3 below) — no external input needed, fully discoverable from the existing schema/posting code today.                                                                                                                                               |
| Tax/VAT — **coverage of manually-posted (non-AP/AR) tax journal entries**                 | Deferred ("Later"), also directly evidenced by a passing-but-flagged Phase 4 e2e test (`vat-position-report.e2e-spec.ts` — _"reports a nonzero, correctly-signed difference when a manual journal entry posts to the tax-output account outside any AR document"_) | Also purely architectural, but materially smaller in scope — a report-only read-side change, no schema/posting change.                                                                                                                                                                       |
| Financial Reporting — Cash Flow Statement                                                 | PLANNED                                                                                                                                                                                                                                                            | Not Tax/VAT; would need to decide indirect vs. direct method, and the indirect method's non-cash add-back set is incomplete today (no Fixed Assets/depreciation exists yet — PLANNED, not started) — a materiality/scope decision beyond this discovery's Tax/VAT mandate.                   |
| Expense Management / Fixed Assets / Multi-Currency / Budgeting / WIP-Accruals foundations | PLANNED                                                                                                                                                                                                                                                            | Each is a **new capability area** (new schema domains), not a continuation of Tax/VAT — a bigger, separate CTO product decision than "what's next within Tax/VAT," and this prompt's mandate is specifically "Finance/Tax-VAT work item."                                                    |

**Recommendation (Decision 0, §11): Tax/VAT Phase 5 — Per-Tax-Code GL Account Mapping is the next legitimate Tax/VAT work item.** It is the only deferred Tax/VAT item that is (a) purely an internal architecture gap, evidenced directly in the current schema and posting code (§3), (b) already named in the roadmap's own deferred-scope list (not invented), and (c) a direct, natural deepening of the exact capability just shipped in Phase 4 — the VAT Position Report's own GL cross-check is the component whose accuracy this gap currently limits. The smaller "manually-posted tax journal entries" item is real but strictly smaller in scope (§10.4) and is recommended as a fast-follow, not this phase's primary scope.

## 3. Current architecture — the gap, evidenced directly in code

### 3.1 One tax code, two possible directions, one shared GL account per direction

`tax_codes` (`schema.ts` line ~2861) has **no GL account field at all** — only `code`, `name`, `treatment` (`STANDARD`/`ZERO_RATED`/`EXEMPT`), and `isActive`. The same tax code row is referenced generically by `taxCodeId` on **both** `supplier_bill_lines`/`supplier_debit_note_lines` (AP) and `customer_invoice_lines`/`customer_credit_note_lines` (AR) — confirmed by reading `create-supplier-bill-line.dto.ts` and `create-customer-invoice-line.dto.ts`, both of which validate `taxCodeId?: string` as a plain UUID FK to the same `tax_codes` table, with **no direction restriction** anywhere in the schema or DTOs. A tenant is free to (and the Phase 4 e2e fixtures do) apply the identical `STANDARD` tax code to both a bill line and an invoice line.

Meanwhile, the GL account tax posts to is resolved **once per legal entity, per direction** — `ap_settings.tax_input_account_id` (schema.ts ~436) and `ar_settings.tax_output_account_id` (schema.ts ~951) — both nullable singleton FKs to `chart_of_accounts`, each validated only for existence/active/legal-entity-scope, **deliberately with no `accountType` check** (`ap-settings.service.ts` `validateTaxAccountOrThrow`, doc comment: _"tax accounting treatment (asset vs. expense) is jurisdiction-dependent and out of scope for this increment to decide on the caller's behalf"_). That comment's own phrasing — _"this increment"_ — anticipated a later increment might revisit the granularity; this phase is that increment.

### 3.2 Confirmed by direct read of all four posting services: one aggregate tax line per document, always the singleton account

`SupplierBillsService.post()` (lines ~437–518): sums `taxAmountMinor` across every line into a single `taxTotal`, then — if `taxTotal > 0` — pushes **exactly one** journal line at `settings.taxInputAccountId`, unconditionally, regardless of which tax code(s) produced that total:

```ts
if (taxTotal > 0) {
  journalLineValues.push({
    ...
    accountId: settings.taxInputAccountId!,
    debitMinor: taxTotal,
    description: `Tax on bill ${internalReference}`,
  });
}
```

`CustomerInvoicesService.post()` (line ~507) does the identical thing against `settings.taxOutputAccountId`. `SupplierDebitNotesService.post()` and `CustomerCreditNotesService.post()` do the same, reversed (the documented Phase 2/3 reversal-polarity convention). **No code path anywhere resolves a GL account from the tax code itself** — the account is 100% a function of legal entity + direction, never of tax code. This is the exact gap: a tenant with `STANDARD` (5%) and `ZERO_RATED`/`EXEMPT` (0%, but still trackable for statutory reporting) tax codes has no way to route them to distinct GL accounts even though the VAT Position Report (Phase 4) already reports them as distinct rows.

### 3.3 The VAT Position Report's own GL cross-check is the component this limits

`TaxReportsService.getGlCrossCheck()`/`glMovement()` (Phase 4) computes **period movement on exactly the two singleton accounts** — `ap_settings.tax_input_account_id`/`ar_settings.tax_output_account_id` — because today that is the _only_ GL account tax ever posts to. This is precisely correct **today**. It is also precisely the reason a naive Phase 5 implementation would be wrong: if Phase 5 lets some tax codes post to a different, code-specific account while `TaxReportsService.glMovement()` keeps reading only the singleton account, the cross-check would start under-counting real tax-account GL movement for any legal entity that adopts a per-code override — silently breaking the exact reconciliation guarantee Phase 4 just built. **This is the central architectural finding of this discovery** (mirroring Phase 4 discovery's own §3.2 finding about `journal_lines` lacking `tax_code_id` — the same class of "the report's evidentiary base must move in lockstep with the posting change" issue). §6.4 below designs around it explicitly; §11 Decision 4 asks the CTO to confirm the fix is in scope for this same phase (strongly recommended — shipping Phase 5 without it would regress Phase 4's own correctness guarantee).

### 3.4 `tax_codes` is currently create-only + deactivate/reactivate — no general edit route

`tax-codes.controller.ts` exposes exactly 7 routes (verified against `route-role-matrix.spec.ts`'s `EXPECTED` array): `POST /tax-codes`, `GET /tax-codes`, `GET /tax-codes/:id`, `PATCH /tax-codes/:id/deactivate`, `PATCH /tax-codes/:id/reactivate`, `POST /tax-codes/:taxCodeId/rates`, `GET /tax-codes/:taxCodeId/rates`. There is **no** general "edit a tax code's fields" route — `code`/`name`/`treatment` are immutable after creation by design (master-data-list convention, same posture as `SuppliersController`/`CustomersController`). A new capability ("set this code's GL account override") therefore needs its own narrow, purpose-specific route in the same style as `:id/deactivate` — not a general PATCH that would also open `code`/`name`/`treatment` to editing (§6.2, §11 Decision 2).

## 4. Exact affected files, tables, modules

**Schema (new migration, no `0020` file exists yet — confirmed `ls drizzle/migrations/` ends at `0019_tax_vat_phase_3_ar_calculation.sql`; Phase 4 added zero migrations):**

- `services/sphere-finance/src/db/schema.ts` — two new nullable columns on `taxCodes`: `apTaxAccountId` (FK → `chart_of_accounts.id`) and `arTaxAccountId` (FK → `chart_of_accounts.id`), **plus** (per §13.4/§13.8's Decision 6) one new nullable `postedTaxAccountId` column (FK → `chart_of_accounts.id`) on each of the four tax-bearing line tables: `supplierBillLines`, `supplierDebitNoteLines`, `customerInvoiceLines`, `customerCreditNoteLines`.
- `services/sphere-finance/drizzle/migrations/0020_tax_vat_phase_5_gl_account_mapping.sql` (new) — `ALTER TABLE tax_codes ADD COLUMN ap_tax_account_id uuid REFERENCES chart_of_accounts(id), ADD COLUMN ar_tax_account_id uuid REFERENCES chart_of_accounts(id);` plus four `ALTER TABLE <line table> ADD COLUMN posted_tax_account_id uuid REFERENCES chart_of_accounts(id);` statements (exact DDL in §13.4). All six columns nullable, no default; the `tax_codes` two are "no override configured" when `NULL` (§6.1); the four `posted_tax_account_id` columns are "not yet populated" (pre-migration legacy row, or zero-tax line) when `NULL` (§13.7).

**Tax Configuration module (`src/tax-configuration/`):**

- `dto/create-tax-code.dto.ts` — unchanged (account mapping is not a creation-time field, §6.2).
- New `dto/update-tax-code-gl-accounts.dto.ts` — `apTaxAccountId?: string | null`, `arTaxAccountId?: string | null` (both `@IsUUID()` when present, explicit `null` allowed to clear an override back to "use the singleton settings account").
- `tax-codes.service.ts` — new `setGlAccounts()` method, reusing the exact validation shape of `ApSettingsService.validateTaxAccountOrThrow`/`ArSettingsService`'s equivalent (exists, active, same legal entity, **no `accountType` check** — same jurisdiction-dependent reasoning).
- `tax-codes.controller.ts` — new `PATCH /tax-codes/:id/gl-accounts` route, `@Roles("finance.admin")` (matches `create`/`deactivate`/`reactivate`'s existing write-role restriction).

**Posting services (the actual behavior change, all four mirror each other):**

- `src/accounts-payable/supplier-bills/supplier-bills.service.ts` — `post()`'s tax-journal-line construction (§3.2) changes from "one line, `taxTotal`, `settings.taxInputAccountId`" to "group lines by resolved account, one line per distinct account" (§6.3).
- `src/accounts-payable/supplier-debit-notes/supplier-debit-notes.service.ts` — same change, reversed polarity, `settings.taxInputAccountId` direction.
- `src/accounts-receivable/customer-invoices/customer-invoices.service.ts` — same change, `settings.taxOutputAccountId` direction.
- `src/accounts-receivable/customer-credit-notes/customer-credit-notes.service.ts` — same change, reversed polarity, `settings.taxOutputAccountId` direction.

**Tax Reports module (the Phase 4 report, updated per §3.3's finding):**

- `src/tax-reports/tax-reports.service.ts` — `getGlCrossCheck()`/`glMovement()` must sum movement across the **union** of each direction's singleton account plus every distinct per-code override account actually configured for that legal entity (resolved once per call, from `tax_codes` + `ap_settings`/`ar_settings`), not just the two singleton accounts.

**Wiring/tests:**

- `src/route-role-matrix.spec.ts` — one new `role("PATCH", "tax-codes/:id/gl-accounts", "TaxCodesController", ["finance.admin"])` entry; route count 126→127, `TaxCodesController` 7→8 routes.
- New/updated unit tests: `update-tax-code-gl-accounts.dto.spec.ts` (new); `tax-codes.service.spec.ts` coverage for `setGlAccounts()` if a unit-test file is introduced (today `tax-codes.service` has no dedicated `.spec.ts` — coverage is entirely e2e via `tax-configuration.e2e-spec.ts`, so extending that e2e file is the precedent-consistent choice, §9).
- Updated e2e: `test/tax-configuration.e2e-spec.ts` (RBAC + validation for the new route); `test/supplier-bills.e2e-spec.ts`, `test/customer-invoices.e2e-spec.ts` (or new dedicated files) for the multi-account posting decomposition; `test/vat-position-report.e2e-spec.ts` for the updated GL cross-check.

## 5. Reusable existing components (nothing duplicated)

- **Validation pattern**: `ApSettingsService.validateTaxAccountOrThrow`/`ArSettingsService`'s equivalent — exists, active, correct legal entity, no type constraint. Reused verbatim for the new per-code override fields (same jurisdiction-dependent reasoning applies identically at the code level).
- **Narrow-sub-route-on-existing-controller pattern**: `AccountingPeriodsController`'s `:id/close`, `ScheduledReversalsController`'s `:id/cancel`, and `TaxCodesController`'s own existing `:id/deactivate`/`:id/reactivate` — the same shape for the new `:id/gl-accounts` route, rather than a general PATCH or a new controller.
- **Optional-override-falls-back-to-existing-behavior pattern**: exactly Phase 2/3's `taxCodeId` itself (optional; omitted ⇒ legacy manual `taxAmountMinor` behavior unchanged) — the new `apTaxAccountId`/`arTaxAccountId` are the same shape one level up (optional; `NULL` ⇒ singleton `ap_settings`/`ar_settings` account, today's behavior unchanged).
- **`REPORT_TX_CONFIG`** — unchanged, still the correct isolation level for `TaxReportsService`'s updated cross-check query.
- **RBAC convention** — `finance.admin`-only write on tax configuration, matching `create`/`deactivate`/`reactivate` exactly; no new role is introduced.

## 6. Proposed implementation shape

### 6.1 Schema — additive, nullable, zero-impact-when-unset

```sql
ALTER TABLE tax_codes
  ADD COLUMN ap_tax_account_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN ar_tax_account_id uuid REFERENCES chart_of_accounts(id);
```

No backfill, no default, no NOT NULL. Every existing tax code (and every code created without setting these) behaves exactly as it does today — this is the load-bearing backward-compatibility property, verified in §9 by a dedicated "identical-output" regression test.

### 6.2 New endpoint

`PATCH /tax-codes/:id/gl-accounts` — `@Roles("finance.admin")`. Body: `{ apTaxAccountId?: string | null; arTaxAccountId?: string | null }`. Either field independently settable/clearable; omitting a field leaves it unchanged (partial update, not full replace — consistent with a "wiring" endpoint rather than a "replace the whole tax code" endpoint). `code`/`name`/`treatment` remain untouched by this route, preserving their existing create-only immutability.

### 6.3 Posting-service change (all four services, identical shape)

Today (`SupplierBillsService.post()`, representative of all four):

```ts
const taxTotal = before.lines.reduce((sum, l) => sum + l.taxAmountMinor, 0);
if (taxTotal > 0) {
  journalLineValues.push({ accountId: settings.taxInputAccountId!, debitMinor: taxTotal, ... });
}
```

Proposed:

```ts
// Resolve each line's effective tax account: its tax code's override,
// else the legal entity's singleton settings account (unchanged fallback).
const taxByAccount = new Map<string, number>(); // accountId -> summed minor
for (const line of before.lines) {
  if (line.taxAmountMinor === 0) continue;
  const accountId = resolvedTaxAccount(line.taxCodeId, taxCodeAccounts, settings.taxInputAccountId!);
  taxByAccount.set(accountId, (taxByAccount.get(accountId) ?? 0) + line.taxAmountMinor);
}
for (const [accountId, amount] of taxByAccount) {
  journalLineValues.push({ accountId, debitMinor: amount, description: `Tax on bill ${internalReference}`, ... });
}
```

`resolvedTaxAccount()` looks up the line's `taxCodeId` (if any) in a map of `tax_codes.id -> apTaxAccountId` fetched once per `post()` call (a single extra `SELECT` on already-loaded line tax-code-ids, negligible cost — same pattern `resolveLineTax` already uses for rate lookups); falls back to the passed-in singleton account whenever the code has no override or the line has no `taxCodeId` at all (legacy manual lines). **When every line resolves to the same account (the common case today, and every existing fixture/test), the output is byte-identical to the current single-line behavior** — same `lineNumber` sequencing position, same total. Iteration order over `taxByAccount` must be deterministic (insertion order, as `Map` already guarantees) to keep line-number assignment stable and testable.

The `taxTotal > 0 && !settings.taxInputAccountId` pre-post validation (line 441) needs a matching update: it must now also account for the case where **every** tax-bearing line has a code-level override configured (so the singleton account is never actually used) — that combination should be **allowed** even if the singleton account itself is unset, since it would go unused. Recommended precise rule: throw only if at least one tax-bearing line would resolve to the (missing) singleton account — i.e., has no code override and the singleton is unset.

### 6.4 `TaxReportsService.getGlCrossCheck()` update

Resolve the set of GL accounts actually in play for the window's legal entity _before_ computing movement: `{ap_settings.tax_input_account_id} ∪ {tax_codes.ap_tax_account_id WHERE NOT NULL}` for input, mirrored for output. Sum movement across that whole set (still period MOVEMENT, not point-in-time balance — Phase 4's own already-correct choice, untouched). This keeps the cross-check's guarantee — _GL movement on the tax accounts should equal the source-line total, absent a manual journal entry_ — true regardless of whether any given legal entity has adopted per-code overrides yet, and for legal entities that never do, it degenerates back to exactly Phase 4's original two-account query (zero behavior change for them).

## 7. Reporting/accounting semantics

- **No change to net tax calculation.** `netByCode`, `netTaxMinor`, `netCalculatedTaxMinor`, unclassified-bucket handling — all computed from the four AP/AR source-line tables, completely unaffected by which GL account a line's tax posted to. This phase is purely a **posting/GL-mapping** change, not a tax-amount or reporting-arithmetic change.
- **Supply-value breakdown, calculated-vs-overridden visibility** (Phase 4 features) — unaffected.
- **Historical/already-posted documents are never touched.** Journal lines are immutable once posted (`journal_lines_immutable` trigger, unchanged); a tax code's GL-account override set _after_ some documents already posted does not retroactively reclassify their existing journal lines. The GL cross-check (§6.4) naturally handles this correctly because it reads _actual_ posted `accountId`s for the window, not a code's _current_ configuration.

## 8. RLS/RBAC/security

- No RLS change — `tax_codes` already carries `tenant_id`/`legal_entity_id` and is already RLS-scoped; the two new columns are additive to an already-isolated table.
- New `apTaxAccountId`/`arTaxAccountId` values are validated against `chart_of_accounts` **within the same legal entity** (§4/§6.2, reusing the existing settings-account validation), preventing a cross-legal-entity account reference exactly as `ap_settings`/`ar_settings` already prevent it.
- RBAC: `finance.admin` write, `finance.viewer`/`finance.poster`/`finance.admin` read (the new fields surface on the existing `GET /tax-codes/:id` response) — identical posture to every other tax-configuration write, no new role.
- No new PII, no new secret, no change to JWT/tenant-context handling.

## 9. Tests/verification required

1. **DTO validation** — `update-tax-code-gl-accounts.dto.spec.ts`: valid UUIDs accepted, malformed UUIDs rejected, explicit `null` accepted (clears an override), omitted field leaves the other unchanged, RBAC-restricted (finance.viewer/poster get `403`, finance.admin succeeds).
2. **Backward-compatibility regression (load-bearing)** — every existing Phase 2/3/4 e2e test involving tax must continue to pass unmodified, proving the "no override configured ⇒ byte-identical single tax line" invariant holds. This is not a new test to write — it is the existing 865-test e2e suite, re-run and required to stay green with zero edits to those files.
3. **New posting-decomposition e2e coverage** — a bill (and mirrored: debit note, invoice, credit note) with two lines using two different tax codes, one code carrying a GL override and one not, posts **two** distinct tax journal lines to the two distinct accounts, each with the correct summed amount; a document where _every_ code shares the same override still posts exactly one line.
4. **GL cross-check e2e coverage** — extend `vat-position-report.e2e-spec.ts`'s existing "GL cross-check" describe block: with a per-code override configured and used, the cross-check still nets to zero difference against the source-line total (proving §13.4's fix); the existing "manual journal entry mismatch" test continues to pass unmodified (still surfaces a real mismatch, now against the historically-correct account set).
5. **Historical-attribution regression (§13, load-bearing for this revision)** — post a document under tax code `STANDARD` with no override configured (posts to the singleton account); _then_ set `STANDARD.apTaxAccountId` to a different account; post a second document under the same code (now posts to the new account); run the VAT Position Report over a window spanning **both** documents and assert the GL cross-check still nets to zero — proving §13.4's proof holds against an actual remap, not just in theory. A second variant additionally changes the singleton `ap_settings.taxInputAccountId` itself between the two postings, reproducing §13.1's worked failure case exactly and asserting it does _not_ reproduce under the Option A design.
6. **RBAC** — `route-role-matrix.spec.ts` updated for the new route (§4), full 127-route suite re-run.
7. **Full regression** — typecheck, lint, full unit suite, full e2e suite — identical discipline to every prior Tax/VAT phase in this repository.

## 10. Risks / edge cases

1. **A tax code shared across AP and AR with only one direction's override set** — fully supported by design (`apTaxAccountId`/`arTaxAccountId` are independent); no special-case needed, each posting service only ever reads its own direction's field.
2. **An override account is later deactivated in Chart of Accounts** — mirrors the existing `revalidateLineAccountsForPostingOrThrow` pattern (§3, already re-validates line accounts at post time, independent of draft-time validation); the same re-validation must be extended to the resolved tax account(s) at post time, not just at `PATCH /tax-codes/:id/gl-accounts` time.
3. **Multiple tax codes on one document that all resolve to different accounts, one of which has zero net tax after rounding** — the `if (line.taxAmountMinor === 0) continue` guard (§6.3) prevents an empty-amount journal line from ever being emitted, consistent with today's `taxTotal > 0` guard.
4. **Manually-posted (non-AP/AR) tax journal entries remain outside per-code attribution** — explicitly out of this phase's scope (§2's smaller candidate); §6.4's cross-check will correctly surface such an entry as a movement/source-line mismatch (as it already does for the singleton-account case, per the existing Phase 4 test) but still cannot say _which tax code_ a manual entry was "for," because a manual journal entry carries no `tax_code_id` — the same structural limitation Phase 4 discovery §3.2 identified, unresolved by this phase and correctly left to the "manually-posted tax journal entries coverage" fast-follow (§2).
5. **A legal entity that never adopts per-code overrides** — must see precisely zero behavior change anywhere (posting output, report output, GL cross-check) — the explicit backward-compatibility bar this whole design is built around (§6.1, §6.3, §6.4, §9.2).

## 11. CTO decisions required

**Decision 0 — Which Tax/VAT item is genuinely "next"?**
_Recommendation:_ Per-Tax-Code GL Account Mapping (this document), for the reasons in §2 — purely architectural, already-named deferred scope, directly deepens Phase 4. _Evidence:_ §2's candidate table; §3's direct code citations showing the gap is real today, not speculative.

**Decision 1 — Scope this phase to GL-account-mapping only, or fold in "manually-posted tax journal entries coverage" too?**
_Recommendation:_ GL-account-mapping only, this phase; manual-journal coverage as an immediate fast-follow (§2, §10.4). They are independent, separately-testable changes — combining them would widen this phase's diff across posting logic _and_ report logic _and_ a new journal-entry-classification concept in one pass, against this repository's own established pattern of shipping one architecturally-coherent slice per phase (Phase 2 = AP wiring only, Phase 3 = AR wiring only, Phase 4 = reporting only).

**Decision 2 — New dedicated `PATCH :id/gl-accounts` route, or extend tax-code creation to accept these fields upfront?**
_Recommendation:_ Dedicated route (§3.4, §6.2) — GL wiring is operational configuration that plausibly changes after a code is already in use (e.g., a chart-of-accounts restructure), whereas `code`/`name`/`treatment` are identity fields correctly locked at creation; conflating them would either force GL-account decisions at tax-code-creation time (a real usability regression — the same reasoning that kept `ap_settings`/`ar_settings` as separately-configurable resources from Chart of Accounts itself) or require opening `code`/`name`/`treatment` to editing as a side effect, which is out of this phase's scope and not requested anywhere in the roadmap.

**Decision 3 — Two independent nullable columns (`apTaxAccountId`/`arTaxAccountId`) vs. a single `glAccountId` plus a `direction` enum, vs. a separate join table?**
_Recommendation:_ Two independent nullable columns on `tax_codes` directly (§4, §6.1) — simplest schema, no new table, matches the existing `ap_settings.taxInputAccountId`/`ar_settings.taxOutputAccountId` two-column precedent exactly, and correctly supports the confirmed-real case (§3.1) of one tax code used on both AP and AR documents needing independent overrides per direction. A single `glAccountId` + `direction` enum would incorrectly force a single tax code into one direction only, contradicting the schema's own current lack of a direction constraint on `tax_codes`.

**Decision 4 — Must `TaxReportsService.getGlCrossCheck()` be updated in this same phase?**
_Recommendation: Yes, mandatory, not optional_ (§3.3, §6.4) — shipping the posting change without the report change would silently regress the just-delivered Phase 4 GL cross-check's correctness for any legal entity that adopts a per-code override, which is a materially worse outcome than not building this phase at all. This is flagged as a decision rather than silently bundled because it does add scope to "just a posting change" — but the evidence in §3.3 makes it a correctness requirement, not a preference. **§6.4's original design for this update is SUPERSEDED by §13 below — see Decision 6.**

**Decision 5 — Should the pre-post validation (`taxTotal > 0 && !settings.taxInputAccountId`) be relaxed as described in §6.3?**
_Recommendation:_ Yes, exactly as specified in §6.3 — the current check's premise (tax > 0 always implies the singleton account will be used) stops being universally true once overrides exist; a legal entity that fully migrates every tax code to per-code accounts should not be forced to also configure an unused singleton account.

## 13. Revision — historical GL-account attribution (supersedes part of §6.4)

**Raised post-discovery**: does §6.4's original design — resolve the _current_ union of `{singleton settings account} ∪ {tax_codes.apTaxAccountId/arTaxAccountId WHERE NOT NULL}`, then sum GL movement on that set — actually stay correct once a code's `apTaxAccountId`/`arTaxAccountId` is _changed_ after documents have already posted under the old mapping? **No — it does not.** This section re-derives the correct design. It supersedes §6.4's account-resolution mechanism; §6.4's framing of _why_ the report must change (§3.3) is unaffected and still holds.

### 13.1 Why the original §6.4 design breaks under remapping

§6.4 as written re-resolves "which accounts are in play" from **current** configuration on every report call, regardless of the window being queried. Walk a concrete case: tax code `STANDARD` has `apTaxAccountId = NULL` (posts to the singleton `ap_settings.tax_input_account_id`, account `X`) through January; on February 1st an admin sets `STANDARD.apTaxAccountId = Y`; February's bills post their `STANDARD` tax to `Y`. A report run in March for the window `2026-01-01..2026-02-28` would, under §6.4's design, resolve "accounts in play" from **current** config only — `{X (still the singleton), Y (STANDARD's new override)}` — which happens to still include both in this simple case. But extend the case one step further: in March, the admin also sets `ap_settings.tax_input_account_id` itself to a third account `Z` (a legitimate, independent action — the singleton is itself ordinary mutable configuration, unrelated to any specific tax code). The **current** union is now `{Z, Y}` — account `X`, which genuinely received January's real tax postings, has silently fallen out of the resolved set. The January portion of the cross-check now under-counts real GL movement by exactly January's tax total and reports a spurious mismatch, even though nothing anomalous happened in January. **The defect: §6.4 asks "what accounts are configured _now_?" when the question that keeps the cross-check correct is "what accounts did this specific window's documents _actually post to, at the time they posted_?"** Those two questions coincide only for windows with no intervening remapping — which the CTO-level ask in this turn is explicitly about the case where they don't.

This is not a hypothetical edge case unique to Phase 5's new per-code fields — the **exact same latent gap already exists today**, silently, in Phase 4's shipped design: `ap_settings.tax_input_account_id`/`ar_settings.tax_output_account_id` are themselves ordinary mutable settings (no history kept), so a legal entity that has ever changed either value already has this exposure, Phase 5 or not. §13.4 addresses closing this pre-existing gap as a byproduct of the same fix, at no extra design cost.

### 13.2 Three approaches compared

**A — Transaction-line account snapshot.** At post time, each posting service already resolves the exact GL account a line's tax will be written to (§6.3's `resolvedTaxAccount()`). Store that resolved value directly onto the source line row (`supplier_bill_lines`, `supplier_debit_note_lines`, `customer_invoice_lines`, `customer_credit_note_lines`) in a new nullable column, written once, at post time, alongside the line's other Phase 2/3 snapshot fields. The report then derives "which accounts were actually used in window W" as `SELECT DISTINCT <new column> FROM <line table> WHERE ... POSTED AND date ∈ W`, per table, unioned across the four tables.

**B — Mapping-history table (effective-dated).** Keep `tax_codes.apTaxAccountId`/`arTaxAccountId` as the live/current value, but also write every change to a new `tax_code_gl_account_history` table with `effectiveFrom`/`effectiveTo` columns — the identical shape `tax_rates` already uses for rate changes. At report time, for each line in the window, resolve "which account was in effect on this line's own document date" by joining against the history table's effective-date range, mirroring `TaxRatesService`'s existing rate-resolution algorithm.

**C — Journal-derived solution.** Add a `taxCodeId` (or similar) column directly to `journal_lines`, so a tax journal line is self-describing at the GL layer and the report can `GROUP BY journal_lines.tax_code_id` with no dependency on the source line tables or `tax_codes` configuration at all.

### 13.3 Evaluation against the four stated constraints

| Constraint                               | A — line snapshot                                                                                                                                                                                                                                              | B — mapping history                                                                                                                                                                                                                                                                                                   | C — journal-derived                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Immutable historical accounting**      | Perfect — the value is written once, at post time, on a row that is already blanket-immutable after posting (`SupplierBillsService.update()` and its AR/AP siblings all throw `ConflictException` once `status !== "DRAFT"`, verified directly in code, §13.5) | Preserved, but _reconstructed_ at query time via a date-range join, not stored as fact on the line — correctness depends on the resolution algorithm being bug-for-bug faithful to what posting itself did at the time                                                                                                | Preserved for the account value, but requires widening `journal_lines`' own schema — a shared table every subledger writes through                                  |
| **Backward compatibility**               | Additive nullable column per line table (4 total); zero behavior change for any row that keeps the column `NULL`                                                                                                                                               | Additive (new table); existing `tax_codes` rows unaffected, but the report's resolution logic must handle "no history row exists yet" (pre-migration) identically to Option A's `NULL` case anyway                                                                                                                    | Additive nullable column on `journal_lines`, but changes the shape of a table Phase 4 discovery (§3.2) explicitly examined and found _had no such column by design_ |
| **Phase 4 reconciliation preserved**     | Proven exactly in §13.4 — the account set is read back as historical fact, never recomputed from current config                                                                                                                                                | Preserved in principle, but only as strong as the date-range resolution algorithm's correctness — a second, parallel implementation of "resolve what applied on date D" alongside `TaxRatesService`'s existing one, for a config type (GL wiring) that has no genuine calendar-effective-dating business need (§13.6) | Preserved, but by construction rather than as a targeted fix — most powerful, also most invasive                                                                    |
| **No unnecessary Journal Engine change** | Untouched — `journal_entries`/`journal_lines` schema and `JournalEntriesService` are not touched at all                                                                                                                                                        | Untouched                                                                                                                                                                                                                                                                                                             | **Violates this constraint directly** — the one candidate that requires it                                                                                          |

**New tables:** A = 0, B = 1, C = 0 (but touches the one shared table every subledger posts through). **New columns:** A = 4 (one per line table, additive), B = several on a new table, C = 1 (on `journal_lines`, higher blast radius per column than A's four because it's shared infrastructure). **Report-time cost:** A = one indexed `DISTINCT` over columns already being scanned for the report's existing net-tax query (§4's line tables are already the report's primary read path); B = a fresh effective-date join computed on every report call, over every tax-bearing line in the window; C = cheapest at query time, but only by having paid the cost upfront in Journal Engine schema risk.

### 13.4 Chosen design: Option A, and the correctness proof

**Schema** (extends §4/§6.1 — additive, not a replacement of Decision 3's `tax_codes` columns, which are still required as the _forward-looking default_ consulted only when posting a _new_ document):

```sql
ALTER TABLE supplier_bill_lines        ADD COLUMN posted_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE supplier_debit_note_lines  ADD COLUMN posted_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_invoice_lines     ADD COLUMN posted_tax_account_id uuid REFERENCES chart_of_accounts(id);
ALTER TABLE customer_credit_note_lines ADD COLUMN posted_tax_account_id uuid REFERENCES chart_of_accounts(id);
```

Named `postedTaxAccountId` — deliberately distinct from `taxCodeId` (the classification) and `taxRateId` (the rate snapshot) — to read unambiguously as "the GL account this line's tax was actually posted to," matching the existing `taxRateId`/`taxAmountCalculatedMinor`/`taxAmountOverridden` block's naming register exactly (§4 of the original discovery already places these new fields in that same schema neighborhood). Populated **unconditionally** whenever `§6.3`'s `resolvedTaxAccount()` runs for a tax-bearing line — not only when a per-code override exists — for the reason in §13.6. Remains `NULL` for lines with zero tax, and (until backfilled, §13.7) for every line posted before this migration ships.

**Correctness proof.** For a report window `W` and any tax-bearing line `l` posted at its own actual post-time `t_l` (necessarily `t_l ≤ now`, and `l`'s document date falls in `W` by the report's own filter):

1. By construction, the _same_ transaction that resolves `l`'s tax account and writes the journal line (`accountId: resolvedAccount`) also writes `resolvedAccount` into `l.postedTaxAccountId` — one resolution, two writes, same value, same transaction (§6.3, extended). This is a stored fact about what happened at `t_l`, not a function re-evaluated later.
2. `l.postedTaxAccountId` can never change after that transaction commits, because `l`'s parent document is blanket-immutable once posted (§13.5) — no code path exists that could rewrite it.
3. Define `accounts(W) = ⋃ over the four line tables of { l.postedTaxAccountId : l is POSTED, l.postedTaxAccountId IS NOT NULL, l's document date ∈ W }` — a plain indexed `SELECT DISTINCT`, computed fresh per report call but reading _stored historical fact_, not current configuration.
4. Every AP/AR-sourced tax journal line whose source line falls in `W` was written to an account in `accounts(W)`, by (1) — and every account in `accounts(W)` received at least one such posting in `W`, by (3)'s own definition. So `accounts(W)` is _exactly_ the set of accounts that genuinely carried AP/AR tax movement in `W` — not a superset, not a subset, regardless of anything that happened to `tax_codes` or `ap_settings`/`ar_settings` configuration at any point before, during, or after `W`.
5. Therefore `GLmovement(accounts(W), W)` (§6.4's existing period-movement formula, unchanged) equals the true AP/AR-sourced tax total for `W`, exactly offset by any non-AP/AR (manually-posted) journal entry that also happens to touch one of `accounts(W)`'s members within `W` — which is precisely the intended, correctly-scoped mismatch signal, identical in _meaning_ to Phase 4's original manual-journal-entry test, now correctly _scoped_.

This holds for every window, including one that straddles any number of subsequent remappings, because nothing in the derivation depends on the _current_ value of anything — only on what was actually written, once, at the moment each line posted. QED.

### 13.5 Immutability, verified directly in code

`SupplierBillsService.update()` (and the equivalent method on all three AR/AP siblings): `if (before.status !== "DRAFT") throw new ConflictException("Cannot edit a posted supplier bill.")` — confirmed by direct read. No route of any kind can reach a line's fields, `postedTaxAccountId` included, once its parent document leaves `DRAFT`. This is the same blanket-immutability guarantee `taxRateId` already relies on (§4 of the original discovery, `tax_rates` doc comment) — Option A adds nothing new to this trust boundary, it only adds one more field inside it.

### 13.6 Why not Option B (mirrors `tax_rates`, but answers the wrong question)

`tax_rates` is effective-dated because **rates are a genuine calendar-driven regulatory fact** — a government changes a VAT rate on a known future date, and the business must be able to define that change _in advance_ of it taking effect. GL account mapping has no such shape: it is an internal bookkeeping choice an admin changes _when they change it_, with no regulatory calendar and no legitimate need to schedule a mapping change for a future effective date. Modeling it as effective-dated borrows Phase 1's machinery for a problem that doesn't have Phase 1's underlying business shape, and it would require a **second, independently-maintained** implementation of "resolve what applied on date D" (parallel to `TaxRatesService`'s existing one) purely to serve report reconstruction — real ongoing complexity for a fact that Option A instead captures for free, once, at the moment it is first known to be true (post time), with no resolution algorithm needed at all at report time. `audit_logs` (already written on every `ap_settings`/`ar_settings` change, confirmed directly in `ApSettingsService`, and extendable to `tax_codes.setGlAccounts()` the same way) already gives a human-facing "when did this mapping change and to what" audit trail — sufficient for administrative/compliance review without needing to serve report-reconstruction logic.

### 13.7 Backward compatibility for pre-migration (legacy) rows

Rows posted before this migration ships have `postedTaxAccountId = NULL` — the value was never captured because the column didn't exist yet. Two honest options, not mutually exclusive:

- **Leave `NULL`, degrade gracefully**: for a window containing legacy rows, `accounts(W)` (§13.4 step 3) simply won't include a NULL row's account. Recommended minimum bar: fall each `NULL` row back into the query as "assume `accounts(W)` also includes the singleton settings account for that row's direction" — which is provably exact for any tenant that has _never_ changed its singleton `ap_settings`/`ar_settings` tax account (verifiable per-tenant by checking `audit_logs` for any prior `UPDATE` on that settings row — zero updates ⇒ the fallback is exact fact, not a guess) and is the same best-effort behavior Phase 4 already ships today for every row, so this is strictly a floor, never a regression.
- **One-time backfill migration** (optional, recommended when the audit-log check above comes back clean for a tenant): `UPDATE <line table> SET posted_tax_account_id = <that direction's singleton account at migration time> WHERE status = 'POSTED' AND posted_tax_account_id IS NULL AND tax_amount_minor > 0` — exact, not approximate, specifically _because_ the audit log proves the singleton never changed, so "current" and "historical" coincide for that tenant's entire posted history.

Either way, this is a report-time graceful-degradation and (optional) one-time-migration detail for the next implementation session to execute — not a blocker to READY status, and not a case where the report is ever _wrong_, only a case where, absent the optional backfill, it is exact from the migration date forward and best-effort (with the same accuracy Phase 4 already has today) for the pre-migration tail.

### 13.8 Additional decision this revision introduces

**Decision 6 — Adopt Option A (transaction-line snapshot) for historical GL-account attribution, superseding §6.4's current-config-union design.**
_Recommendation:_ Yes. §13.3's four-constraint comparison and §13.4's correctness proof both favor it over B (unnecessary parallel effective-dating machinery for a fact with no calendar shape) and C (the one candidate that requires touching the Journal Engine, explicitly to be avoided). Concretely: add `postedTaxAccountId` to all four line tables (§13.4), populate it unconditionally in §6.3's posting-service change (not only when an override exists, §13.6), and change §6.4's `getGlCrossCheck()` design to derive `accounts(W)` from these stored columns (§13.4 step 3) rather than from current `tax_codes`/settings configuration. This adds four columns beyond §4's original two-column estimate, and folds the resolved-account snapshot into the same posting-service edit §6.3 already requires — no separate migration pass, no new controller/route, no RBAC change beyond what §8 already specifies.

## 12. Final status

**READY**, as revised by §13. No genuinely irreconcilable architectural conflict was found. Every open point — the original six decisions plus §13.8's Decision 6 — has a concrete, evidence-based recommendation grounded in this repository's own established patterns (Phase 2/3's optional-override-with-fallback and immutable-snapshot shapes; Phase 4's own central-finding-then-design-around-it structure; the existing `ap_settings`/`ar_settings` two-column-per-direction precedent). Implementation may proceed once these six decisions are confirmed by the CTO — none require new external/business input (unlike the excluded candidates in §2's table), so confirmation can happen in the same authorization turn that approves implementation, exactly as Phase 2's Decision 1 and Phase 4's six §11 decisions were resolved in their own implementation-authorization turns.
