import {
  All,
  Controller,
  ForbiddenException,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtService } from "@nestjs/jwt";
import { hasRequiredRole, requiredRolesMessage } from "@noryx/auth-core";
import { ModuleRegistryService } from "../module-registry/module-registry.service";
import { ProxyService } from "./proxy.service";
import type { NoryxJwtClaims } from "@noryx/shared-types";

/**
 * The single entry point for every module route. Resolution order per
 * request: find the module by path prefix -> if it's not public, verify
 * the token -> check the module's entitlement key against the token's
 * `modules` claim (issued by Identity from the tenant's live Subscription,
 * System Architecture v1 / Readiness Review §6) -> check requiredRoles ->
 * forward. A module that isn't in the registry 404s; the registry not
 * having loaded yet 503s rather than 404s, so "the gateway hasn't finished
 * booting" is distinguishable from "that route doesn't exist."
 *
 * Milestone 3.2 Stage 1 (docs/hardening/milestone-3.2-proposal.md §8 gap 4,
 * §9 item 1): the `requiredRoles` check below now calls the same
 * hasRequiredRole()/requiredRolesMessage() functions services/identity and
 * services/sphere-finance's RolesGuard call, instead of a third,
 * independently hand-rolled copy of the identical "PLATFORM_OPERATOR
 * bypasses; otherwise OR-match against the role list" decision. This
 * route's request flow (resolve module by path, decide public-ness
 * per-request from the registry, verify a raw bearer token with this
 * service's own JwtService) is architecturally different from a
 * per-controller Nest guard and is deliberately NOT restructured onto
 * JwtAuthGuard/RolesGuard here — a single `@All("v1/*")` catch-all route
 * can't apply a static per-route `@Roles()` decorator the way Finance's
 * controllers do, since which module (and which roles it requires) is
 * resolved dynamically per request, not statically per route. The
 * module-level `requiredRoles` semantics (a coarse pre-filter distinct
 * from Finance's per-route RBAC) are unchanged — only the pass/fail
 * decision logic is now shared, not the request flow.
 */
@Controller()
export class ProxyController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly proxy: ProxyService,
    private readonly jwt: JwtService,
  ) {}

  @All("v1/*")
  async handle(@Req() req: Request, @Res() res: Response) {
    if (this.registry.getAll().length === 0) {
      throw new ServiceUnavailableException(
        "No modules are currently registered with the gateway.",
      );
    }

    const module = this.registry.resolveByPath(req.path);
    if (!module) {
      res.status(404).json({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No module is mounted at ${req.path}`,
        },
      });
      return;
    }

    if (!module.public) {
      const claims = this.verifyToken(req);
      if (
        !claims.modules.includes(module.key) &&
        claims.tier !== "PLATFORM_OPERATOR"
      ) {
        throw new ForbiddenException(
          `Your subscription does not include the "${module.displayName}" module.`,
        );
      }
      if (!hasRequiredRole(claims, module.requiredRoles)) {
        throw new ForbiddenException(
          requiredRolesMessage(module.requiredRoles ?? []),
        );
      }
    }

    const result = await this.proxy.forward({
      targetBaseUrl: module.serviceUrl,
      path: req.originalUrl,
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, value);
    }
    res.json(result.body);
  }

  private verifyToken(req: Request): NoryxJwtClaims {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token.");
    try {
      return this.jwt.verify<NoryxJwtClaims>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token.");
    }
  }
}
