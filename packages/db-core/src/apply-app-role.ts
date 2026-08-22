/**
 * Applies the hand-written app-role SQL in drizzle/app-role/*.sql, in
 * filename order — same mechanical pattern as apply-rls.ts and
 * apply-db-constraints.ts (fixed, repo-controlled SQL, not something
 * Drizzle Kit's schema DSL can express). See that file's comment for why
 * this class of thing is versioned SQL applied as a deploy step.
 *
 * Deliberately a separate deploy step from apply-rls.ts, run LAST — after
 * every migration (both db-core's own and every service's, e.g.
 * sphere-finance's `migrate` + `apply-db-constraints.ts`) has created its
 * tables, and re-run any time the schema changes. The 001 file's
 * `GRANT ... ON ALL TABLES` only covers tables that exist at the moment
 * it runs; `ALTER DEFAULT PRIVILEGES` covers tables created after, but
 * only by the same role running this script, so run order relative to
 * other services' migrations doesn't matter as long as they share that
 * role (they do — the same DATABASE_URL owner/migration role in this
 * repo's dev/CI setup).
 *
 * docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md §2.1.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  // Fixed, repo-controlled path — not derived from user/network input.
  const dir = join(__dirname, "..", "drizzle", "app-role");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.warn(`No app-role SQL files found in ${dir}`);
    return;
  }

  const client = postgres(url, { max: 1 });
  try {
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sqlText = readFileSync(join(dir, file), "utf-8");
      console.warn(`Applying app-role SQL file: ${file}`);
      await client.unsafe(sqlText);
    }
    console.warn(`Applied ${files.length} app-role SQL file(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply app-role SQL:", err);
  process.exit(1);
});
