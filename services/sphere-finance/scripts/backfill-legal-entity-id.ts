/**
 * One-time backfill for the 2a Chart of Accounts retrofit
 * (docs/finance-journal-engine-proposal.md §1.2): populates the newly
 * added, still-nullable chart_of_accounts.legal_entity_id column from
 * each tenant's default legal entity (db-core's legal_entities table),
 * before migration 0002 tightens the column to NOT NULL and swaps the
 * unique constraint.
 *
 * Run with no `app.current_tenant_id` session variable set, so the
 * existing tenant_isolation RLS policy's `current_setting(...) IS NULL`
 * branch applies and this script can see/update every tenant's rows —
 * the same "no session var set = platform-level operation" convention
 * apply-rls.ts and other administrative scripts already rely on. This is
 * NOT a bypass of RLS; it's the documented no-tenant-context case the
 * policy itself defines.
 *
 * Fails loudly (non-zero exit) if any tenant with chart_of_accounts rows
 * has no default legal entity — per Phase 0's invariant that every
 * tenant gets one, a violation here is a real data problem worth
 * surfacing, not silently leaving legal_entity_id null.
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  const sql = postgres(url, { max: 1 });
  try {
    const tenantsNeedingBackfill = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id
      FROM chart_of_accounts
      WHERE legal_entity_id IS NULL
    `;

    console.warn(
      `Found ${tenantsNeedingBackfill.length} tenant(s) with chart_of_accounts rows needing a legal_entity_id backfill.`,
    );

    let totalUpdated = 0;

    for (const { tenant_id: tenantId } of tenantsNeedingBackfill) {
      const defaultEntity = await sql<{ id: string }[]>`
        SELECT id FROM legal_entities
        WHERE tenant_id = ${tenantId} AND is_default = true
        LIMIT 1
      `;

      if (defaultEntity.length === 0) {
        throw new Error(
          `Tenant ${tenantId} has chart_of_accounts rows but no default legal entity ` +
            `(legal_entities.is_default = true). Refusing to backfill with a guess — ` +
            `this must be fixed at the data level before the retrofit migration can complete.`,
        );
      }

      const legalEntityId = defaultEntity[0]!.id;
      const result = await sql`
        UPDATE chart_of_accounts
        SET legal_entity_id = ${legalEntityId}
        WHERE tenant_id = ${tenantId} AND legal_entity_id IS NULL
      `;
      totalUpdated += result.count;
      console.warn(
        `  tenant ${tenantId}: backfilled ${result.count} row(s) -> legal_entity_id ${legalEntityId}`,
      );
    }

    const remaining = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM chart_of_accounts WHERE legal_entity_id IS NULL
    `;
    const remainingCount = Number(remaining[0]!.count);
    if (remainingCount !== 0) {
      throw new Error(
        `Backfill incomplete: ${remainingCount} chart_of_accounts row(s) still have a null legal_entity_id.`,
      );
    }

    console.warn(
      `Backfill complete: ${totalUpdated} row(s) updated across ${tenantsNeedingBackfill.length} tenant(s). 0 remaining nulls.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
