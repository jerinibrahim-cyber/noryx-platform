-- Milestone 3.1 (Tenant/RLS Hardening) §1.4/§2.4 — fixes a real,
-- confirmed reliability gap in the "unscoped/platform-operator" bypass
-- branch of every tenant_isolation policy, first identified during the
-- 2d General Ledger read-consistency follow-up and fully root-caused
-- here. docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md §1.4.
--
-- The bug: `withTenantScoped()` (packages/db-core/src/generic-client.ts)
-- only issues `SELECT set_config('app.current_tenant_id', tenantId, true)`
-- when tenantId is truthy — a call with a null tenantId (e.g. Identity's
-- AuthService.login() for platform operators, refresh(), logout()) does
-- NOT reset the session variable. Verified live, repeatedly: once a
-- pooled Postgres connection has ever run one real-tenant transaction
-- and that transaction commits, `current_setting('app.current_tenant_id',
-- true)` reverts to '' (empty string) — NOT NULL — for the rest of that
-- connection's life. Neither `set_config(name, NULL, true)` nor
-- `RESET <name>` restores a genuine NULL for a custom placeholder GUC in
-- this state (both verified live to be no-ops here). So any later
-- withTenant(null, ...) call landing on that connection satisfied neither
-- the `IS NULL` bypass nor any real tenant_id match, and saw zero rows —
-- non-deterministically, depending purely on which pooled connection it
-- landed on.
--
-- The fix widens the bypass condition to treat '' the same as NULL. This
-- is safe: every tenant_id/id column this applies to is `uuid`, and
-- `''::uuid` is invalid input (verified live) — an empty string can never
-- be a real tenant id, so it cannot ever collide with or hide a real
-- tenant's rows. No application code changes; the existing
-- withTenant(null, ...) call sites become correct as soon as the
-- policies recognize '' as the bypass state.
--
-- Re-issues all 5 db-core tenant_isolation policies from 001_enable_rls.sql
-- with the corrected condition — DROP POLICY IF EXISTS / CREATE POLICY,
-- same idempotent pattern as every RLS file in this repo. No table's RLS
-- enablement, FORCE setting, or non-bypass matching logic changes.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON legal_entities;
CREATE POLICY tenant_isolation ON legal_entities
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id IS NULL -- platform operator accounts
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
CREATE POLICY tenant_isolation ON subscriptions
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
