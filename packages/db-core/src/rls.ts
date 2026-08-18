import { getDb, type Db } from "./db";
import * as schema from "./schema";
import { withTenantScoped, type GenericTxClient } from "./generic-client";

export type TxClient = GenericTxClient<typeof schema>;

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
 *
 * Same signature and behavior as before — this now delegates to the
 * schema-agnostic withTenantScoped() in generic-client.ts, which is also
 * what other modules (e.g. services/sphere-finance) call directly for
 * their own schemas, so there is exactly one implementation of the SET
 * LOCAL logic in the codebase, not one per module.
 */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (tx: TxClient) => Promise<T>,
  db: Db = getDb(),
): Promise<T> {
  return withTenantScoped<typeof schema, T>(tenantId, fn, db);
}
