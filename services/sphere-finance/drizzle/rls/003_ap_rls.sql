-- Row-Level Security policies for AP-1a's two new tables (suppliers,
-- ap_settings) — docs/finance-work-item-1-ap-foundation-proposal.md §21.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql, 002_journal_engine_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as chart_of_accounts/journal_entries
-- (schema.ts's doc comment): a legal entity is always a child of one
-- already-RLS-isolated tenant, so legal-entity scoping is enforced
-- explicitly in the service layer instead (SuppliersService,
-- ApSettingsService). Session variable app.current_tenant_id is set
-- per-request via @noryx/db-core's withTenantScoped().
--
-- Unlike 001_enable_rls.sql/002_journal_engine_rls.sql, this file
-- includes the "= ''" bypass-fix branch from day one (Milestone 3.1 §1.4
-- /§2.4 / drizzle/rls/003_null_tenant_bypass_fix.sql) rather than adding
-- it retroactively — those two files predate that fix; this one should
-- not repeat the gap.

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON suppliers;
CREATE POLICY tenant_isolation ON suppliers
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE ap_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_settings;
CREATE POLICY tenant_isolation ON ap_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
