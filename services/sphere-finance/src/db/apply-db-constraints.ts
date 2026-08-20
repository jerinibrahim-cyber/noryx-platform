/**
 * Applies the hand-written accounting-invariant SQL in
 * drizzle/constraints/*.sql, in filename order, after Drizzle's own
 * migrations (and apply-rls.ts) have run. Same pattern as apply-rls.ts —
 * see that file's comment and packages/db-core/src/apply-rls.ts for why
 * this class of thing is versioned SQL applied as a deploy step rather
 * than Drizzle-declarative: exclusion constraints and cross-row/deferred
 * triggers have no builder in drizzle-orm's schema DSL.
 *
 * This is a deliberately separate script from apply-rls.ts even though
 * the mechanics are identical — RLS policies and accounting invariants
 * (balance, immutability, period-overlap) are different concerns with
 * different review owners, and keeping them in separate directories/
 * scripts makes that boundary visible rather than implicit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  // Fixed, repo-controlled path — not derived from user/network input.
  const dir = join(__dirname, "..", "..", "drizzle", "constraints");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.warn(`No constraint SQL files found in ${dir}`);
    return;
  }

  const client = postgres(url, { max: 1 });
  try {
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sqlText = readFileSync(join(dir, file), "utf-8");
      console.warn(`Applying constraint file: ${file}`);
      await client.unsafe(sqlText);
    }
    console.warn(`Applied ${files.length} constraint file(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply DB constraints:", err);
  process.exit(1);
});
