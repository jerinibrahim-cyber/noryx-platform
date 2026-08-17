import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

let queryClient: postgres.Sql | undefined;
let dbInstance: PostgresJsDatabase<typeof schema> | undefined;

/** Singleton Drizzle client — one connection pool per process. */
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL must be set — see .env.example. Never defaults in code.",
      );
    }
    queryClient = postgres(url, {
      max: process.env.NODE_ENV === "production" ? 10 : 5,
    });
    dbInstance = drizzle(queryClient, { schema });
  }
  return dbInstance;
}

/** For graceful shutdown hooks / tests — closes the underlying connection pool. */
export async function closeDb(): Promise<void> {
  await queryClient?.end();
  queryClient = undefined;
  dbInstance = undefined;
}

export type Db = PostgresJsDatabase<typeof schema>;
