import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type {
  NoryxJwtClaims,
  AuthenticatedRequestUser,
} from "@noryx/shared-types";

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
