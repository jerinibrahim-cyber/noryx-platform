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
  auditLogs,
  eq,
  sql,
} from "@noryx/db-core";
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * This is the constraint-driven test for Milestone 1b: it must prove tenant
 * A cannot read/write tenant B's Chart of Accounts data, that RBAC is
 * enforced server-side (not just declared in the manifest), and that the
 * audit trail is genuinely append-only at the database level — not merely
 * that CRUD endpoints return 200. Runs against a real Postgres instance,
 * the same non-superuser role/database used for Identity's own e2e/RLS
 * verification (Milestone 1a's checkpoint report explains why the role
 * must be non-superuser for any of this to mean anything).
 */
describe("Accounts (e2e) — RBAC, cross-tenant isolation, audit immutability", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;

  function tokenFor(tenantId: string, roles: string[], userId?: string) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
      tenantId,
      legalEntityId: null,
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
    // the time Finance ever writes data for it.
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
      const token = tokenFor(tenantAId, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("allows finance.viewer to list (200)", async () => {
      const token = tokenFor(tenantAId, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("rejects finance.viewer attempting to create (403) — read role cannot write", async () => {
      const token = tokenFor(tenantAId, ["finance.viewer"]);
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
      const token = tokenFor(tenantAId, ["finance.admin"]);
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
          `Bearer ${tokenFor(tenantAId, ["finance.admin"])}`,
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
          `Bearer ${tokenFor(tenantBId, ["finance.admin"])}`,
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
          `Bearer ${tokenFor(tenantAId, ["finance.viewer"])}`,
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
          `Bearer ${tokenFor(tenantBId, ["finance.viewer"])}`,
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
          `Bearer ${tokenFor(tenantAId, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant B cannot directly read tenant A's account by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountAId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot write (archive) tenant B's account — RLS blocks it at the data layer, not just RBAC", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountBId}/archive`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, ["finance.admin"])}`,
        )
        .expect(404);

      // Prove the archive attempt genuinely had no effect — tenant B still
      // sees its own account as active.
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it("tenant B CAN archive its own account", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${accountBId}/archive`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, ["finance.admin"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(false);
    });
  });

  describe("audit trail — written per-action and genuinely append-only", () => {
    it("records a CREATE entry scoped to the acting tenant, and Postgres itself rejects tampering with it", async () => {
      const token = tokenFor(tenantAId, ["finance.admin"]);
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
      const token = tokenFor(tenantAId, ["finance.admin"]);
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
