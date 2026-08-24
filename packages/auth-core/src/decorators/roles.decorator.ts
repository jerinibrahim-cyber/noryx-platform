import { SetMetadata } from "@nestjs/common";

/**
 * Milestone 3.2 Stage 1 — the single shared @Roles() decorator; previously
 * duplicated in services/identity (unused by any route there) and
 * services/sphere-finance (applied on every Finance controller route).
 */
export const ROLES_KEY = "roles";
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
