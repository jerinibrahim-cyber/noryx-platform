import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTransaction, PgTransactionConfig } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Schema-agnostic connection-pool + RLS-transaction infrastructure.
 *
 * This is the ONE implementation of "connect to Postgres as this service,
 * run work inside a transaction with the tenant isolation session variable
 * set" — extracted so every Noryx module reuses it instead of hand-rolling
 * (and potentially drifting on) its own copy of security-critical
 * tenant-isolation code. See docs/architecture.md's module-independence
 * principle and docs/plug-and-play-modules.md.
 *
 * `@noryx/db-core`'s own `getDb()`/`closeDb()`/`withTenant()` (db.ts,
 * rls.ts) are thin, schema-bound wrappers around the functions in this
 * file — same behavior, same exported signatures as before this file
 * existed, so nothing about db-core's existing public API changed. A new
 * module (e.g. `services/sphere-finance`) that owns its own Drizzle schema
 * should call `createTenantScopedDbClient()` and `withTenantScoped()`
 * directly, the same way db.ts/rls.ts do for db-core's own schema.
 */

export type GenericDb<TSchema extends Record<string, unknown>> =
  PostgresJsDatabase<TSchema>;

export type GenericTxClient<TSchema extends Record<string, unknown>> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PgTransaction<any, TSchema, any>;

export interface TenantScopedDbClient<TSchema extends Record<string, unknown>> {
  /** Singleton Drizzle client for this schema — one connection pool per process. */
  getDb(): GenericDb<TSchema>;
  /** For graceful shutdown hooks / tests — closes the underlying connection pool. */
  closeDb(): Promise<void>;
}

export interface CreateTenantScopedDbClientOptions {
  /** Env var to read the connection string from. Defaults to "DATABASE_URL" —
   * override only if a service genuinely needs a second, differently-named
   * connection string (e.g. a read replica), not as a way to avoid setting
   * DATABASE_URL. */
  databaseUrlEnvVar?: string;
  /** Max pool size in production. Defaults to 10, matching db-core's own
   * getDb(). Non-production always uses 5, matching db-core's own getDb(). */
  maxProductionConnections?: number;
}

/**
 * Builds a schema-bound `{ getDb, closeDb }` pair with its own private
 * connection-pool singleton, closed over the returned functions — calling
 * this twice (e.g. once per module) never shares a pool between modules.
 */
export function createTenantScopedDbClient<
  TSchema extends Record<string, unknown>,
>(
  schema: TSchema,
  options: CreateTenantScopedDbClientOptions = {},
): TenantScopedDbClient<TSchema> {
  const envVar = options.databaseUrlEnvVar ?? "DATABASE_URL";
  const maxProd = options.maxProductionConnections ?? 10;

  let queryClient: postgres.Sql | undefined;
  let dbInstance: GenericDb<TSchema> | undefined;

  return {
    getDb(): GenericDb<TSchema> {
      if (!dbInstance) {
        const url = process.env[envVar];
        if (!url) {
          throw new Error(
            `${envVar} must be set — see .env.example. Never defaults in code.`,
          );
        }
        queryClient = postgres(url, {
          max: process.env.NODE_ENV === "production" ? maxProd : 5,
        });
        dbInstance = drizzle(queryClient, { schema }) as GenericDb<TSchema>;
      }
      return dbInstance;
    },
    async closeDb(): Promise<void> {
      await queryClient?.end();
      queryClient = undefined;
      dbInstance = undefined;
    },
  };
}

/**
 * Runs `fn` inside a Postgres transaction with the tenant isolation session
 * variable set via SET LOCAL — scoped to the transaction only, so it can
 * never leak across a pooled connection to a different tenant's request
 * (System Architecture v1 §3.3, Pre-Development Readiness Review §7.4).
 *
 * `tenantId: null` is only valid for PLATFORM_OPERATOR-style requests —
 * a module's RLS policy must treat a null/unset session variable as "no
 * tenant filter" for this to be safe; see
 * packages/db-core/drizzle/rls/001_enable_rls.sql for the reference
 * policy shape every module's own RLS SQL should follow.
 *
 * `txConfig` is an optional passthrough to Drizzle's own
 * `db.transaction(fn, config)` — e.g. `{ isolationLevel: "repeatable
 * read", accessMode: "read only" }` for a multi-statement read that needs
 * one consistent snapshot across all of its statements (Postgres's
 * default READ COMMITTED gives each statement in a transaction its own
 * snapshot, which is correct for ordinary single-purpose reads/writes but
 * wrong for a report that computes an aggregate from several statements
 * that must all see the same point-in-time data — see
 * services/sphere-finance/src/general-ledger/general-ledger.service.ts).
 * Defaults to `undefined`, i.e. no `SET TRANSACTION` is issued and
 * behavior is byte-for-byte identical to before this parameter existed —
 * every existing caller that doesn't pass it is unaffected.
 *
 * Identical runtime behavior to db-core's own `withTenant()` — that
 * function now calls this one internally. Modules with their own schema
 * should call this directly rather than reimplementing the SET LOCAL logic.
 */
export async function withTenantScoped<
  TSchema extends Record<string, unknown>,
  T,
>(
  tenantId: string | null,
  fn: (tx: GenericTxClient<TSchema>) => Promise<T>,
  db: GenericDb<TSchema>,
  txConfig?: PgTransactionConfig,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (tenantId) {
      // set_config(..., true) === SET LOCAL: scoped to this transaction only.
      await tx.execute(
        sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
      );
    }
    return fn(tx);
  }, txConfig);
}
