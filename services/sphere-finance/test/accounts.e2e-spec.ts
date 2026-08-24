import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import {
  getDb as getPlatformDb,
  closeDb as closePlatformDb,
  tenants,
  legalEntities,
  auditLogs,
  eq,
  sql,
} from "@noryx/db-core";
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * This is the constraint-driven test for Milestones 1b and 2a: it must
 * prove tenant A cannot read/write tenant B's Chart of Accounts data,
 * that two legal entities under the SAME tenant cannot read/write each
 * other's Chart of Accounts either (2a retrofit —
 * docs/finance-journal-engine-proposal.md §1.1/§1.2), that RBAC is
 * enforced server-side (not just declared in the manifest), and that the
 * audit trail is genuinely append-only at the database level — not
 * merely that CRUD endpoints return 200. Runs against a real Postgres
 * instance, the same non-superuser role/database used for Identity's own
 * e2e/RLS verification (Milestone 1a's checkpoint report explains why
 * the role must be non-superuser for any of this to mean anything).
 */
describe("Accounts (e2e) — RBAC, tenant + legal-entity isolation, audit immutability", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  // Two legal entities under tenant A, one under tenant B — proves both
  // isolation dimensions independently rather than conflating them.
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  function tokenFor(
    tenantId: string,
    legalEntityId: string,
    roles: string[],
    userId?: string,
  ) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

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
    app.setGlobalPrefix("v1/finance", { exclude: ["health", "health/ready"] });
    await app.init();

    jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

    // audit_logs.tenant_id has a real FK to tenants.id (db-core's schema),
    // so the audit-trail assertions below need genuine tenant rows, not
    // just random UUIDs — matching how a tenant would actually exist by
    // the time Finance ever writes data for it. chart_of_accounts now
    // requires a real legal_entity_id too (2a retrofit) — no FK, but
    // still resolved from a genuine JWT context in every request below.
    const db = getPlatformDb();
    const suffix = Date.now();
    const [tenantA] = await db
      .insert(tenants)
      .values({ slug: `finance-e2e-a-${suffix}`, name: "Finance E2E Tenant A" })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: `finance-e2e-b-${suffix}`, name: "Finance E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "A1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 2",
        code: "A2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "B1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC — enforced server-side, not just in the manifest", () => {
    it("rejects a request with no token at all (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .expect(401);
    });

    it("rejects a validly-signed token that has neither finance role (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("allows finance.viewer to list (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("rejects finance.viewer attempting to create (403) — read role cannot write", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-VIEWER-${Date.now()}`,
          name: "Should be blocked",
          type: "ASSET",
        })
        .expect(403);
    });

    it("allows finance.admin to create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-ADMIN-${Date.now()}`,
          name: "Admin created this",
          type: "ASSET",
        })
        .expect(201);
      expect(res.body.data.code).toMatch(/^RBAC-ADMIN-/);
    });

    it("rejects a token with no legal-entity context (403)", async () => {
      const token = jwt.sign({
        sub: randomUUID(),
        tenantId: tenantAId,
        legalEntityId: null,
        tier: "TENANT_INTERNAL",
        roles: ["finance.viewer"],
        modules: ["sphere-finance"],
      });
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });
  });

  /**
   * Milestone 3.2 Stage 2 — proves the shared `requireTenantContext()`
   * (packages/auth-core/src/tenant-context.ts) is actually wired into and
   * enforced by this controller, not just unit-tested in isolation. This
   * is deliberately the one controller carrying this focused proof — per
   * the Stage 2 approval, the mechanism itself doesn't need duplicate e2e
   * coverage in all four controllers, only proof it works end-to-end
   * somewhere real.
   */
  describe("shared tenant-context enforcement (requireTenantContext)", () => {
    it("rejects a token with no tenant context (403)", async () => {
      const token = jwt.sign({
        sub: randomUUID(),
        tenantId: null,
        legalEntityId: legalEntityA1Id,
        tier: "TENANT_INTERNAL",
        roles: ["finance.viewer"],
        modules: ["sphere-finance"],
      });
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("rejects a token with no legal-entity context (403)", async () => {
      const token = jwt.sign({
        sub: randomUUID(),
        tenantId: tenantAId,
        legalEntityId: null,
        tier: "TENANT_INTERNAL",
        roles: ["finance.viewer"],
        modules: ["sphere-finance"],
      });
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("rejects a token with neither tenant nor legal-entity context (403), with the tenant-context failure winning", async () => {
      const token = jwt.sign({
        sub: randomUUID(),
        tenantId: null,
        legalEntityId: null,
        tier: "TENANT_INTERNAL",
        roles: ["finance.viewer"],
        modules: ["sphere-finance"],
      });
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
      // Proves evaluation order, not just the status code: the tenant
      // message is thrown, not the legal-entity one, matching
      // requireTenantContext()'s tenant-first check (and the four prior
      // duplicated implementations it replaced, which always evaluated
      // requireTenantId() before requireLegalEntityId()).
      expect(res.body.error.message).toBe(
        "This token has no tenant context; Chart of Accounts requires a tenant-scoped token.",
      );
    });

    it("allows a request through when both tenant and legal-entity context are present (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });
  });

  describe("cross-tenant isolation — the negative-case proof", () => {
    let accountAId: string;
    let accountBId: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const resA = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-A-${suffix}`,
          name: "Tenant A Account",
          type: "ASSET",
        })
        .expect(201);
      accountAId = resA.body.data.id;

      const resB = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-B-${suffix}`,
          name: "Tenant B Account",
          type: "ASSET",
        })
        .expect(201);
      accountBId = resB.body.data.id;
    });

    it("tenant A lists: sees its own account, does NOT see tenant B's", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(accountAId);
      expect(ids).not.toContain(accountBId);
    });

    it("tenant B lists: sees its own account, does NOT see tenant A's", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(accountBId);
      expect(ids).not.toContain(accountAId);
    });

    it("tenant A cannot directly read tenant B's account by id (404 — the row is invisible, not just forbidden)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant B cannot directly read tenant A's account by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountAId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot write (archive) tenant B's account — RLS blocks it at the data layer, not just RBAC", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountBId}/archive`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      // Prove the archive attempt genuinely had no effect — tenant B still
      // sees its own account as active.
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it("tenant B CAN archive its own account", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountBId}/archive`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.admin"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(false);
    });
  });

  describe("cross-legal-entity isolation within the same tenant — the 2a retrofit's negative-case proof", () => {
    let accountA1Id: string;
    let accountA2Id: string;

    beforeAll(async () => {
      const suffix = Date.now();
      // Same account code on purpose — the whole point of the 2a
      // uniqueness change is that this succeeds under two different
      // legal entities of the SAME tenant.
      const resA1 = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `SHARED-${suffix}`,
          name: "Entity 1 Account",
          type: "ASSET",
        })
        .expect(201);
      accountA1Id = resA1.body.data.id;

      const resA2 = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({
          code: `SHARED-${suffix}`,
          name: "Entity 2 Account",
          type: "ASSET",
        })
        .expect(201);
      accountA2Id = resA2.body.data.id;
    });

    it("the same account code succeeds under two legal entities of the same tenant", () => {
      expect(accountA1Id).not.toBe(accountA2Id);
    });

    it("entity 1 lists: sees its own account, does NOT see entity 2's — same tenant, same RLS session var", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(accountA1Id);
      expect(ids).not.toContain(accountA2Id);
    });

    it("entity 2 lists: sees its own account, does NOT see entity 1's", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(accountA2Id);
      expect(ids).not.toContain(accountA1Id);
    });

    it("entity 1 cannot directly read entity 2's account by id (404), even within the same tenant", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("entity 1 cannot archive entity 2's account, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountA2Id}/archive`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it("a child account's parentId must belong to the same legal entity — cross-entity parent is rejected (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({
          code: `CHILD-${Date.now()}`,
          name: "Should be rejected",
          type: "ASSET",
          parentId: accountA1Id, // belongs to entity 1, caller is entity 2
        })
        .expect(400);
    });
  });

  describe("audit trail — written per-action and genuinely append-only", () => {
    it("records a CREATE entry scoped to the acting tenant and legal entity, and Postgres itself rejects tampering with it", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const code = `AUDIT-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Audited account", type: "EXPENSE" })
        .expect(201);
      const accountId = res.body.data.id;

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, accountId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("CREATE");
      expect(rows[0]!.entityType).toBe("chart_of_accounts");
      expect(rows[0]!.tenantId).toBe(tenantAId);
      expect(rows[0]!.legalEntityId).toBe(legalEntityA1Id);

      // Immutability: the same append-only trigger proven in Phase 0
      // (packages/db-core/drizzle/rls/002_immutable_audit_log.sql) must
      // reject a direct UPDATE/DELETE against a row Finance wrote — proving
      // the mechanism protects every module's writes, not just Identity's.
      await expect(
        db.execute(
          sql`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = ${rows[0]!.id}`,
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        db.execute(sql`DELETE FROM audit_logs WHERE id = ${rows[0]!.id}`),
      ).rejects.toThrow(/append-only/);
    });

    it("records an ARCHIVE entry with before/after state", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const code = `AUDIT-ARCHIVE-${Date.now()}`;
      const created = await request(app.getHttpServer())
        .post("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "To be archived", type: "LIABILITY" })
        .expect(201);
      const accountId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountId}/archive`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, accountId));

      const archiveRow = rows.find((r) => r.action === "ARCHIVE");
      expect(archiveRow).toBeDefined();
      expect((archiveRow!.beforeState as { isActive: boolean }).isActive).toBe(
        true,
      );
      expect((archiveRow!.afterState as { isActive: boolean }).isActive).toBe(
        false,
      );
    });
  });
});
