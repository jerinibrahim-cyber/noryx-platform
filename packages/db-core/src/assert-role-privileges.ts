/**
 * The continuously-checked invariant from
 * docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md §1.1/§2.3:
 * "RLS actually applies" turned from an assumption into something that's
 * asserted, not just hoped for.
 *
 * Connects using the caller's own DATABASE_URL — i.e. whatever role the
 * running application (or CI job) actually authenticates as — and fails
 * loudly (non-zero exit) if that role is a superuser or has BYPASSRLS.
 * Both unconditionally bypass every RLS policy in the database,
 * regardless of `FORCE ROW LEVEL SECURITY`, so either one silently makes
 * every `tenant_isolation` policy a no-op. This is exactly the failure
 * mode the proposal's §1.1 finding describes (docker-compose's
 * POSTGRES_USER becomes the cluster's bootstrap superuser) — this script
 * is what turns a regression back to that state into a loud, immediate
 * failure instead of a silent one.
 *
 * Intended to run wherever DATABASE_URL is set to the application's own
 * connection string — i.e. against `noryx_app` once §2.1/§2.2 are wired
 * up, not against the migration/owner role. Wired into CI's new e2e job
 * (§2.5) as a guard step before the suite runs.
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");

  const client = postgres(url, { max: 1 });
  try {
    const rows = await client<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    const role = rows[0];
    if (!role) {
      throw new Error(
        "Could not resolve current_user's pg_roles row — cannot verify privilege level.",
      );
    }

    console.warn(
      `Connected as role "${role.rolname}": rolsuper=${role.rolsuper}, rolbypassrls=${role.rolbypassrls}`,
    );

    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Role "${role.rolname}" is ${role.rolsuper ? "a SUPERUSER" : ""}${
          role.rolsuper && role.rolbypassrls ? " and " : ""
        }${role.rolbypassrls ? "BYPASSRLS" : ""} — this role unconditionally bypasses every Row-Level Security policy in the database, including FORCE ROW LEVEL SECURITY. The application must not run as this role. See docs/finance-milestone-3.1-tenant-rls-hardening-proposal.md §1.1.`,
      );
    }

    console.warn("OK: current role does not bypass Row-Level Security.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
