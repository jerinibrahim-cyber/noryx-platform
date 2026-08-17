import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import type { NoryxJwtClaims, UserTier } from "@noryx/shared-types";
import type { User } from "@noryx/db-core";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // short-lived, per Readiness Review §7.5
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  /**
   * `entitledModules` is resolved by the caller from the tenant's active
   * Subscription (Pre-Development Readiness Review §6, Phase 0) — a
   * suspended/terminated subscription simply resolves to an empty list,
   * so downstream services deny access without a separate billing check.
   */
  issueAccessToken(
    user: Pick<User, "id" | "tenantId" | "legalEntityId" | "tier" | "roles">,
    entitledModules: string[],
  ): string {
    const claims: Omit<NoryxJwtClaims, "iat" | "exp"> = {
      sub: user.id,
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      tier: user.tier as UserTier,
      roles: user.roles,
      modules: entitledModules,
    };
    return this.jwt.sign(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  }

  /** Opaque random token — never a JWT, so it carries no inspectable claims if leaked. */
  generateRefreshToken(): string {
    return randomBytes(48).toString("base64url");
  }

  async hashRefreshToken(token: string): Promise<string> {
    return argon2.hash(token);
  }

  async verifyRefreshToken(token: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, token);
    } catch {
      return false;
    }
  }

  get refreshTokenTtlSeconds(): number {
    return REFRESH_TOKEN_TTL_SECONDS;
  }

  get accessTokenTtlSeconds(): number {
    return ACCESS_TOKEN_TTL_SECONDS;
  }
}
