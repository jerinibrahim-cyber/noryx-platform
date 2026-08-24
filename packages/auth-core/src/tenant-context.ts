import { ForbiddenException } from "@nestjs/common";

/**
 * Milestone 3.2 Stage 2 (docs/hardening/milestone-3.2-proposal.md §8 gap 5,
 * §9 item 2) — the single "does this authenticated caller have a usable
 * tenant + legal-entity context" check, previously reimplemented four
 * independent times as a private `requireTenantId()`/`requireLegalEntityId()`
 * method pair on every Finance controller (accounts, accounting-periods,
 * journal-entries, general-ledger). Centralized here, in the same package
 * Stage 1 centralized JWT/RBAC into, so this can't drift the same way the
 * three JwtStrategy/RolesGuard copies did.
 *
 * This sits alongside, not instead of, the RLS enforcement Milestone 3.1
 * hardened, and is unrelated to the separate `TenantContextMiddleware`
 * duplicated between services/identity and services/sphere-finance (that
 * middleware populates db-core's AsyncLocalStorage tenant context for RLS
 * and never rejects a request; this function is an application-layer
 * pre-check that does). Both are out of scope for this change.
 *
 * Behavior is preserved exactly from all four prior implementations —
 * this is a deduplication, not a policy change:
 * - tenantId is checked first; if both tenantId and legalEntityId are
 *   missing, the tenant-context error is the one thrown (matches every
 *   prior call site, which always evaluated requireTenantId() before
 *   requireLegalEntityId()).
 * - Each prior implementation's exact message wording (including the
 *   singular/plural verb agreement, which differs per resource — "Chart
 *   of Accounts requires" vs. "accounting periods require") is preserved
 *   by taking the full verb-inclusive phrase as a parameter, rather than
 *   inventing pluralization logic that didn't exist before.
 */
export interface TenantContextSubject {
  tenantId: string | null;
  legalEntityId: string | null;
}

export interface TenantContext {
  tenantId: string;
  legalEntityId: string;
}

/**
 * @param resourcePhrase The exact verb-inclusive phrase this resource's
 *   prior private methods used, e.g. `"Chart of Accounts requires"` or
 *   `"accounting periods require"`. Inserted verbatim between "no tenant
 *   context; "/"no legal-entity context; " and "a tenant-scoped
 *   token."/"a legal-entity-scoped token."
 */
export function requireTenantContext(
  user: TenantContextSubject,
  resourcePhrase: string,
): TenantContext {
  if (!user.tenantId) {
    throw new ForbiddenException(
      `This token has no tenant context; ${resourcePhrase} a tenant-scoped token.`,
    );
  }
  if (!user.legalEntityId) {
    throw new ForbiddenException(
      `This token has no legal-entity context; ${resourcePhrase} a legal-entity-scoped token.`,
    );
  }
  return { tenantId: user.tenantId, legalEntityId: user.legalEntityId };
}
