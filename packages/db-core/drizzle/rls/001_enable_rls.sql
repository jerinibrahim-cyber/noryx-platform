-- Row-Level Security policies for every tenant-scoped table.
--
-- Prisma migrations own table shape; this file owns the isolation policy,
-- applied after `prisma migrate deploy` by src/scripts/apply-rls.ts.
-- Enforced by Postgres itself on every query — a bug in application code
-- cannot leak another tenant's rows (System Architecture v1 §3.3).
--
-- Session variable app.current_tenant_id is set per-request via
-- src/tenant-context.ts -> withTenantContext(), using SET LOCAL inside a
-- transaction so it can never leak across pooled connections.

-- Tenants table itself: platform operators (no tenant_id) see all rows;
-- a tenant-scoped session sees only its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON legal_entities;
CREATE POLICY tenant_isolation ON legal_entities
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id IS NULL -- platform operator accounts
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
CREATE POLICY tenant_isolation ON subscriptions
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
