import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
/**
 * Marks a route as reachable without a valid access token (e.g. Identity's
 * login/refresh). Milestone 3.2 Stage 1 — the single shared copy;
 * previously duplicated in services/identity and services/sphere-finance.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
