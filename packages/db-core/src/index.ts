export { getDb, closeDb } from "./db";
export type { Db } from "./db";
export { withTenant } from "./rls";
export type { TxClient } from "./rls";
export {
  getTenantContext,
  tryGetTenantContext,
  runWithTenantContext,
} from "./tenant-context";
export type { TenantContext } from "./tenant-context";

// Schema-agnostic connection-pool + RLS-transaction infrastructure — what
// getDb()/closeDb()/withTenant() above are built on. A module with its own
// Drizzle schema (e.g. services/sphere-finance) should use these directly
// rather than reimplementing tenant-isolation transaction handling; see
// generic-client.ts's module doc comment and docs/plug-and-play-modules.md.
export { createTenantScopedDbClient, withTenantScoped } from "./generic-client";
export type {
  GenericDb,
  GenericTxClient,
  TenantScopedDbClient,
  CreateTenantScopedDbClientOptions,
} from "./generic-client";

export * from "./schema";

// Re-export the query builder helpers services need for WHERE clauses etc.,
// so downstream services depend only on @noryx/db-core, not on drizzle-orm
// directly, keeping the ORM choice swappable in one place if it ever needs
// to change again. gte/lte/isNull/ne added for Finance's 2c-1 (accounting
// period date-range queries, optional-filter checks) — purely additive,
// no change to any existing export.
export {
  eq,
  and,
  or,
  sql,
  desc,
  asc,
  gte,
  lte,
  isNull,
  ne,
  inArray,
} from "drizzle-orm";
