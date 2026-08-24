import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type {
  NoryxJwtClaims,
  AuthenticatedRequestUser,
} from "@noryx/shared-types";

/**
 * Milestone 3.2 Stage 1 — the single Passport JWT strategy every service
 * that verifies (not issues) Noryx access tokens uses. Previously
 * duplicated verbatim in services/identity and services/sphere-finance
 * (docs/hardening/milestone-3.2-proposal.md §8 gap 4); identical logic,
 * now with exactly one implementation. Only services/identity issues
 * tokens (its own token.service.ts, unaffected by this move) — every
 * service, including identity itself, verifies them through this
 * strategy.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      throw new Error(
        "JWT_ACCESS_SECRET must be set — see .env.example. Never defaults in code.",
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(claims: NoryxJwtClaims): AuthenticatedRequestUser {
    return {
      userId: claims.sub,
      tenantId: claims.tenantId,
      legalEntityId: claims.legalEntityId,
      tier: claims.tier,
      roles: claims.roles,
    };
  }
}
