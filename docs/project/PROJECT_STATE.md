# NoryX Project State

**Snapshot:** 2026-09-22  
**Repository:** `jerinibrahim-cyber/noryx-platform`  
**Authoritative product branch:** `main`  
**Last verified main commit:** `00746b36799d59db54002ab6d58ccc1120c3efe9` (Repository cleanup & governance reconciliation merge; incorporates Tax/VAT Phase 7 delivery `e2c52ac` and cleanup checkpoint `8df301c`).
**Active workstream:** None. Repository cleanup, governance integration, and Tax/VAT Phases 1–7 are delivered to `main`. No subsequent feature or implementation workstream is currently authorized.

---

## 1. Product

NoryX is a monorepo for **Noryx Sphere** (ERP · CRM · HRMS) and **Noryx Orbis** (CAFM/FM Intelligence), with shared multi-tenant platform services. The stack includes Node.js/TypeScript/NestJS backend services, PostgreSQL 16 with RLS, React/TypeScript web, an event-driven internal core, and a versioned REST gateway.

---

## 2. Product Direction

The locked strategic direction is **Finance-First**. Other product areas are not to be inferred as the next implementation target unless the roadmap/state explicitly establishes them with separate CTO authorization.

---

## 3. Repository Implementation State

`main` contains the complete delivered chain of Finance capabilities through Tax/VAT Phase 7:

- **Foundation & Accounting Core:** Chart of Accounts, Journal Engine, General Ledger, Financial Statements.
- **Accounts Payable & Receivable:** Supplier Bills, Supplier Payments, Debit Notes, Customer Invoices, Customer Receipts, Credit Notes.
- **Banking & Cash Management:** Statements Import, Reconciliation, Payment Provider Settlements, Scheduled Reversals.
- **Budgeting Phase 1 Foundation:** Budget accounts, periods, line items, and variance tracking (`ac16fa0e...`).
- **Tax/VAT Suite (Phases 1–7):**
  - Phase 1: Tax Configuration Foundation (`dd6d135`).
  - Phase 2: AP Tax Calculation (`ae4b073`/`6229bc6`).
  - Phase 3: AR Tax Calculation (`ad71a50`/`263354b`).
  - Phase 4: VAT Position Report (`ba607b8`/`8ccdec5`).
  - Phase 5: Per-Tax-Code GL Account Mapping (`0020_tax_vat_phase_5_gl_account_mapping.sql`).
  - Phase 6: Manual Journal Tax Coverage (`2bcb131`, `0024_tax_vat_phase_6_manual_journal_tax_coverage.sql`).
  - Phase 7: VAT Position Detail / Source-Document Drill-Down (`e2c52ac`, `76f991a`; reconciled at `00746b3`).

**Tax/VAT Phase 6 — Manual Journal Tax Coverage is DELIVERED and MERGED to `main` at `2bcb13130eb322cf5810410c0e3ffe06e8f0d8e6`.**
Documentation and evidence artifacts are located in `docs/work-items/tax-vat-phase-6-manual-journal-tax-coverage/`.

**Tax/VAT Phase 7 — VAT Position Detail / Source-Document Drill-Down was implemented, CTO-quality-gate approved, and DELIVERED to `main` at `e2c52ac8ed0c42789e3f8657afe80bced6ad4bd9` (via PR #38 from source commit `76f991a3e7b1704cb39ba94c3407d2dea98e5116`), and reconciled with repository cleanup at `00746b36799d59db54002ab6d58ccc1120c3efe9`.**
A new, additive, read-only `GET /tax-reports/vat-position-detail` route exposes one row per persisted tax-bearing source line contributing to the existing VAT Position Report's `netTaxMinor` across all five tax-bearing source types (`supplier_bill_lines`, `supplier_debit_note_lines`, `customer_invoice_lines`, `customer_credit_note_lines`, and Phase 6's manually-tax-classified `journal_lines`), combined via `UNION ALL` and filtered/ordered/paginated entirely at the database layer inside a `REPEATABLE READ`, `READ ONLY` transaction. Deterministic total ordering (`sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC`), same-request `reconciliationTotals` array reconciling to the complete filtered result, and full tenant/legal-entity isolation are enforced. No schema change, no migration, no change to the existing aggregate `GET /tax-reports/vat-position` route's shape.
Phase 7 authoritative artifacts remain under `docs/work-items/tax-vat-phase-7-vat-position-detail-drill-down/` (`CONTRACT.md`, `ACCEPTANCE.md`, and `COMPLETION_REPORT.md`). Phase 7 remains the current delivered state unless later repository history explicitly supersedes it.

`docs/roadmap.md` reflects Tax/VAT Phase 6 and Phase 7 as delivered (statutory filing, reverse charge, multi-jurisdiction support, and line-grain supply-value reconciliation remain explicitly deferred). No next Finance work item is currently authorized. The next Finance feature must come from a fresh discovery document and explicit CTO authorization.

---

## 4. Orchestrator State — PERMANENTLY ABANDONED

The AI Engineering Orchestrator / NOAH autonomous runtime project (Stages 1A and 1B) has been **PERMANENTLY ABANDONED** as of September 2026.

- All historical proposals, handoff contracts, and stage trackers have been moved to `docs/archive/orchestrator-abandoned/` for audit purposes only.
- No agent may revive, implement, merge, or extend any part of the abandoned orchestrator runtime.
- PR #25 (`feat/orchestrator-validator`) is closed as abandoned.

---

## 5. Authoritative Engineering Governance

The sole operating model is the manual workflow:

```text
CTO (Human / Product Authority)
  → Claude (Senior Engineer / Coder)
  → CTO Quality Gate
  → Antigravity (Verification & Delivery Agent)
```

Governing protocols:

- `docs/engineering/NORYX_ENGINEERING_GOVERNANCE.md` (Active / Ratified)
- `docs/engineering/CLAUDE_ENGINEERING_PROTOCOL.md` (Active / Ratified)
- `docs/engineering/NORYX_CTO_COPILOT_PROTOCOL.md` (Active / Ratified)
- `docs/engineering/NORYX_ANTIGRAVITY_DELIVERY_PROTOCOL.md` (Active / Ratified)

---

## 6. Safety & Operational Boundaries

- Never commit or log secrets, tokens, credentials, or `.env` files.
- Delivery to `main` is handled exclusively by Antigravity under explicit CTO delivery authorization. Claude does not push to git remotes.
