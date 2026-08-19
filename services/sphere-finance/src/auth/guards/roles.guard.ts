import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";

/**
 * Copied from services/identity/src/auth/guards/roles.guard.ts — identical
 * logic. This is the per-route, server-side RBAC enforcement for Finance:
 * the API Gateway's manifest-level requiredRoles is only a coarse
 * module-wide gate, not fine-grained per-route enforcement — this guard is
 * what actually distinguishes finance.viewer (read) from finance.admin
 * (write) on each AccountsController route.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedRequestUser | undefined;
    if (!user) return false;

    // Platform Operators bypass per-tenant role checks by design — they
    // operate cross-tenant for support/provisioning (System Architecture v1 §3.2).
    if (user.tier === "PLATFORM_OPERATOR") return true;

    const hasRole = requiredRoles.some((r) => user.roles.includes(r));
    if (!hasRole) {
      throw new ForbiddenException(
        `Requires one of roles: ${requiredRoles.join(", ")}`,
      );
    }
    return true;
  }
}
