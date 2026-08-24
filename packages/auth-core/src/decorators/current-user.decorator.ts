import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";

/**
 * Milestone 3.2 Stage 1 — the single shared @CurrentUser() decorator;
 * previously duplicated verbatim in services/identity and
 * services/sphere-finance.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedRequestUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedRequestUser;
  },
);
