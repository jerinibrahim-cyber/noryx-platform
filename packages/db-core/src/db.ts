import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { createTenantScopedDbClient } from "./generic-client";

// db-core's own schema-bound client, built on the schema-agnostic
// infrastructure in generic-client.ts. Behavior is unchanged from before
// that file existed: DATABASE_URL env var, pool size 10 in production / 5
// otherwise, one singleton pool per process.
const client = createTenantScopedDbClient(schema);

/** Singleton Drizzle client — one connection pool per process. */
export function getDb(): PostgresJsDatabase<typeof schema> {
  return client.getDb();
}

/** For graceful shutdown hooks / tests — closes the underlying connection pool. */
export async function closeDb(): Promise<void> {
  return client.closeDb();
}

export type Db = PostgresJsDatabase<typeof schema>;
