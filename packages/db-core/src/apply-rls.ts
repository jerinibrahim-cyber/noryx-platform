/**
 * Applies the hand-written RLS policy SQL in drizzle/rls/*.sql, in filename
 * order, after Drizzle's own migrations have run. Drizzle Kit owns table
 * shape; it doesn't model RLS policies declaratively, so that half of the
 * schema is versioned SQL applied as a deploy step instead — see the
 * `migrate` / `migrate:dev` scripts in package.json, and CI's db-migrate job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  // Fixed, repo-controlled path — not derived from user/network input — so
  // the non-literal-fs-filename rule's concern (path traversal via tainted
  // input) doesn't apply here; this is a deploy-time CLI script, not a
  // request handler.
  const dir = join(__dirname, "..", "drizzle", "rls");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.warn(`No RLS SQL files found in ${dir}`);
    return;
  }

  const client = postgres(url, { max: 1 });
  try {
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sqlText = readFileSync(join(dir, file), "utf-8");
      console.warn(`Applying RLS policy file: ${file}`);
      await client.unsafe(sqlText);
    }
    console.warn(`Applied ${files.length} RLS policy file(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply RLS policies:", err);
  process.exit(1);
});
