import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { getDb, closeDb, users } from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { MfaService } from "../src/auth/mfa.service";

/**
 * Milestone 3 Work Item 5 — Authentication Integrity Testing
 * (docs/hardening/milestone-3.2-work-item-5-auth-integrity-testing-proposal.md §5).
 *
 * Exercises the MFA branch of AuthService.login() end-to-end for the
 * first time in the repository's history — previously only MfaService's
 * own unit methods (secret generation, encrypt/decrypt round-trip,
 * TOTP verification) had any coverage; nothing proved the branch inside
 * login() that actually calls them behaves correctly.
 *
 * The TOTP secret is generated and encrypted via the real MfaService
 * resolved from the same AppModule the test boots (not reimplemented),
 * so the fixture exercises the exact envelope-encryption path
 * AuthService.login() decrypts at verification time.
 */
describe("Auth — MFA login branch (e2e)", () => {
  let app: INestApplication;
  let mfa: MfaService;
  const PASSWORD = "Correct-Horse-Battery-Staple-1!";
  let totpSecret: string;
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

    mfa = moduleRef.get(MfaService);

    const db = getDb();
    const passwordHash = await argon2.hash(PASSWORD);
    totpSecret = mfa.generateSecret();
    userEmail = `mfa-login-${randomUUID()}@example.com`;
    await db.insert(users).values({
      tenantId: null,
      legalEntityId: null,
      email: userEmail,
      displayName: "MFA Login Test User",
      tier: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      roles: [],
      passwordHash,
      mfaEnabled: true,
      mfaSecretEncrypted: mfa.encryptSecret(totpSecret),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("returns { mfaRequired: true } and issues no tokens when mfaCode is omitted", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PASSWORD })
      .expect(201);
    expect(res.body.data).toEqual({ mfaRequired: true });
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
  });

  it("rejects login with a wrong mfaCode (401)", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PASSWORD, mfaCode: "000000" })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid MFA code.");
  });

  it("completes login and issues tokens with the correct, freshly-generated TOTP code", async () => {
    const code = authenticator.generate(totpSecret);
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PASSWORD, mfaCode: code })
      .expect(201);
    expect(typeof res.body.data.accessToken).toBe("string");
    expect(typeof res.body.data.refreshToken).toBe("string");
  });
});
