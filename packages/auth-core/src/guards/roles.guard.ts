import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { hasRequiredRole, requiredRolesMessage } from "../authorization";

/**
 * Milestone 3.2 Stage 1 — the single shared RolesGuard; previously
 * duplicated verbatim in services/identity (unused by any route there)
 * and services/sphere-finance (the copy actually enforced on every
 * Finance controller route). Internally delegates the pass/fail decision
 * to hasRequiredRole() (../authorization.ts) — the same function
 * api-gateway's ProxyController now calls for its own module-level
 * requiredRoles check, so there is exactly one implementation of "does
 * this role list satisfy that requirement" in the whole platform
 * (docs/hardening/milestone-3.2-proposal.md §8 gap 4, Threat T2).
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

    if (!hasRequiredRole(user, requiredRoles)) {
      throw new ForbiddenException(requiredRolesMessage(requiredRoles));
    }
    return true;
  }
}
