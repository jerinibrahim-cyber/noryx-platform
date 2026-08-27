-- Row-Level Security policies for the Credit/Debit Notes work item's AP
-- tables (supplier_debit_note_number_counters, supplier_debit_notes,
-- supplier_debit_note_lines, supplier_debit_note_allocations) —
-- docs/finance-work-item-credit-debit-notes-proposal.md §8/§11,
-- CTO-approved. Applied after Drizzle's own migrations by
-- src/db/apply-rls.ts, in filename order (continues 001_enable_rls.sql
-- .. 009_ar_credit_notes_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as every other Finance table's own
-- doc comments: a legal entity is always a child of one
-- already-RLS-isolated tenant, so legal-entity scoping is enforced
-- explicitly in the service layer instead (SupplierDebitNotesService).
-- Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4), same as every RLS file since 003_ap_rls.sql — this file
-- has no gap to repeat.

ALTER TABLE supplier_debit_note_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_debit_note_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_debit_note_number_counters;
CREATE POLICY tenant_isolation ON supplier_debit_note_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_debit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_debit_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_debit_notes;
CREATE POLICY tenant_isolation ON supplier_debit_notes
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_debit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_debit_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_debit_note_lines;
CREATE POLICY tenant_isolation ON supplier_debit_note_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_debit_note_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_debit_note_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_debit_note_allocations;
CREATE POLICY tenant_isolation ON supplier_debit_note_allocations
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
