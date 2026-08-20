-- Row-Level Security policies for the Journal Engine tables added in 2b
-- (docs/finance-journal-engine-proposal.md §8), following the exact same
-- pattern as 001_enable_rls.sql for chart_of_accounts. Applied after
-- Drizzle's own migrations by src/db/apply-rls.ts, in filename order.
--
-- Same tenant-isolation mechanism as every other Noryx table — no second
-- implementation. legal_entity_id is deliberately NOT part of RLS here,
-- same stated reasoning as chart_of_accounts (schema.ts's doc comment):
-- a legal entity is always a child of one already-RLS-isolated tenant, so
-- legal-entity scoping is enforced explicitly in the service layer
-- instead. Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped(), the same mechanism db-core's own
-- rls.ts and chart_of_accounts already use.

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON accounting_periods;
CREATE POLICY tenant_isolation ON accounting_periods
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_number_counters;
CREATE POLICY tenant_isolation ON journal_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_entries;
CREATE POLICY tenant_isolation ON journal_entries
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_lines;
CREATE POLICY tenant_isolation ON journal_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
