import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { getDb, type Db } from "./db";
import type * as schema from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TxClient = PgTransaction<any, typeof schema, any>;

/**
 * Runs `fn` inside a Postgres transaction with the tenant isolation session
 * variable set via SET LOCAL — scoped to the transaction only, so it can
 * never leak across a pooled connection to a different tenant's request
 * (System Architecture v1 §3.3, Pre-Development Readiness Review §7.4).
 *
 * `tenantId: null` is only valid for PLATFORM_OPERATOR requests — the RLS
 * policies (drizzle/rls/001_enable_rls.sql) treat a null/unset session
 * variable as "no tenant filter", so this must never be used for a
 * TENANT_INTERNAL or TENANT_EXTERNAL request.
 */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (tx: TxClient) => Promise<T>,
  db: Db = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    if (tenantId) {
      // set_config(..., true) === SET LOCAL: scoped to this transaction only.
      await tx.execute(
        sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
      );
    }
    return fn(tx);
  });
}
