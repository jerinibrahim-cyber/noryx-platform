import postgres from "postgres";

/**
 * Milestone 3.1 (Tenant/RLS Hardening) §2.6/§2.7 —
 * docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md.
 *
 * Two independent things this file proves that no existing test does:
 *
 * 1. §2.6 — that Row-Level Security itself, not any application-layer
 *    `WHERE tenant_id = ...` predicate, is what blocks cross-tenant
 *    reads. Every existing cross-tenant-isolation test (e.g.
 *    sphere-finance's accounts.e2e-spec.ts) goes through the full
 *    HTTP -> NestJS service -> Drizzle query stack, where the service's
 *    own explicit tenant predicate is also present — so passing there
 *    cannot distinguish "RLS filtered this" from "the service's own
 *    WHERE clause filtered this". This file connects directly as the
 *    dedicated application role (`noryx_app`, §2.1) with a raw,
 *    predicate-free `SELECT *` — no NestJS, no Drizzle query builder,
 *    no service code at all — and shows Postgres itself does the
 *    filtering. It also proves the §1.4/§2.4 null-tenant bypass fix at
 *    this same direct layer: the exact "poisoned pooled connection"
 *    scenario, run through the real `noryx_app` role, must see every
 *    seeded row (the bypass condition), not zero.
 *
 * 2. §2.7 — a drift guard: every column named tenant_id in the public
 *    schema must have a table with row security both enabled AND
 *    forced, and a tenant_isolation policy. Passes today (checked
 *    manually before this milestone — 5 db-core tables, 5 Finance
 *    tables, 10/10 covered) — this test is what keeps it true as the
 *    schema grows, instead of relying on review alone.
 */
describe("Milestone 3.1 — RLS hardening (direct proof + drift guard)", () => {
  const ownerUrl = process.env.DATABASE_URL!;
  const appRoleUrl = process.env.APP_ROLE_DATABASE_URL!;
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  let owner: postgres.Sql;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityAId: string;
  let legalEntityBId: string;

  beforeAll(async () => {
    owner = postgres(ownerUrl, { max: 2 });

    // Seeded unscoped (a fresh connection's app.current_tenant_id is
    // genuinely NULL, the intended bypass) — same pattern every other
    // e2e spec in this repo already uses for fixture setup.
    const [tenantA] = await owner`
      INSERT INTO tenants (slug, name)
      VALUES (${`rls-hardening-a-${suffix}`}, ${"RLS Hardening Tenant A"})
      RETURNING id
    `;
    const [tenantB] = await owner`
      INSERT INTO tenants (slug, name)
      VALUES (${`rls-hardening-b-${suffix}`}, ${"RLS Hardening Tenant B"})
      RETURNING id
    `;
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [legalEntityA] = await owner`
      INSERT INTO legal_entities (tenant_id, name, code, country_code, currency_code)
      VALUES (${tenantAId}, ${"Entity A"}, ${`LE-A-${suffix}`}, ${"QA"}, ${"QAR"})
      RETURNING id
    `;
    const [legalEntityB] = await owner`
      INSERT INTO legal_entities (tenant_id, name, code, country_code, currency_code)
      VALUES (${tenantBId}, ${"Entity B"}, ${`LE-B-${suffix}`}, ${"QA"}, ${"QAR"})
      RETURNING id
    `;
    legalEntityAId = legalEntityA!.id;
    legalEntityBId = legalEntityB!.id;
  });

  afterAll(async () => {
    // Unscoped delete (bypass), same role/connection pattern as setup.
    await owner`DELETE FROM legal_entities WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await owner`DELETE FROM tenants WHERE id IN (${tenantAId}, ${tenantBId})`;
    await owner.end();
  });

  describe("§2.6 — direct RLS proof, independent of application code", () => {
    it("a raw, predicate-free SELECT scoped to tenant A returns only tenant A's row", async () => {
      const client = postgres(appRoleUrl, { max: 1 });
      try {
        const rows = await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
          // No WHERE clause at all — if this test passes, it is Postgres's
          // RLS policy doing the filtering, not this query.
          return tx`SELECT id, tenant_id FROM legal_entities`;
        });
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(legalEntityAId);
        expect(ids).not.toContain(legalEntityBId);
        expect(rows.every((r) => r.tenant_id === tenantAId)).toBe(true);
      } finally {
        await client.end();
      }
    });

    it("a raw, predicate-free SELECT scoped to tenant B returns only tenant B's row", async () => {
      const client = postgres(appRoleUrl, { max: 1 });
      try {
        const rows = await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantBId}, true)`;
          return tx`SELECT id, tenant_id FROM legal_entities`;
        });
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(legalEntityBId);
        expect(ids).not.toContain(legalEntityAId);
      } finally {
        await client.end();
      }
    });

    it("§1.4/§2.4 fix, exercised through the real noryx_app role: a connection 'poisoned' by a prior committed tenant scope still bypasses correctly (sees every seeded row), instead of the pre-fix zero", async () => {
      const client = postgres(appRoleUrl, { max: 1 });
      try {
        // Poison the connection exactly like a real pooled connection that
        // has served one prior tenant-scoped request: SET LOCAL a real
        // tenant, then commit — app.current_tenant_id reverts to '' on
        // this connection from here on, never back to a true NULL.
        await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
        });

        // Now the equivalent of withTenant(null, ...): no set_config call
        // at all on this same, already-poisoned connection.
        const rows = await client.begin(async (tx) => {
          return tx`SELECT id FROM legal_entities`;
        });
        const ids = rows.map((r) => r.id);
        // Pre-fix, this would have been an empty array — '' satisfied
        // neither the IS NULL bypass nor any real tenant match.
        expect(ids).toContain(legalEntityAId);
        expect(ids).toContain(legalEntityBId);
      } finally {
        await client.end();
      }
    });
  });

  describe("§2.7 — drift guard: every tenant_id column has a matching forced RLS policy", () => {
    it("no table with a tenant_id column is missing row security, forced row security, or a tenant_isolation policy", async () => {
      const rows = await owner`
        SELECT
          c.relname AS table_name,
          c.relrowsecurity AS row_security_enabled,
          c.relforcerowsecurity AS row_security_forced,
          EXISTS (
            SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public'
              AND p.tablename = c.relname
              AND p.policyname = 'tenant_isolation'
          ) AS has_tenant_isolation_policy
        FROM information_schema.columns col
        JOIN pg_class c
          ON c.relname = col.table_name AND c.relkind = 'r'
        JOIN pg_namespace n
          ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE col.table_schema = 'public'
          AND col.column_name = 'tenant_id'
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
        ORDER BY c.relname
      `;

      // A drift guard that silently checks nothing is worse than none —
      // fail loudly if the introspection query itself found no
      // tenant_id-bearing tables at all (e.g. pointed at the wrong schema).
      expect(rows.length).toBeGreaterThan(0);

      const offenders = rows.filter(
        (r) =>
          !r.row_security_enabled ||
          !r.row_security_forced ||
          !r.has_tenant_isolation_policy,
      );
      expect({
        checked: rows.map((r) => r.table_name),
        offenders,
      }).toEqual({ checked: rows.map((r) => r.table_name), offenders: [] });
    });
  });
});
