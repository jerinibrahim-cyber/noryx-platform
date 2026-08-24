import postgres from "postgres";

/**
 * Milestone 3.2 Work Item 10 (docs/hardening/milestone-3.2-work-item-10-
 * role-catalog-validation-proposal.md) — direct proof that the
 * users_roles_catalog_check CHECK constraint (drizzle/constraints/
 * 001_role_catalog_check.sql) is enforced by Postgres itself, independent
 * of any application code. No service/API writes users.roles today (see
 * the proposal §2), so — mirroring sphere-finance's own
 * journal-engine-db-constraints.e2e-spec.ts pattern for DB-level
 * invariants — this connects directly with a raw `postgres` client and
 * issues INSERT/UPDATE statements against `users`, exactly like the
 * hand-written SQL script or a future admin API would.
 */
describe("Milestone 3.2 Work Item 10 — role catalog CHECK constraint (DB layer only)", () => {
  let sql: postgres.Sql;
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let n = 0;

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL!, { max: 5 });
  });

  afterAll(async () => {
    await sql.end();
  });

  function nextEmail(): string {
    n += 1;
    return `role-catalog-${suffix}-${n}@example.com`;
  }

  it("rejects an INSERT with a single invalid role", async () => {
    await expect(
      sql`
        INSERT INTO users (email, display_name, tier, roles)
        VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.veiwer"]})
      `,
    ).rejects.toThrow(/users_roles_catalog_check/);
  });

  it("allows an INSERT with a single valid role", async () => {
    await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.viewer"]})
    `;
  });

  it("allows an INSERT with an empty roles array", async () => {
    await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'PLATFORM_OPERATOR', ${[]})
    `;
  });

  it("rejects an INSERT mixing one valid and one invalid role", async () => {
    await expect(
      sql`
        INSERT INTO users (email, display_name, tier, roles)
        VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.viewer", "finance.hacker"]})
      `,
    ).rejects.toThrow(/users_roles_catalog_check/);
  });

  it("allows an INSERT with a valid role repeated", async () => {
    await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.admin", "finance.admin"]})
    `;
  });

  it("allows an INSERT with all three valid roles at once", async () => {
    await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.viewer", "finance.poster", "finance.admin"]})
    `;
  });

  it("rejects an UPDATE that sets an existing row's roles to an invalid value", async () => {
    const [row] = await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.viewer"]})
      RETURNING id
    `;
    await expect(
      sql`UPDATE users SET roles = ${["finance.superadmin"]} WHERE id = ${row!.id}`,
    ).rejects.toThrow(/users_roles_catalog_check/);
  });

  it("allows an UPDATE that changes an existing row's roles to a different valid set", async () => {
    const [row] = await sql`
      INSERT INTO users (email, display_name, tier, roles)
      VALUES (${nextEmail()}, 'Role Catalog Test User', 'TENANT_INTERNAL', ${["finance.viewer"]})
      RETURNING id
    `;
    await sql`UPDATE users SET roles = ${["finance.poster", "finance.admin"]} WHERE id = ${row!.id}`;
    const [updated] = await sql`SELECT roles FROM users WHERE id = ${row!.id}`;
    expect(updated!.roles).toEqual(["finance.poster", "finance.admin"]);
  });
});
