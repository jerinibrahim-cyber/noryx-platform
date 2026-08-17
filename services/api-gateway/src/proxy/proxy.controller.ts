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
      if (
        module.requiredRoles &&
        module.requiredRoles.length > 0 &&
        claims.tier !== "PLATFORM_OPERATOR"
      ) {
        const hasRole = module.requiredRoles.some((r) =>
          claims.roles.includes(r),
        );
        if (!hasRole) {
          throw new ForbiddenException(
            `Requires one of roles: ${module.requiredRoles.join(", ")}`,
          );
        }
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
