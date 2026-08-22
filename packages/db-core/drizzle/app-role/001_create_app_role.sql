-- Milestone 3.1 (Tenant/RLS Hardening) — dedicated, least-privilege
-- application database role. docs/finance-milestone-3.1-tenant-rls-
-- hardening-proposal.md §1.1/§1.2/§2.1.
--
-- Applied by packages/db-core/src/apply-app-role.ts, once per database
-- (the role itself is cluster-global; the GRANT/ALTER DEFAULT PRIVILEGES
-- statements below are per-database and must run against every database
-- the app connects to — currently `noryx` and `noryx_test`).
--
-- Why this exists: every table-owning/migration role in this repo
-- (`noryx` in docker-compose, whatever role runs `drizzle-kit migrate`)
-- is, in practice, either a Postgres superuser (docker-compose's
-- POSTGRES_USER becomes the cluster's bootstrap superuser — see the
-- proposal §1.1) or at minimum the table owner. Superusers unconditionally
-- bypass Row-Level Security, `FORCE ROW LEVEL SECURITY` included — so
-- until now, RLS has only ever been enforced against connections that
-- happened to use a separately, manually-configured non-superuser role.
-- `noryx_app` is the role the RUNNING SERVICES (identity, sphere-finance)
-- actually connect as. It is deliberately NOT the schema owner: it gets
-- exactly the DML privileges the application needs, nothing more.
--
-- This file is idempotent — safe to re-run after every migration, and
-- deliberately re-run (not just relied on once) because the explicit
-- GRANT ON ALL TABLES only covers tables that exist at the moment it
-- runs. The ALTER DEFAULT PRIVILEGES statement additionally covers any
-- table a migration creates in the future, regardless of run order
-- between this script and any given service's own migrations, as long
-- as that future table is created by the same role that ran this script
-- (i.e. the migration/owner role connected via DATABASE_URL here).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'noryx_app') THEN
    CREATE ROLE noryx_app
      LOGIN
      PASSWORD 'noryx_app'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT -1;
  END IF;
END
$$;

-- Idempotent re-assertion in case an existing role was ever created (or
-- altered) with different attributes — this is the invariant §2.3's
-- assert-role-privileges check depends on, so it's enforced here too,
-- not just checked after the fact.
ALTER ROLE noryx_app
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS;

-- CONNECT is granted against whichever database this script is actually
-- run against (current_database()), not a hardcoded name — this file is
-- applied once per database (noryx, noryx_test, ...), so hardcoding one
-- name here would silently skip granting CONNECT on the others.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO noryx_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO noryx_app;

-- Covers every table/sequence that exists in this database right now.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO noryx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO noryx_app;

-- Covers every table/sequence a future migration creates — so a new
-- tenant-scoped table added in Phase 2+ is automatically readable/
-- writable by noryx_app without anyone remembering to re-run a grant
-- script, mirroring the intent of the RLS drift-guard (§2.7).
--
-- FOR ROLE noryx is required here, not implicit/omitted: without it,
-- ALTER DEFAULT PRIVILEGES scopes to whichever role EXECUTES this
-- statement, not to the role that actually owns/creates tables via
-- `drizzle-kit migrate`. Verified live — running this script as an
-- admin/superuser role distinct from `noryx` (necessary in some local
-- setups; see the script's own doc comment) with the FOR ROLE clause
-- omitted silently produced a rule that never applied to any table
-- `noryx`'s migrations actually create. `noryx` is the one migration/
-- schema-owner role name used consistently everywhere in this repo
-- (docker-compose.yml, every service's .env/.env.example, every test
-- env-setup.ts) — if that role is ever renamed, this line must change
-- with it.
ALTER DEFAULT PRIVILEGES FOR ROLE noryx IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO noryx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE noryx IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO noryx_app;
