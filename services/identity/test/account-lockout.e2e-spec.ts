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
 * Proves the in-memory brute-force lockout in AuthService.login()
 * (MAX_FAILED_ATTEMPTS = 5, keyed by "<tenantId>:<email>") actually
 * engages and actually blocks — the property that matters for "cannot
 * silently regress" (e.g. someone changing MAX_FAILED_ATTEMPTS or the
 * attemptKey composition without noticing the lockout stops firing).
 * Deliberately one test: proving the lockout resets after a subsequent
 * success is a lower-value property, called out as an optional stretch
 * case in the approved proposal §6, not part of the minimum set.
 */
describe("Auth — account lockout after repeated failed logins (e2e)", () => {
  let app: INestApplication;
  const PASSWORD = "Correct-Horse-Battery-Staple-1!";
  let userEmail: string;

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

    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    userEmail = `account-lockout-${randomUUID()}@example.com`;
    await db.insert(users).values({
      tenantId: null,
      legalEntityId: null,
      email: userEmail,
      displayName: "Account Lockout Test User",
      tier: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      roles: [],
      passwordHash,
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("locks out after 5 failed attempts, then rejects even a 6th attempt with the CORRECT password (403)", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: userEmail, password: "wrong-password-attempt" })
        .expect(401);
    }

    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PASSWORD })
      .expect(403);
    expect(res.body.error.message).toBe(
      "Too many failed login attempts. Contact your tenant admin or Noryx support to unlock this account.",
    );
  });
});
