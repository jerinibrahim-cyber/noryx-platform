import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { runWithTenantContext } from "@noryx/db-core";
import { JwtService } from "@nestjs/jwt";
import type { NoryxJwtClaims } from "@noryx/shared-types";

/**
 * Reference implementation every other service should copy: resolves the
 * tenant context from the caller's access token BEFORE any route handler
 * runs, and wraps the rest of the request in runWithTenantContext() so
 * db-core's withTenant()/getTenantContext() work anywhere downstream
 * without threading tenantId through every function call.
 *
 * A missing/invalid token is not rejected here — routes that require auth
 * do so via JwtAuthGuard; public routes (e.g. POST /v1/auth/login) simply
 * run with an empty context.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    let claims: NoryxJwtClaims | undefined;
    if (token) {
      try {
        claims = this.jwt.verify<NoryxJwtClaims>(token);
      } catch {
        // Invalid/expired token — leave claims undefined; JwtAuthGuard (if
        // present on the route) is responsible for rejecting the request.
      }
    }

    runWithTenantContext(
      {
        tenantId: claims?.tenantId ?? null,
        legalEntityId: claims?.legalEntityId ?? null,
        userId: claims?.sub ?? null,
      },
      () => next(),
    );
  }
}
