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
 * Milestone 3.2 Work Item 6 — user.status enforcement on refresh()
 * (docs/hardening/milestone-3.2-work-item-6-refresh-status-enforcement-proposal.md).
 *
 * Mirrors the exact scaffolding and fixture conventions of
 * test/auth.e2e-spec.ts (the sibling accessExpiresAt-on-refresh suite) —
 * PLATFORM_OPERATOR/tenantId:null fixtures to sidestep the unrelated
 * subscription-entitlement lookup, main.ts's bootstrap re-applied manually.
 *
 * Proves: a user's refresh token stops working the moment their account is
 * suspended or deactivated, even though the token itself was valid at
 * issuance and nothing about the token itself has changed — closing the
 * gap where only login() re-checked status, not refresh().
 */
describe("Auth — user.status enforcement on refresh (e2e)", () => {
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

  async function createActiveUser() {
    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    const [user] = await db
      .insert(users)
      .values({
        tenantId: null,
        legalEntityId: null,
        email: `refresh-status-${randomUUID()}@example.com`,
        displayName: "Refresh Status Enforcement Test User",
        tier: "PLATFORM_OPERATOR",
        status: "ACTIVE",
        roles: [],
        passwordHash,
      })
      .returning();
    return user!;
  }

  async function loginAndGetRefreshToken(email: string): Promise<string> {
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email, password: PASSWORD })
      .expect(201);
    const { refreshToken } = loginRes.body.data;
    expect(typeof refreshToken).toBe("string");
    return refreshToken;
  }

  it("rejects refresh() when the user was suspended after the refresh token was issued (401) — the required adversarial case", async () => {
    const user = await createActiveUser();
    const refreshToken = await loginAndGetRefreshToken(user.email);

    // Simulate an admin suspending the account after login — the exact
    // scenario the gap describes: the session is already live, so login()
    // is never in play again for this account.
    const db = getDb();
    await db
      .update(users)
      .set({ status: "SUSPENDED" })
      .where(eq(users.id, user.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials.");
  });

  it("rejects refresh() when the user was deactivated after the refresh token was issued (401) — same-shape adversarial case", async () => {
    const user = await createActiveUser();
    const refreshToken = await loginAndGetRefreshToken(user.email);

    const db = getDb();
    await db
      .update(users)
      .set({ status: "DEACTIVATED" })
      .where(eq(users.id, user.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials.");
  });

  it("allows refresh() to proceed when the user is still ACTIVE (201) — regression, proves the fix doesn't over-reject", async () => {
    const user = await createActiveUser();
    const refreshToken = await loginAndGetRefreshToken(user.email);

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
  });

  it("still rejects an invalid refresh token with 401 for a suspended user, for the same reason as before (token validation, not the new status check)", async () => {
    const user = await createActiveUser();
    // No successful login/refresh-token issuance at all — proves the new
    // status check never gets a chance to run before token validation
    // rejects first, so an invalid token yields 401 for its original
    // reason (bad token) even for an account that is also suspended.
    const db = getDb();
    await db
      .update(users)
      .set({ status: "SUSPENDED" })
      .where(eq(users.id, user.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: `${user.id}.not-a-real-refresh-token` })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid refresh token.");
  });

  it("still rejects login() itself for a suspended user (401) — regression, proves the pre-existing login() check is untouched", async () => {
    const user = await createActiveUser();
    const db = getDb();
    await db
      .update(users)
      .set({ status: "SUSPENDED" })
      .where(eq(users.id, user.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials.");
  });
});
