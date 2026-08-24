import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { getDb, closeDb, users, eq } from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Milestone 3.2 Work Item 7 — refresh-token TTL enforcement, absolute model
 * (docs/hardening/milestone-3.2-work-item-7-refresh-token-ttl-enforcement-proposal.md).
 *
 * Mirrors the exact scaffolding and fixture conventions of
 * refresh-status-enforcement.e2e-spec.ts (Work Item 6) — direct
 * `db.update(users).set(...)` to simulate the passage of time rather than
 * waiting real time.
 *
 * REFRESH_TOKEN_TTL_SECONDS is 30 days (token.service.ts). All "days ago"
 * fixtures below are computed from that exact constant via
 * TokenService.refreshTokenTtlSeconds (resolved from the real app instance,
 * not hardcoded here), so this suite stays correct if that constant ever
 * changes.
 */
describe("Auth — refresh-token TTL enforcement, absolute model (e2e)", () => {
  let app: INestApplication;
  let ttlMs: number;
  const PASSWORD = "Correct-Horse-Battery-Staple-1!";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix("v1", { exclude: ["health", "health/ready"] });
    await app.init();

    // Resolve the real TTL from the real service, not a hardcoded literal.
    const { TokenService } = await import("../src/auth/token.service");
    const tokenService = moduleRef.get(TokenService);
    ttlMs = tokenService.refreshTokenTtlSeconds * 1000;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function createActiveUser() {
    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    const [user] = await db
      .insert(users)
      .values({
        tenantId: null,
        legalEntityId: null,
        email: `refresh-ttl-${randomUUID()}@example.com`,
        displayName: "Refresh TTL Enforcement Test User",
        tier: "PLATFORM_OPERATOR",
        status: "ACTIVE",
        roles: [],
        passwordHash,
      })
      .returning();
    return user!;
  }

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email, password: PASSWORD })
      .expect(201);
    expect(typeof res.body.data.refreshToken).toBe("string");
    return res.body.data as { accessToken: string; refreshToken: string };
  }

  async function setIssuedAt(userId: string, value: Date | null) {
    const db = getDb();
    await db
      .update(users)
      .set({ refreshTokenIssuedAt: value })
      .where(eq(users.id, userId));
  }

  it("rejects refresh() when refreshTokenIssuedAt is more than 30 days in the past (401) — the required adversarial case", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    await setIssuedAt(user.id, new Date(Date.now() - ttlMs - 60_000));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe(
      "Refresh token has expired. Please log in again.",
    );
  });

  it("allows refresh() for a freshly-logged-in session (issuedAt = now) (201)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
  });

  it("boundary: just before 30 days elapsed (29 days, 23 hours) is accepted (201)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    const justUnder = ttlMs - 60 * 60 * 1000; // 1 hour short of the TTL
    await setIssuedAt(user.id, new Date(Date.now() - justUnder));

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
  });

  it("boundary: exactly 30 days elapsed is rejected (401)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    // "Exactly elapsed" as issuedAt set to precisely ttlMs in the past —
    // Date.now() advances by at least 1ms between this write and the
    // request's own elapsed-time check, so this deterministically lands on
    // or past the boundary, never comfortably under it.
    await setIssuedAt(user.id, new Date(Date.now() - ttlMs));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe(
      "Refresh token has expired. Please log in again.",
    );
  });

  it("boundary: just after 30 days elapsed is rejected (401)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    await setIssuedAt(user.id, new Date(Date.now() - ttlMs - 1_000));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe(
      "Refresh token has expired. Please log in again.",
    );
  });

  it("fail-closed: refreshTokenIssuedAt = NULL with an otherwise valid refresh token is rejected as expired (401)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    // Simulates a pre-migration row: a valid, non-expired refresh token
    // hash, but no known issuance time. Per the approved proposal §6, this
    // must be treated as expired, not as "no TTL" / grandfathered.
    await setIssuedAt(user.id, null);

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe(
      "Refresh token has expired. Please log in again.",
    );
  });

  it("rotation preserves the ORIGINAL issuance timestamp — a successful refresh does not reset refreshTokenIssuedAt (proves absolute, not sliding, TTL)", async () => {
    const user = await createActiveUser();
    const { refreshToken: originalRefreshToken } = await login(user.email);

    const db = getDb();
    const [beforeRotation] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const originalIssuedAt = beforeRotation!.refreshTokenIssuedAt;
    expect(originalIssuedAt).not.toBeNull();

    // Rotate once — a normal, successful refresh.
    const rotateRes = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: originalRefreshToken })
      .expect(201);
    const rotatedRefreshToken = rotateRes.body.data.refreshToken as string;

    const [afterRotation] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    // The core assertion: rotation must NOT change refreshTokenIssuedAt.
    expect(afterRotation!.refreshTokenIssuedAt?.getTime()).toBe(
      originalIssuedAt!.getTime(),
    );

    // Now push the ORIGINAL issuance time (not the rotation time) past the
    // TTL and confirm the ROTATED token is rejected — this is what
    // distinguishes the absolute model from a sliding one. If rotation had
    // reset the timestamp, this would incorrectly still succeed.
    await setIssuedAt(user.id, new Date(Date.now() - ttlMs - 60_000));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: rotatedRefreshToken })
      .expect(401);
    expect(res.body.error.message).toBe(
      "Refresh token has expired. Please log in again.",
    );
  });

  it("still rejects an invalid refresh token with 401 for its original reason, not the new TTL check, even for a TTL-expired session", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);
    await setIssuedAt(user.id, new Date(Date.now() - ttlMs - 60_000));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: `${user.id}.not-a-real-refresh-token` })
      .expect(401);
    // Token-hash validation runs before the TTL check, so a bad token still
    // fails with the pre-existing "Invalid refresh token." message even
    // though this account's session has also separately expired.
    expect(res.body.error.message).toBe("Invalid refresh token.");
  });

  it("login() is unaffected — a fresh login still succeeds and issues a usable session (201)", async () => {
    const user = await createActiveUser();
    const { refreshToken } = await login(user.email);

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
  });
});
