/** Mirrors the Drizzle userTierEnum in @noryx/db-core — kept as a plain
 * union here so packages that don't depend on db-core (e.g. frontend apps)
 * still get the type. */
export type UserTier =
  "PLATFORM_OPERATOR" | "TENANT_INTERNAL" | "TENANT_EXTERNAL";

/** Claims carried on every Noryx access token (System Architecture v1 §7). */
export interface NoryxJwtClaims {
  sub: string; // user id
  tenantId: string | null; // null only for PLATFORM_OPERATOR
  legalEntityId: string | null;
  tier: UserTier;
  roles: string[];
  /** Entitled module keys resolved at token-issue time — see ModuleManifest. */
  modules: string[];
  iat: number;
  exp: number;
}

export interface AuthenticatedRequestUser {
  userId: string;
  tenantId: string | null;
  legalEntityId: string | null;
  tier: UserTier;
  roles: string[];
}
