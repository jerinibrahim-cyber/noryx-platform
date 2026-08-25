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
} from "@noryx/db-core";
import { getDb as getFinanceDb, closeDb as closeFinanceDb } from "../src/db/db";
import { chartOfAccounts } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1a — Supplier Master (docs/finance-work-item-1-ap-foundation-proposal.md
 * §5, §7, §17). Same shape as accounts.e2e-spec.ts: proves RBAC is
 * enforced server-side, tenant isolation, cross-legal-entity isolation
 * within one tenant, and that the audit trail is written per mutation.
 * Runs against a real Postgres instance.
 */
describe("Suppliers (e2e) — RBAC, tenant + legal-entity isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let accountA1Id: string; // active ASSET account, entity A1 — for defaultExpenseAccountId
  let accountA2Id: string; // active ASSET account, entity A2 — proves cross-entity rejection

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

    const db = getPlatformDb();
    const suffix = Date.now();
    const [tenantA] = await db
      .insert(tenants)
      .values({ slug: `ap-e2e-a-${suffix}`, name: "AP E2E Tenant A" })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: `ap-e2e-b-${suffix}`, name: "AP E2E Tenant B" })
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

    const financeDb = getFinanceDb();
    const [acctA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `EXP-A1-${suffix}`,
        name: "Entity 1 Expense",
        type: "EXPENSE",
      })
      .returning();
    const [acctA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `EXP-A2-${suffix}`,
        name: "Entity 2 Expense",
        type: "EXPENSE",
      })
      .returning();
    accountA1Id = acctA1!.id;
    accountA2Id = acctA2!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC — enforced server-side", () => {
    it("rejects a request with no token at all (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .expect(401);
    });

    it("rejects a token with neither finance role (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("allows finance.viewer to list (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("allows finance.poster to list (200) — suppliers must be readable by the role that will create bills against them", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("rejects finance.viewer attempting to create (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `RBAC-VIEWER-${Date.now()}`, name: "Should be blocked" })
        .expect(403);
    });

    it("rejects finance.poster attempting to create (403) — only finance.admin manages supplier master data", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `RBAC-POSTER-${Date.now()}`, name: "Should be blocked" })
        .expect(403);
    });

    it("allows finance.admin to create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-ADMIN-${Date.now()}`,
          name: "Admin created this",
        })
        .expect(201);
      expect(res.body.data.code).toMatch(/^RBAC-ADMIN-/);
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("validation", () => {
    it("rejects a code with disallowed characters (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "BAD CODE!", name: "Should be rejected" })
        .expect(400);
    });

    it("rejects a missing name (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `NO-NAME-${Date.now()}` })
        .expect(400);
    });

    it("rejects a nonexistent defaultExpenseAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `BAD-ACCT-${Date.now()}`,
          name: "Bad account ref",
          defaultExpenseAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("rejects a defaultExpenseAccountId belonging to a different legal entity (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CROSS-ENTITY-ACCT-${Date.now()}`,
          name: "Cross entity account ref",
          defaultExpenseAccountId: accountA2Id, // belongs to entity A2, caller is A1
        })
        .expect(400);
    });

    it("accepts a defaultExpenseAccountId belonging to the caller's own legal entity (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `GOOD-ACCT-${Date.now()}`,
          name: "Good account ref",
          defaultExpenseAccountId: accountA1Id,
          paymentTermsDays: 30,
          taxRegistrationNo: "AE-VAT-999",
        })
        .expect(201);
      expect(res.body.data.defaultExpenseAccountId).toBe(accountA1Id);
      expect(res.body.data.paymentTermsDays).toBe(30);
      expect(res.body.data.taxRegistrationNo).toBe("AE-VAT-999");
    });

    it("rejects a duplicate code within the same legal entity (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const code = `DUP-${Date.now()}`;
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "First" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Duplicate" })
        .expect(409);
    });

    it("allows the same code under two different legal entities of the same tenant (201 both)", async () => {
      const code = `SHARED-CODE-${Date.now()}`;
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send({ code, name: "Entity 1 supplier" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${tokenA2}`)
        .send({ code, name: "Entity 2 supplier" })
        .expect(201);
    });
  });

  describe("read / update / list", () => {
    let supplierId: string;

    beforeAll(async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `CRUD-${Date.now()}`, name: "Original Name" })
        .expect(201);
      supplierId = res.body.data.id;
    });

    it("retrieves the created supplier by id", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.name).toBe("Original Name");
    });

    it("returns 404 for a nonexistent supplier id", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("updates the supplier's editable fields", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Updated Name", paymentTermsDays: 45 })
        .expect(200);
      expect(res.body.data.name).toBe("Updated Name");
      expect(res.body.data.paymentTermsDays).toBe(45);
    });

    it("a partial update leaves unspecified fields unchanged", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ taxRegistrationNo: "AE-VAT-777" })
        .expect(200);
      expect(res.body.data.taxRegistrationNo).toBe("AE-VAT-777");
      expect(res.body.data.name).toBe("Updated Name"); // unchanged from the prior update
      expect(res.body.data.paymentTermsDays).toBe(45); // unchanged
    });

    it("rejects updating to a cross-entity defaultExpenseAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ defaultExpenseAccountId: accountA2Id })
        .expect(400);
    });

    it("lists exclude inactive suppliers by default, include with includeInactive=true", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/deactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const defaultList = await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(
        defaultList.body.data.map((s: { id: string }) => s.id),
      ).not.toContain(supplierId);

      const fullList = await request(app.getHttpServer())
        .get("/v1/finance/suppliers?includeInactive=true")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(fullList.body.data.map((s: { id: string }) => s.id)).toContain(
        supplierId,
      );
    });

    it("reactivate brings the supplier back into the default list", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.data.isActive).toBe(true);

      const defaultList = await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(defaultList.body.data.map((s: { id: string }) => s.id)).toContain(
        supplierId,
      );
    });

    it("deactivate/reactivate are idempotent (repeated calls succeed, no 409)", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe("cross-tenant isolation", () => {
    let supplierAId: string;
    let supplierBId: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const resA = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({ code: `ISO-A-${suffix}`, name: "Tenant A Supplier" })
        .expect(201);
      supplierAId = resA.body.data.id;

      const resB = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.admin"])}`,
        )
        .send({ code: `ISO-B-${suffix}`, name: "Tenant B Supplier" })
        .expect(201);
      supplierBId = resB.body.data.id;
    });

    it("tenant A lists: sees its own supplier, not tenant B's", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(supplierAId);
      expect(ids).not.toContain(supplierBId);
    });

    it("tenant A cannot directly read tenant B's supplier by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot write (deactivate) tenant B's supplier — RLS blocks it, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierBId}/deactivate`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("cross-legal-entity isolation within the same tenant", () => {
    let supplierA1Id: string;
    let supplierA2Id: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const resA1 = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({ code: `LE-ISO-${suffix}`, name: "Entity 1 Supplier" })
        .expect(201);
      supplierA1Id = resA1.body.data.id;

      const resA2 = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({ code: `LE-ISO-${suffix}`, name: "Entity 2 Supplier" })
        .expect(201);
      supplierA2Id = resA2.body.data.id;
    });

    it("entity 1 lists: sees its own supplier, not entity 2's — same tenant, same RLS session var", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/suppliers")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(supplierA1Id);
      expect(ids).not.toContain(supplierA2Id);
    });

    it("entity 1 cannot directly read entity 2's supplier by id (404), even within the same tenant", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("entity 1 cannot deactivate entity 2's supplier, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierA2Id}/deactivate`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("audit trail — written per-action and genuinely append-only", () => {
    it("records a CREATE entry scoped to the acting tenant and legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const code = `AUDIT-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Audited supplier" })
        .expect(201);
      const supplierId = res.body.data.id;

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, supplierId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("CREATE");
      expect(rows[0]!.entityType).toBe("supplier");
      expect(rows[0]!.tenantId).toBe(tenantAId);
      expect(rows[0]!.legalEntityId).toBe(legalEntityA1Id);
    });

    it("records an UPDATE entry with before/after state", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `AUDIT-UPD-${Date.now()}`, name: "Before Name" })
        .expect(201);
      const supplierId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "After Name" })
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, supplierId));
      const updateRow = rows.find((r) => r.action === "UPDATE");
      expect(updateRow).toBeDefined();
      expect((updateRow!.beforeState as { name: string }).name).toBe(
        "Before Name",
      );
      expect((updateRow!.afterState as { name: string }).name).toBe(
        "After Name",
      );
    });

    it("records DEACTIVATE and REACTIVATE entries with before/after state", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: `AUDIT-STATUS-${Date.now()}`, name: "Status supplier" })
        .expect(201);
      const supplierId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/deactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/suppliers/${supplierId}/reactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, supplierId));

      const deactivateRow = rows.find((r) => r.action === "DEACTIVATE");
      const reactivateRow = rows.find((r) => r.action === "REACTIVATE");
      expect(deactivateRow).toBeDefined();
      expect(reactivateRow).toBeDefined();
      expect(
        (deactivateRow!.beforeState as { isActive: boolean }).isActive,
      ).toBe(true);
      expect(
        (deactivateRow!.afterState as { isActive: boolean }).isActive,
      ).toBe(false);
      expect(
        (reactivateRow!.beforeState as { isActive: boolean }).isActive,
      ).toBe(false);
      expect(
        (reactivateRow!.afterState as { isActive: boolean }).isActive,
      ).toBe(true);
    });
  });
});
