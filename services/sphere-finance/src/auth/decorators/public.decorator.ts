import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
/** Marks a route as reachable without a valid access token. Finance has no
 * such routes today (health checks are wired separately, outside the
 * JwtAuthGuard's scope) — kept for parity with the reference pattern and
 * in case a future public route is genuinely needed. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
