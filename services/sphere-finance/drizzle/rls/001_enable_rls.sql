-- Row-Level Security policy for chart_of_accounts, following the exact
-- pattern in packages/db-core/drizzle/rls/001_enable_rls.sql. Applied
-- after `drizzle-kit generate`/`push` by src/db/apply-rls.ts. Enforced by
-- Postgres itself on every query — a bug in AccountsService cannot leak
-- another tenant's accounts (System Architecture v1 §3.3).
--
-- Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped(), the same mechanism
-- packages/db-core/src/rls.ts uses for its own tables (Milestone 1a).

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chart_of_accounts;
CREATE POLICY tenant_isolation ON chart_of_accounts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
