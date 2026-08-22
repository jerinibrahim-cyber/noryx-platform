-- Milestone 3.1 (Tenant/RLS Hardening) §1.4/§2.4 — same fix as
-- packages/db-core/drizzle/rls/002_null_tenant_bypass_fix.sql, applied to
-- Finance's 5 tenant_isolation policies. See that file's comment for the
-- full root cause and the live verification behind it — this file exists
-- because Finance's tables define their own copies of the same policy
-- pattern rather than inheriting db-core's, so both must be updated.
--
-- Widens the RLS bypass condition to treat '' the same as NULL, fixing
-- the reliability gap in withTenant(null, ...) calls on a pooled
-- connection that has ever served a real tenant. Safe: tenant_id is
-- `uuid` on every one of these tables, and ''::uuid is invalid input, so
-- '' can never collide with a real tenant id. No application code
-- changes required.

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chart_of_accounts;
CREATE POLICY tenant_isolation ON chart_of_accounts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON accounting_periods;
CREATE POLICY tenant_isolation ON accounting_periods
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_number_counters;
CREATE POLICY tenant_isolation ON journal_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_entries;
CREATE POLICY tenant_isolation ON journal_entries
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_lines;
CREATE POLICY tenant_isolation ON journal_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
