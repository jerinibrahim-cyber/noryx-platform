import { defineConfig } from "drizzle-kit";

// Points only at Finance's own schema.ts (chart_of_accounts) — never at
// @noryx/db-core's schema — so drizzle-kit only ever generates migrations
// for tables Finance actually owns.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://noryx:noryx@localhost:5432/noryx",
  },
  strict: true,
  verbose: true,
});
