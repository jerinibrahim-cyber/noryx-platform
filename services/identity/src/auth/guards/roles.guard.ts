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
 * Coarse RBAC gate — "does this user have one of the required roles at
 * all." Field/record-level rules (e.g. Sales can read but not write
 * Finance-owned Party fields) are the Rules Engine's job downstream, not
 * this guard's (System Architecture v1 §7, Readiness Review §7.4/§7.5).
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
