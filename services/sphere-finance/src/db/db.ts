import {
  createTenantScopedDbClient,
  withTenantScoped,
  auditLogs,
  legalEntities,
  type GenericTxClient,
  type PgTransactionConfig,
} from "@noryx/db-core";
import * as financeSchema from "./schema";

/**
 * Runtime query-building schema = Finance's own tables + db-core's
 * `auditLogs` and `legalEntities` tables. Both are platform-shared
 * infrastructure Finance does not migrate or write beyond what's noted
 * below (drizzle.config.ts's schema is Finance's own tables only, see
 * that file's comment) — they're included here only so Finance's own
 * Drizzle client can type-safely query/insert into them using this
 * service's own connection pool:
 *  - `auditLogs`: every module writes to the same append-only audit
 *    trail (see db-core's schema.ts and
 *    drizzle/rls/002_immutable_audit_log.sql).
 *  - `legalEntities`: read-only from Finance's side (2c-1) — used solely
 *    to resolve a journal entry's functional currency
 *    (`legalEntities.currencyCode`) at draft-creation time from the
 *    caller's own legal entity. Finance never writes this table.
 */
const schema = { ...financeSchema, auditLogs, legalEntities };

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
 * schema/connection instead of db-core's. See Milestone 1a.
 *
 * `txConfig` is an optional passthrough to `withTenantScoped`'s own
 * `txConfig` param (ultimately Drizzle's `db.transaction(fn, config)`) —
 * see that function's doc comment. Defaults to `undefined`, so every
 * existing Finance caller (Accounts, AccountingPeriods, JournalEntries)
 * that doesn't pass it keeps its exact current behavior; only
 * GeneralLedgerService's read-only, multi-statement report methods pass
 * `{ isolationLevel: "repeatable read", accessMode: "read only" }`. */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (tx: TxClient) => Promise<T>,
  db: Db = getDb(),
  txConfig?: PgTransactionConfig,
): Promise<T> {
  return withTenantScoped<typeof schema, T>(tenantId, fn, db, txConfig);
}
