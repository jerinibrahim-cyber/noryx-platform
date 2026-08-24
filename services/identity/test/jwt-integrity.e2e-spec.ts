import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { getDb, closeDb, users } from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Milestone 3 Work Item 5 — Authentication Integrity Testing
 * (docs/hardening/milestone-3.2-work-item-5-auth-integrity-testing-proposal.md §5).
 *
 * Targets POST /auth/logout — the only route inside services/identity
 * itself protected by JwtAuthGuard (login/refresh are @Public()). Proves
 * JwtAuthGuard's actual runtime behavior against five adversarial token
 * shapes, not just the raw jsonwebtoken library in isolation (already
 * confirmed correct out-of-band while writing the approved proposal —
 * see the proposal's §8).
 *
 * Each case is meaningfully tied to guard behavior, not tautological: if
 * JwtAuthGuard were removed or misconfigured to accept the token, the
 * request would reach AuthController.logout() with @CurrentUser()
 * resolving to a real (if wrong) principal and return 201, not 401 — so
 * these tests cannot pass by accident regardless of what's inside the
 * guarded route. Confirmed during implementation by temporarily
 * weakening JwtStrategy and reverting; see the work item's delivery
 * report for the exact throwaway edits used.
 *
 * A fresh JwtService instance is constructed per adversarial case
 * (never the AppModule's own configured one) so each test controls its
 * signing secret/algorithm explicitly, matching the same pattern
 * services/sphere-finance/test/accounts.e2e-spec.ts already uses to
 * mint tokens for its own RBAC tests.
 */
describe("Auth — JWT integrity on a guarded route (e2e)", () => {
  let app: INestApplication;
  let userId: string;
  const PASSWORD = "Correct-Horse-Battery-Staple-1!";
  const SECRET = process.env.JWT_ACCESS_SECRET!;

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
    const [user] = await db
      .insert(users)
      .values({
        tenantId: null,
        legalEntityId: null,
        email: `jwt-integrity-${randomUUID()}@example.com`,
        displayName: "JWT Integrity Test User",
        tier: "PLATFORM_OPERATOR",
        status: "ACTIVE",
        roles: [],
        passwordHash,
      })
      .returning();
    userId = user!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  function claims() {
    return {
      sub: userId,
      tenantId: null,
      legalEntityId: null,
      tier: "PLATFORM_OPERATOR" as const,
      roles: [] as string[],
      modules: [] as string[],
    };
  }

  it("rejects a request with no Authorization header at all (401)", async () => {
    await request(app.getHttpServer()).post("/v1/auth/logout").expect(401);
  });

  it("rejects a syntactically malformed token (401)", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Authorization", "Bearer not-a-real-jwt")
      .expect(401);
  });

  it("rejects a token signed with the wrong secret (401)", async () => {
    const wrongSecretJwt = new JwtService({
      secret: "a-completely-different-secret-than-JWT_ACCESS_SECRET",
    });
    const token = wrongSecretJwt.sign(claims());
    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects an expired token (401)", async () => {
    const realSecretJwt = new JwtService({ secret: SECRET });
    const token = realSecretJwt.sign(claims(), { expiresIn: -60 }); // already expired
    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects an alg:none (unsigned) token — the algorithm-confusion case (401)", async () => {
    // No secret configured on this JwtService instance at all — jsonwebtoken
    // requires exactly this (a falsy secretOrPrivateKey) to produce a
    // genuinely unsigned token; passing the real secret alongside
    // algorithm: "none" would not exercise the attack this test targets.
    const unsignedJwt = new JwtService({});
    const token = unsignedJwt.sign(claims(), { algorithm: "none" });
    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });
});
