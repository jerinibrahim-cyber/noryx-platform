-- Row-Level Security policies for AP-1b's three new tables
-- (ap_number_counters, supplier_bills, supplier_bill_lines) —
-- docs/finance-work-item-1b-supplier-bills-proposal.md §14.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql, 002_journal_engine_rls.sql,
-- 003_ap_rls.sql, 003_null_tenant_bypass_fix.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as chart_of_accounts/journal_entries/
-- suppliers (schema.ts's doc comments): a legal entity is always a
-- child of one already-RLS-isolated tenant, so legal-entity scoping is
-- enforced explicitly in the service layer instead
-- (SupplierBillsService). Session variable app.current_tenant_id is set
-- per-request via @noryx/db-core's withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4), same as 003_ap_rls.sql — this file has no gap to repeat.

ALTER TABLE ap_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_number_counters;
CREATE POLICY tenant_isolation ON ap_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_bills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_bills;
CREATE POLICY tenant_isolation ON supplier_bills
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_bill_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_bill_lines;
CREATE POLICY tenant_isolation ON supplier_bill_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
