/**
 * Applies the hand-written, non-RLS DB constraint SQL in
 * drizzle/constraints/*.sql, in filename order, after Drizzle's own
 * migrations (and apply-rls.ts) have run. Same pattern as apply-rls.ts —
 * see that file's comment, and
 * services/sphere-finance/src/db/apply-db-constraints.ts (the original,
 * near-identical script this one is ported from): certain constraint
 * shapes — here, an array-containment CHECK — have no builder in
 * drizzle-orm's schema DSL, so they're versioned SQL applied as a deploy
 * step instead.
 *
 * This is a deliberately separate script from apply-rls.ts even though the
 * mechanics are identical — RLS policies and role-catalog validation are
 * different concerns with different review owners, and keeping them in
 * separate directories/scripts makes that boundary visible rather than
 * implicit (the same reasoning sphere-finance's own apply-db-constraints.ts
 * comment gives for keeping accounting invariants separate from RLS).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  // Fixed, repo-controlled path — not derived from user/network input.
  const dir = join(__dirname, "..", "drizzle", "constraints");
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
