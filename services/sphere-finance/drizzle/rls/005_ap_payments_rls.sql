-- Row-Level Security policies for AP-1c's three new tables
-- (ap_payment_number_counters, supplier_payments,
-- supplier_payment_allocations) —
-- docs/finance-work-item-1c-supplier-payments-proposal.md §10.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql, 002_journal_engine_rls.sql,
-- 003_ap_rls.sql, 003_null_tenant_bypass_fix.sql, 004_ap_bills_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as every other AP table
-- (schema.ts's doc comments): a legal entity is always a child of one
-- already-RLS-isolated tenant, so legal-entity scoping is enforced
-- explicitly in the service layer instead (SupplierPaymentsService).
-- Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one, same as
-- 004_ap_bills_rls.sql — this file has no gap to repeat.

ALTER TABLE ap_payment_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_payment_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_payment_number_counters;
CREATE POLICY tenant_isolation ON ap_payment_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_payments;
CREATE POLICY tenant_isolation ON supplier_payments
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_payment_allocations;
CREATE POLICY tenant_isolation ON supplier_payment_allocations
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
