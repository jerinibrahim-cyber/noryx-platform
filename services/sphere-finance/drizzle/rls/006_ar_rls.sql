-- Row-Level Security policies for AR-1a's two new tables (customers,
-- ar_settings) — docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md §4.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql .. 005_ap_payments_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as chart_of_accounts/journal_entries/
-- suppliers/ap_settings (schema.ts's doc comment): a legal entity is
-- always a child of one already-RLS-isolated tenant, so legal-entity
-- scoping is enforced explicitly in the service layer instead
-- (CustomersService, ArSettingsService). Session variable
-- app.current_tenant_id is set per-request via @noryx/db-core's
-- withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4 / drizzle/rls/003_null_tenant_bypass_fix.sql), same as
-- 003_ap_rls.sql onward.

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE ar_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ar_settings;
CREATE POLICY tenant_isolation ON ar_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
