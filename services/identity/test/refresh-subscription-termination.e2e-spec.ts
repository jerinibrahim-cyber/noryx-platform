import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import {
  getDb,
  closeDb,
  users,
  tenants,
  subscriptions,
  eq,
} from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Milestone 3.2 Work Item 8 — subscription-TERMINATED enforcement on
 * refresh() (docs/hardening/milestone-3.2-work-item-8-subscription-
 * termination-refresh-proposal.md).
 *
 * First e2e coverage of the subscription-status branch of either login() or
 * refresh() at all — confirmed via repository-wide search; auth.e2e-spec.ts
 * explicitly notes it avoids needing tenants/subscriptions fixtures. Follows
 * the tenants-insert pattern already established in
 * services/sphere-finance/test/*.e2e-spec.ts.
 */
describe("Auth — subscription TERMINATED/missing enforcement on refresh (e2e)", () => {
  let app: INestApplication;
  const PASSWORD = "Correct-Horse-Battery-Staple-1!";
  const EXPECTED_MESSAGE =
    "This tenant's subscription is not active. Contact Noryx support.";

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

  /** Creates a tenant, an optional subscription at the given status, and a
   * TENANT_INTERNAL user under that tenant, then logs in. Pass
   * subscriptionStatus: null to create no subscriptions row at all. */
  async function createTenantUserAndLogin(
    subscriptionStatus:
      "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "TERMINATED" | null,
  ) {
    const db = getDb();
    const suffix = randomUUID();
    const [tenant] = await db
      .insert(tenants)
      .values({
        slug: `sub-term-${suffix}`,
        name: "Subscription Termination Test Tenant",
      })
      .returning();

    if (subscriptionStatus !== null) {
      await db.insert(subscriptions).values({
        tenantId: tenant!.id,
        status: subscriptionStatus,
        seatLimit: 10,
        entitledModules: ["sphere-finance"],
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
    }

    const passwordHash = await argon2.hash(PASSWORD);
    const email = `sub-term-${suffix}@example.com`;
    const [user] = await db
      .insert(users)
      .values({
        tenantId: tenant!.id,
        legalEntityId: null,
        email,
        displayName: "Subscription Termination Test User",
        tier: "TENANT_INTERNAL",
        status: "ACTIVE",
        roles: [],
        passwordHash,
      })
      .returning();

    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ tenantId: tenant!.id, email, password: PASSWORD });

    return { tenant: tenant!, user: user!, loginRes };
  }

  it("rejects refresh() when the tenant's subscription was set to TERMINATED after login (403) — required adversarial case", async () => {
    const { tenant, loginRes } = await createTenantUserAndLogin("ACTIVE");
    expect(loginRes.status).toBe(201);
    const { refreshToken } = loginRes.body.data;

    // Terminate the subscription after the session was already established.
    const db = getDb();
    await db
      .update(subscriptions)
      .set({ status: "TERMINATED" })
      .where(eq(subscriptions.tenantId, tenant.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(403);
    expect(res.body.error.message).toBe(EXPECTED_MESSAGE);
  });

  it("rejects refresh() when the tenant has no subscription row at all (403) — missing-subscription adversarial case", async () => {
    const { loginRes } = await createTenantUserAndLogin("ACTIVE");
    expect(loginRes.status).toBe(201);
    const { refreshToken } = loginRes.body.data;
    const userId = refreshToken.split(".")[0];

    // Delete the subscription row entirely (simulates never-provisioned or
    // removed subscription) after the session was already established.
    const db = getDb();
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    await db
      .delete(subscriptions)
      .where(eq(subscriptions.tenantId, row!.tenantId!));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(403);
    expect(res.body.error.message).toBe(EXPECTED_MESSAGE);
  });

  it("SUSPENDED subscription: refresh() still succeeds with the existing soft-degrade (201) — regression, unchanged behavior", async () => {
    const { loginRes } = await createTenantUserAndLogin("SUSPENDED");
    expect(loginRes.status).toBe(201);
    const { refreshToken } = loginRes.body.data;

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
    expect(typeof res.body.data.accessToken).toBe("string");
  });

  it("ACTIVE subscription: refresh() succeeds normally (201) — regression", async () => {
    const { loginRes } = await createTenantUserAndLogin("ACTIVE");
    expect(loginRes.status).toBe(201);
    const { refreshToken } = loginRes.body.data;

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(201);
  });

  it("PLATFORM_OPERATOR exemption is preserved — refresh() is unaffected regardless of subscription state", async () => {
    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    const email = `sub-term-po-${randomUUID()}@example.com`;
    await db.insert(users).values({
      tenantId: null,
      legalEntityId: null,
      email,
      displayName: "Platform Operator Test User",
      tier: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      roles: [],
      passwordHash,
    });
    const loginRes = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email, password: PASSWORD })
      .expect(201);

    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: loginRes.body.data.refreshToken })
      .expect(201);
  });

  it("login() behavior is unchanged — still rejects TERMINATED and missing subscriptions at login (403)", async () => {
    const db = getDb();

    const terminated = await createTenantUserAndLogin("TERMINATED");
    expect(terminated.loginRes.status).toBe(403);
    expect(terminated.loginRes.body.error.message).toBe(EXPECTED_MESSAGE);

    const missing = await createTenantUserAndLogin(null);
    expect(missing.loginRes.status).toBe(403);
    expect(missing.loginRes.body.error.message).toBe(EXPECTED_MESSAGE);

    void db; // fixtures already cleaned up via createTenantUserAndLogin's own inserts
  });

  it("still rejects an invalid refresh token with 401 for its original reason, not the new subscription check, even for a TERMINATED tenant", async () => {
    const { tenant, user } = await createTenantUserAndLogin("TERMINATED");
    void user;

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: `${user.id}.not-a-real-refresh-token` })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid refresh token.");
    void tenant;
  });

  it("a user simultaneously SUSPENDED (status) and TERMINATED (subscription) is rejected by the existing user.status check first, not the new subscription check", async () => {
    const { tenant, user, loginRes } =
      await createTenantUserAndLogin("TERMINATED");
    // login() already rejects a TERMINATED subscription, so we can't get a
    // refresh token via the normal login flow here — issue one directly by
    // fixing the subscription to ACTIVE just long enough to log in, then
    // flip both user.status and subscription.status afterward.
    expect(loginRes.status).toBe(403);

    const db = getDb();
    await db
      .update(subscriptions)
      .set({ status: "ACTIVE" })
      .where(eq(subscriptions.tenantId, tenant.id));
    const freshLogin = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ tenantId: tenant.id, email: user.email, password: PASSWORD })
      .expect(201);
    const { refreshToken } = freshLogin.body.data;

    await db
      .update(users)
      .set({ status: "SUSPENDED" })
      .where(eq(users.id, user.id));
    await db
      .update(subscriptions)
      .set({ status: "TERMINATED" })
      .where(eq(subscriptions.tenantId, tenant.id));

    const res = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
    // The Work Item 6 user.status check runs before the subscription check,
    // so this must be the status-check message, not the subscription one.
    expect(res.body.error.message).toBe("Invalid credentials.");
  });
});
