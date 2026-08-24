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
 * Milestone 3.2 — accessExpiresAt enforcement on refresh()
 * (docs/hardening/milestone-3.2-access-expiry-refresh-proposal.md).
 *
 * This is the first e2e coverage of services/identity's login()/refresh()
 * behavior at all — narrowly scoped to the accessExpiresAt gap this work
 * item closes, not a general authentication-flow test suite (see the
 * proposal's §9 out-of-scope list).
 *
 * Mirrors main.ts's bootstrap (ValidationPipe, ResponseInterceptor,
 * AllExceptionsFilter, the "v1" global prefix) so response shapes and
 * routes match production exactly, same convention as
 * services/sphere-finance/test/accounts.e2e-spec.ts.
 *
 * Fixtures use tier "PLATFORM_OPERATOR" with tenantId: null deliberately:
 * it sidesteps AuthService's subscription-entitlement lookup entirely
 * (`if (user.tier !== "PLATFORM_OPERATOR" && user.tenantId)`), which is
 * orthogonal to what this suite proves, keeping each test to a single
 * `users` row insert with no `tenants`/`subscriptions` fixtures needed.
 */
describe("Auth — accessExpiresAt enforcement on refresh (e2e)", () => {
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

  async function createUser(accessExpiresAt: Date | null) {
    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    const [user] = await db
      .insert(users)
      .values({
        tenantId: null,
        legalEntityId: null,
        email: `access-expiry-${randomUUID()}@example.com`,
        displayName: "Access Expiry Test User",
        tier: "PLATFORM_OPERATOR",
        status: "ACTIVE",
        roles: [],
        passwordHash,
        accessExpiresAt,
      })
      .returning();
    return user!;
  }

  it("rejects refresh() when accessExpiresAt has passed since the refresh token was issued (403) — the required adversarial case", async () => {
    // Login while access is still valid (no expiry set at login time).
    const user = await createUser(null);
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    const { refreshToken } = loginRes.body.data;
    expect(typeof refreshToken).toBe("string");

    // Simulate the access window closing after login — e.g. an admin
    // shortens/revokes a time-boxed grant while the session is still live.
    const db = getDb();
    await db
      .update(users)
      .set({ accessExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(users.id, user.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(403);
    expect(res.body.error.message).toBe(
      "This account's access window has expired.",
    );
  });

  it("allows refresh() to proceed when accessExpiresAt is null (201)", async () => {
    const user = await createUser(null);
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: loginRes.body.data.refreshToken })
      .expect(201);
  });

  it("allows refresh() to proceed when accessExpiresAt is in the future (201)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const user = await createUser(future);
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: loginRes.body.data.refreshToken })
      .expect(201);
  });

  it("still rejects login() itself when accessExpiresAt has already passed (403) — regression, proves the pre-existing login() check is untouched", async () => {
    const past = new Date(Date.now() - 60_000);
    const user = await createUser(past);
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
    expect(res.body.error.message).toBe(
      "This account's access window has expired.",
    );
  });

  it("still rejects an invalid refresh token with 401, not 403, even for a user whose access has already expired — proves check ordering", async () => {
    const user = await createUser(new Date(Date.now() - 60_000));
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: `${user.id}.not-a-real-refresh-token` })
      .expect(401);
  });
});
