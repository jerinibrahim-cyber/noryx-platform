import type { UserTier } from "@noryx/shared-types";

/**
 * Milestone 3.2 Stage 1 (docs/hardening/milestone-3.2-proposal.md §8 gap 4,
 * §9 item 1) — the single "does this role list satisfy that requirement"
 * decision, previously reimplemented three independent times: identity's
 * RolesGuard, sphere-finance's byte-for-byte copy of the same guard, and
 * api-gateway's ProxyController hand-rolling the identical check inline
 * for its module-level `requiredRoles` gate. Centralized here so a future
 * fix (e.g. a case-sensitivity change) only needs to be made once, instead
 * of drifting across three call sites (Threat T2 in the 3.2 discovery
 * document).
 *
 * Behavior is preserved exactly from all three prior implementations —
 * this is a deduplication, not a policy change:
 * - No `requiredRoles` (undefined or empty) means no restriction — passes.
 * - `PLATFORM_OPERATOR` unconditionally bypasses the check (System
 *   Architecture v1 §3.2) — Platform Operators operate cross-tenant for
 *   support/provisioning, regardless of what `roles` they hold.
 * - Otherwise, OR-semantics: `subject.roles` must contain at least one of
 *   `requiredRoles`. A caller needing two capabilities is simply granted
 *   both role strings on their account — there is no AND-logic here, by
 *   design (docs/finance-journal-engine-proposal.md §7).
 */
export interface RoleCheckSubject {
  tier: UserTier;
  roles: string[];
}

export function hasRequiredRole(
  subject: RoleCheckSubject,
  requiredRoles: string[] | undefined,
): boolean {
  if (!requiredRoles || requiredRoles.length === 0) return true;
  if (subject.tier === "PLATFORM_OPERATOR") return true;
  return requiredRoles.some((r) => subject.roles.includes(r));
}

/**
 * The exact "Requires one of roles: ..." message every prior
 * implementation threw verbatim — centralized alongside hasRequiredRole()
 * so the wording can't drift between call sites either.
 */
export function requiredRolesMessage(requiredRoles: string[]): string {
  return `Requires one of roles: ${requiredRoles.join(", ")}`;
}
