import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { runWithTenantContext } from "@noryx/db-core";
import { JwtService } from "@nestjs/jwt";
import type { NoryxJwtClaims } from "@noryx/shared-types";

/**
 * Copied from services/identity/src/tenant/tenant-context.middleware.ts,
 * whose doc comment names it "reference implementation every other
 * service should copy." Resolves tenant context from the caller's access
 * token before any route handler runs; withTenant()/getTenantContext()
 * from @noryx/db-core (and Finance's own withTenant() in src/db/db.ts,
 * which shares the same underlying implementation) work anywhere
 * downstream without threading tenantId through every function call.
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
        // Invalid/expired token — leave claims undefined; JwtAuthGuard is
        // responsible for rejecting the request.
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
