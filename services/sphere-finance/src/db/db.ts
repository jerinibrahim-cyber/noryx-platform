import {
  createTenantScopedDbClient,
  withTenantScoped,
  auditLogs,
  type GenericTxClient,
} from "@noryx/db-core";
import * as financeSchema from "./schema";

/**
 * Runtime query-building schema = Finance's own tables + db-core's
 * `auditLogs` table. `auditLogs` is platform-shared infrastructure (every
 * module writes to the same append-only audit trail — see db-core's
 * schema.ts and drizzle/rls/002_immutable_audit_log.sql) — it is NOT
 * migrated by Finance (drizzle.config.ts's schema is chart_of_accounts
 * only, see that file's comment), it's just included here so Finance's own
 * Drizzle client can type-safely INSERT into it in the same transaction as
 * a chart_of_accounts write, using this service's own connection pool.
 */
const schema = { ...financeSchema, auditLogs };

const client = createTenantScopedDbClient(schema);

export function getDb() {
  return client.getDb();
}

export async function closeDb(): Promise<void> {
  return client.closeDb();
}

export type Db = ReturnType<typeof client.getDb>;
export type TxClient = GenericTxClient<typeof schema>;

/** Finance's own withTenant — same SET LOCAL logic as @noryx/db-core's
 * withTenant(), delegated to the one shared implementation
 * (withTenantScoped in generic-client.ts), just bound to Finance's own
 * schema/connection instead of db-core's. See Milestone 1a. */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (tx: TxClient) => Promise<T>,
  db: Db = getDb(),
): Promise<T> {
  return withTenantScoped<typeof schema, T>(tenantId, fn, db);
}
