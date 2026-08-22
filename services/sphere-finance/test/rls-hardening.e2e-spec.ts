import postgres from "postgres";

/**
 * Milestone 3.1 (Tenant/RLS Hardening) §2.6 —
 * docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md.
 *
 * Same direct-RLS-proof concept as packages/db-core/test/
 * rls-hardening.e2e-spec.ts (see that file's doc comment for the full
 * rationale), applied to Finance's own tables — chart_of_accounts here.
 * Existing tests like accounts.e2e-spec.ts prove the full HTTP -> service
 * -> Drizzle stack blocks cross-tenant access; this file proves Postgres's
 * RLS policy itself does, with no service code, no Drizzle query builder,
 * and no application-layer tenant predicate anywhere in the query.
 */
describe("Milestone 3.1 §2.6 — direct RLS proof (chart_of_accounts)", () => {
  const ownerUrl = process.env.DATABASE_URL!;
  const appRoleUrl = process.env.APP_ROLE_DATABASE_URL!;
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  let owner: postgres.Sql;
  let tenantAId: string;
  let tenantBId: string;
  let accountAId: string;
  let accountBId: string;

  beforeAll(async () => {
    owner = postgres(ownerUrl, { max: 2 });
    tenantAId = crypto.randomUUID();
    tenantBId = crypto.randomUUID();
    // legal_entity_id is a plain uuid here (not an FK — see schema.ts's
    // doc comment), so a fresh random id is sufficient fixture data;
    // this test only needs a row that exists and belongs to a tenant.
    const [accountA] = await owner`
      INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type)
      VALUES (${tenantAId}, ${crypto.randomUUID()}, ${`RLS-A-${suffix}`}, ${"RLS Hardening Asset A"}, ${"ASSET"})
      RETURNING id
    `;
    const [accountB] = await owner`
      INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type)
      VALUES (${tenantBId}, ${crypto.randomUUID()}, ${`RLS-B-${suffix}`}, ${"RLS Hardening Asset B"}, ${"ASSET"})
      RETURNING id
    `;
    accountAId = accountA!.id;
    accountBId = accountB!.id;
  });

  afterAll(async () => {
    await owner`DELETE FROM chart_of_accounts WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await owner.end();
  });

  it("a raw, predicate-free SELECT scoped to tenant A returns only tenant A's account", async () => {
    const client = postgres(appRoleUrl, { max: 1 });
    try {
      const rows = await client.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
        return tx`SELECT id, tenant_id FROM chart_of_accounts`;
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(accountAId);
      expect(ids).not.toContain(accountBId);
      expect(rows.every((r) => r.tenant_id === tenantAId)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("a raw, predicate-free SELECT scoped to tenant B returns only tenant B's account", async () => {
    const client = postgres(appRoleUrl, { max: 1 });
    try {
      const rows = await client.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantBId}, true)`;
        return tx`SELECT id, tenant_id FROM chart_of_accounts`;
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(accountBId);
      expect(ids).not.toContain(accountAId);
    } finally {
      await client.end();
    }
  });

  it("§1.4/§2.4 fix: a connection 'poisoned' by a prior committed tenant scope still bypasses correctly on a Finance table too", async () => {
    const client = postgres(appRoleUrl, { max: 1 });
    try {
      await client.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
      });
      const rows = await client.begin(async (tx) => {
        return tx`SELECT id FROM chart_of_accounts`;
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(accountAId);
      expect(ids).toContain(accountBId);
    } finally {
      await client.end();
    }
  });
});
