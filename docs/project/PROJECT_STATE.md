# Noryx Project State

**Snapshot:** 2026-09-11 (Repository implementation state paragraph updated to reflect Tax/VAT Phase 3 completion — see below; all other sections unchanged from 2026-09-05)  
**Repository:** `jerinibrahim-cyber/noryx-platform`  
**Authoritative product branch:** `main`  
**Last verified main commit before Phase 3:** `6229bc6` (Tax/VAT Phase 2 completion report; see `docs/finance-work-item-tax-vat-phase-3-completion-report.md` for the Phase 3 commit SHA and push verification)

## Product

Noryx is a monorepo for **Noryx Sphere** (ERP · CRM · HRMS) and **Noryx Orbis** (CAFM/FM Intelligence), with shared multi-tenant platform services. The stack includes Node.js/TypeScript/NestJS backend services, PostgreSQL with RLS, React/TypeScript web, an event-driven internal core, and a versioned REST gateway.

## Product direction

The locked strategic direction is **Finance-first**. Other product areas are not to be inferred as the next implementation target unless the roadmap/state explicitly establishes them.

## Repository implementation state

`main` has advanced past Scheduled Reversal for Accruals and Other Timing Adjustments (Revision 2, `733c3070...`), then past **Tax/VAT MVP Phase 1 — Tax Configuration Foundation** (`dd6d135`, Finance), then past NOAH's own Stage 1A-close/Stage 1B-ratification commits (`8021c36`, `878da4c`, `563046e` — orchestrator workstream, not Finance), then past **Tax/VAT MVP Phase 2 — AP Tax Calculation** (`ae4b073`/`6229bc6`, Finance). The CTO subsequently confirmed the Phase 3 architecture decisions (credit-note lines resolve tax independently per line, never inherited from allocated invoices — the same no-inheritance shape as Phase 2's debit notes) against the actual current code/schema and authorized full implementation directly.

**Tax/VAT MVP Phase 2 — AP Tax Calculation is implemented, verified, and pushed to `main`.** Optional line-level `taxCodeId` on Supplier Bill lines and Supplier Debit Note lines resolves the effective `tax_rates` row by the document's own transaction date (`billDate` / `debitNoteDate`), calculates and snapshots the rate via an immutable FK, supports the approved override semantics (client-supplied `taxAmountMinor` stays authoritative alongside a retained `taxAmountCalculatedMinor` and `taxAmountOverridden` flag), and fully preserves legacy behavior when `taxCodeId` is omitted. Supplier Debit Notes resolve tax entirely independently per line (no inheritance from allocated bills), per the CTO-confirmed correction to the originally-proposed Decision 1. A pre-existing Phase 1 bug in `TaxRatesService.create()`'s overlap pre-check (inclusive comparisons stricter than the real half-open EXCLUDE constraint) was discovered and fixed during Phase 2 verification. Full detail is in `docs/finance-work-item-tax-vat-phase-2-completion-report.md`.

**Tax/VAT MVP Phase 3 — AR Tax Calculation is now implemented, verified, and pushed to `main`.** The identical shape is wired into Customer Invoices and Customer Credit Notes: optional line-level `taxCodeId` resolves the effective `tax_rates` row by the document's own transaction date (`invoiceDate` / `creditNoteDate`), calculates and snapshots the rate via an immutable FK, supports the same override semantics as Phase 2's Decision 4, and fully preserves legacy behavior when `taxCodeId` is omitted. Customer Credit Notes resolve tax entirely independently per line (no inheritance from allocated invoices), carrying forward Phase 2's CTO-confirmed no-inheritance correction — `customer_credit_note_allocations` is a header-level many-to-many table with no line-level linkage to any invoice line, so `CustomerCreditNotesService.resolveLineTax()` takes no `allocations` parameter at all, mirroring `SupplierDebitNotesService.resolveLineTax()`'s exact signature as a compile-time guarantee, not just a runtime convention. `TaxConfigurationModule`/`TaxRatesService`/`calculateTaxAmountMinor` were reused unmodified via DI — no new tax-calculation logic was written. Existing GL posting (including AR's Cr-revenue/Cr-tax-output polarity, reversed again on credit notes), totals, RLS, RBAC, and blanket post-immutability are unchanged and were re-verified by full regression. Full detail, exact test results, commit SHA, and push verification are in `docs/finance-work-item-tax-vat-phase-3-completion-report.md`.

`docs/roadmap.md` now names **Tax/VAT Phase 4 — VAT Position Report** as the next candidate Finance work item. It is **not yet discovered or authorized** — its execution gate requires a separate CTO discovery/authorization prompt, exactly as Phase 3's did before this session's authorization. The next Finance feature must **not** be invented from stale documents — it must come from a fresh discovery document and explicit CTO authorization.

## Orchestrator state

**NOAH (Noryx Orchestration & AI Hub)** is the agreed name for the orchestration AI role.

**Stage 1A — Project Memory Foundation: COMPLETED.**

Stage 1A established durable repository memory and operating contracts through:

- `CLAUDE.md`
- `docs/project/PROJECT_STATE.md`
- `docs/project/CURRENT_PHASE.md`
- `docs/project/NEXT_TASK.md`
- `docs/project/DECISIONS.md`

Stage 1A was merged to `main` as `733c30706a2c0c1baf2e4abdd29824739df26dd8`. Local `main` was subsequently fast-forwarded to that commit and verified clean. No application behavior was changed.

The next orchestrator stage is **not yet implementation-approved**. Stage 1B must first be defined through NOAH discovery/design and the established proposal → CTO approval → implementation → verification → final-review workflow.

The repository remains the source of truth. No RAG or autonomous orchestrator runtime exists yet.

## Locked role separation

- **NOAH / ChatGPT:** CTO + Product Owner + orchestration/state controller + final quality gate.
- **Claude:** Senior Engineer / primary coder / technical proposal author and reviewer when assigned.
- **Antigravity:** execution, verification, browser/UI testing, and explicitly delegated low-risk work.
- **Human owner:** business authority and required approvals.

## Safety boundary

Never store secrets, credentials, tokens, `.env` contents, or other sensitive operational values in project memory. Critical architecture, database/schema, security, auth/authz, tenant/RLS, production-impacting, breaking-API, scope, roadmap, and deviation decisions require the appropriate human/CTO approval.
