import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import * as argon2 from "argon2";
import {
  getDb,
  withTenant,
  users,
  subscriptions,
  eq,
  and,
} from "@noryx/db-core";
import type { LoginDto } from "./dto/login.dto";
import { TokenService, type IssuedTokens } from "./token.service";
import { MfaService } from "./mfa.service";

const MAX_FAILED_ATTEMPTS = 5;
// In-memory for Phase 0 single-instance dev; graduates to a shared Redis
// counter once the service runs more than one replica (docker-compose.yml
// already provisions Redis for this reason — see cache/rate-limit TODO).
const failedAttempts = new Map<string, number>();

export interface MfaChallengeResult {
  mfaRequired: true;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
  ) {}

  async login(dto: LoginDto): Promise<IssuedTokens | MfaChallengeResult> {
    const attemptKey = `${dto.tenantId ?? "platform"}:${dto.email}`;
    if ((failedAttempts.get(attemptKey) ?? 0) >= MAX_FAILED_ATTEMPTS) {
      throw new ForbiddenException(
        "Too many failed login attempts. Contact your tenant admin or Noryx support to unlock this account.",
      );
    }

    const db = getDb();
    const user = await withTenant(dto.tenantId ?? null, async (tx) => {
      const where = dto.tenantId
        ? and(eq(users.tenantId, dto.tenantId), eq(users.email, dto.email))
        : and(eq(users.email, dto.email));
      const rows = await tx.select().from(users).where(where).limit(1);
      return rows[0];
    });

    if (!user || !user.passwordHash || user.status !== "ACTIVE") {
      this.recordFailure(attemptKey);
      throw new UnauthorizedException("Invalid credentials.");
    }

    const passwordOk = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordOk) {
      this.recordFailure(attemptKey);
      throw new UnauthorizedException("Invalid credentials.");
    }

    if (user.accessExpiresAt && user.accessExpiresAt < new Date()) {
      throw new ForbiddenException("This account's access window has expired.");
    }

    // Non-payment enforcement (chat decision: Active -> Past Due -> Suspended
    // -> Terminated). Platform Operators are exempt — they administer
    // tenants regardless of a tenant's own billing state.
    let entitledModules: string[] = [];
    if (user.tier !== "PLATFORM_OPERATOR" && user.tenantId) {
      const subRows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, user.tenantId))
        .limit(1);
      const subscription = subRows[0];
      if (!subscription || subscription.status === "TERMINATED") {
        throw new ForbiddenException(
          "This tenant's subscription is not active. Contact Noryx support.",
        );
      }
      if (subscription.status === "SUSPENDED") {
        // Suspended tenants can still authenticate (System Architecture v1 /
        // chat decision: read-only access, not a hard lockout) — the entitled
        // module list is intentionally empty so write-capable modules 403 downstream.
        entitledModules = [];
      } else {
        entitledModules = subscription.entitledModules;
      }
    }

    if (user.mfaEnabled) {
      if (!dto.mfaCode) {
        return { mfaRequired: true };
      }
      if (
        !user.mfaSecretEncrypted ||
        !this.mfa.verifyToken(
          dto.mfaCode,
          this.mfa.decryptSecret(user.mfaSecretEncrypted),
        )
      ) {
        this.recordFailure(attemptKey);
        throw new UnauthorizedException("Invalid MFA code.");
      }
    }

    failedAttempts.delete(attemptKey);
    return this.issueTokensAndPersistRefresh(user, entitledModules);
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    // Refresh tokens are opaque and hashed at rest (Readiness Review §7.4) —
    // we can't look the row up by token, so this requires a userId hint in
    // a real deployment (e.g. carried in an HttpOnly cookie alongside the
    // opaque token). Phase 0 stub: expects "<userId>.<token>".
    const [userId, token] = refreshToken.split(".", 2);
    if (!userId || !token)
      throw new UnauthorizedException("Malformed refresh token.");

    const user = await withTenant(null, async (tx) => {
      const rows = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0];
    });
    if (!user || !user.refreshTokenHash)
      throw new UnauthorizedException("Invalid refresh token.");

    const valid = await this.tokens.verifyRefreshToken(
      token,
      user.refreshTokenHash,
    );
    if (!valid) throw new UnauthorizedException("Invalid refresh token.");

    let entitledModules: string[] = [];
    if (user.tier !== "PLATFORM_OPERATOR" && user.tenantId) {
      const subRows = await getDb()
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, user.tenantId))
        .limit(1);
      const subscription = subRows[0];
      entitledModules =
        subscription &&
        subscription.status !== "SUSPENDED" &&
        subscription.status !== "TERMINATED"
          ? subscription.entitledModules
          : [];
    }

    return this.issueTokensAndPersistRefresh(user, entitledModules);
  }

  async logout(userId: string): Promise<void> {
    await withTenant(null, (tx) =>
      tx
        .update(users)
        .set({ refreshTokenHash: null })
        .where(eq(users.id, userId)),
    );
  }

  private async issueTokensAndPersistRefresh(
    user: {
      id: string;
      tenantId: string | null;
      legalEntityId: string | null;
      tier: string;
      roles: string[];
    },
    entitledModules: string[],
  ): Promise<IssuedTokens> {
    const accessToken = this.tokens.issueAccessToken(
      user as any,
      entitledModules,
    );
    const rawRefreshToken = this.tokens.generateRefreshToken();
    const refreshTokenHash =
      await this.tokens.hashRefreshToken(rawRefreshToken);

    await withTenant(user.tenantId, (tx) =>
      tx.update(users).set({ refreshTokenHash }).where(eq(users.id, user.id)),
    );

    return {
      accessToken,
      refreshToken: `${user.id}.${rawRefreshToken}`,
      expiresIn: this.tokens.accessTokenTtlSeconds,
    };
  }

  private recordFailure(key: string) {
    failedAttempts.set(key, (failedAttempts.get(key) ?? 0) + 1);
  }
}
