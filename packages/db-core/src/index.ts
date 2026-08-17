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

export * from "./schema";

// Re-export the query builder helpers services need for WHERE clauses etc.,
// so downstream services depend only on @noryx/db-core, not on drizzle-orm
// directly, keeping the ORM choice swappable in one place if it ever needs
// to change again.
export { eq, and, or, sql, desc, asc } from "drizzle-orm";
