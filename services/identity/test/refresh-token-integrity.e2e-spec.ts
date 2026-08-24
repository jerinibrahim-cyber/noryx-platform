import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { getDb, closeDb, users } from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Milestone 3 Work Item 5 — Authentication Integrity Testing
 * (docs/hardening/milestone-3.2-work-item-5-auth-integrity-testing-proposal.md §5).
 *
 * Proves two refresh-token session-integrity properties that were never
 * tested anywhere before this work item, even though both are already
 * correctly implemented by AuthService's existing rotate-on-use /
 * null-out-on-logout mechanics (services/identity/src/auth/auth.service.ts):
 *
 * 1. A refresh token is single-use — once rotated by a successful
 *    refresh(), the prior raw token no longer matches the stored hash
 *    and is rejected on reuse (replay protection).
 * 2. logout() genuinely terminates the session server-side (sets
 *    refreshTokenHash to null) rather than being a client-side-only
 *    no-op — a subsequent refresh() with the pre-logout token fails.
 */
describe("Auth — refresh-token session integrity (e2e)", () => {
  let app: INestApplication;
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
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  /** Creates a fresh user and logs them in, returning the login response's issued tokens. */
  async function createAndLogin(): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    const email = `refresh-integrity-${randomUUID()}@example.com`;
    await db.insert(users).values({
      tenantId: null,
      legalEntityId: null,
      email,
      displayName: "Refresh Token Integrity Test User",
      tier: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      roles: [],
      passwordHash,
    });
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email, password: PASSWORD })
      .expect(201);
    return {
      accessToken: loginRes.body.data.accessToken,
      refreshToken: loginRes.body.data.refreshToken,
    };
  }

  it("rejects reuse of a refresh token after it has been rotated by a prior successful refresh (401)", async () => {
    const { refreshToken: originalRefreshToken } = await createAndLogin();

    // First refresh: succeeds and rotates the stored hash.
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: originalRefreshToken })
      .expect(201);

    // Replaying the now-stale original token must fail — it no longer
    // matches the rotated hash.
    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: originalRefreshToken })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid refresh token.");
  });

  it("rejects a refresh attempt with a token that was valid before logout (401)", async () => {
    const { accessToken, refreshToken } = await createAndLogin();

    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid refresh token.");
  });
});
