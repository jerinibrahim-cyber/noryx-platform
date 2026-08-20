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
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * 2c-1 — accounting periods: create, list, close. finance.admin only.
 * Covers RBAC, tenant + legal-entity isolation, audit logging, and the
 * period-overlap race correction from the 2c proposal review (§3):
 * a raced EXCLUDE/UNIQUE constraint violation must be mapped to a clean
 * 409, never a raw Postgres error.
 */
describe("Accounting periods (e2e) — 2c-1", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
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

    const db = getPlatformDb();
    const suffix = Date.now();
    const [tenantA] = await db
      .insert(tenants)
      .values({ slug: `period-e2e-a-${suffix}`, name: "Period E2E Tenant A" })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: `period-e2e-b-${suffix}`, name: "Period E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "PA1",
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
        code: "PA2",
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
        code: "PB1",
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

  describe("RBAC — finance.admin only for write, any finance.* role for list", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/accounting-periods")
        .expect(401);
    });

    it("finance.viewer can list (200) but cannot create (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: "RBAC-1",
          startDate: "2026-01-01",
          endDate: "2026-01-31",
        })
        .expect(403);
    });

    it("finance.poster cannot create a period (403) — periods are finance.admin only", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: "RBAC-2",
          startDate: "2026-02-01",
          endDate: "2026-02-28",
        })
        .expect(403);
    });

    it("finance.admin can create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-ADMIN-${Date.now()}`,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        })
        .expect(201);
      expect(res.body.data.status).toBe("OPEN");
    });
  });

  describe("validation", () => {
    it("rejects endDate before startDate (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: "BACKWARDS",
          startDate: "2026-05-01",
          endDate: "2026-04-01",
        })
        .expect(400);
    });
  });

  describe("overlap — friendly pre-check maps to a clean 409", () => {
    it("rejects an overlapping period with 409, no raw Postgres error text", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const suffix = Date.now();
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `OVL-A-${suffix}`,
          startDate: "2026-06-01",
          endDate: "2026-06-30",
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `OVL-B-${suffix}`,
          startDate: "2026-06-15",
          endDate: "2026-07-15",
        })
        .expect(409);
      expect(res.body.error?.message ?? res.body.message).not.toMatch(
        /PostgresError|SQLSTATE|constraint "/i,
      );
    });

    it("allows the same overlapping range for a DIFFERENT legal entity of the same tenant", async () => {
      const suffix = Date.now();
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `MULTI-A-${suffix}`,
          startDate: "2026-07-01",
          endDate: "2026-07-31",
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({
          code: `MULTI-A-${suffix}`,
          startDate: "2026-07-01",
          endDate: "2026-07-31",
        })
        .expect(201);
    });

    it("two concurrent creates with overlapping ranges: exactly one 201, one 409, no raw driver error escapes", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const suffix = Date.now();
      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post("/v1/finance/accounting-periods")
          .set("Authorization", `Bearer ${token}`)
          .send({
            code: `RACE-X-${suffix}`,
            startDate: "2026-09-01",
            endDate: "2026-09-30",
          }),
        request(app.getHttpServer())
          .post("/v1/finance/accounting-periods")
          .set("Authorization", `Bearer ${token}`)
          .send({
            code: `RACE-Y-${suffix}`,
            startDate: "2026-09-10",
            endDate: "2026-10-10",
          }),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = resX.status === 409 ? resX : resY;
      expect(loser.body.error?.message ?? loser.body.message).not.toMatch(
        /PostgresError|SQLSTATE|constraint "/i,
      );
    });
  });

  describe("cross-tenant / cross-legal-entity isolation", () => {
    let periodAId: string;
    let periodBId: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const resA = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-A-${suffix}`,
          startDate: "2026-11-01",
          endDate: "2026-11-30",
        })
        .expect(201);
      periodAId = resA.body.data.id;

      const resB = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-B-${suffix}`,
          startDate: "2026-11-01",
          endDate: "2026-11-30",
        })
        .expect(201);
      periodBId = resB.body.data.id;
    });

    it("tenant A's list does not include tenant B's period", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids).toContain(periodAId);
      expect(ids).not.toContain(periodBId);
    });

    it("tenant A cannot close tenant B's period, and the attempt has no effect (404)", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodBId}/close`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      const periodB = res.body.data.find(
        (p: { id: string }) => p.id === periodBId,
      );
      expect(periodB.status).toBe("OPEN");
    });

    it("a period created for entity 1 is invisible to entity 2 of the same tenant, and cannot be closed by entity 2", async () => {
      const suffix = Date.now();
      const resEntity1 = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `ENT1-${suffix}`,
          startDate: "2026-12-01",
          endDate: "2026-12-31",
        })
        .expect(201);
      const periodEntity1Id = resEntity1.body.data.id;

      const listAsEntity2 = await request(app.getHttpServer())
        .get("/v1/finance/accounting-periods")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(
        listAsEntity2.body.data.map((p: { id: string }) => p.id),
      ).not.toContain(periodEntity1Id);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodEntity1Id}/close`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .expect(404);
    });
  });

  describe("close — one-directional OPEN -> CLOSED", () => {
    it("closes an OPEN period and rejects closing it again", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CLOSE-${suffix}`,
          startDate: "2027-01-01",
          endDate: "2027-01-31",
        })
        .expect(201);
      const id = created.body.data.id;

      const closed = await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${id}/close`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(closed.body.data.status).toBe("CLOSED");
      expect(closed.body.data.closedAt).toBeTruthy();

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${id}/close`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("two concurrent CLOSE requests against the same OPEN period: exactly one success, one 409, one CLOSE audit event — the atomic UPDATE...WHERE status='OPEN' correction", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RACE-CLOSE-${suffix}`,
          startDate: "2027-04-01",
          endDate: "2027-04-30",
        })
        .expect(201);
      const id = created.body.data.id;

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/v1/finance/accounting-periods/${id}/close`)
          .set("Authorization", `Bearer ${token}`),
        request(app.getHttpServer())
          .patch(`/v1/finance/accounting-periods/${id}/close`)
          .set("Authorization", `Bearer ${token}`),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([200, 409]);

      const db = getPlatformDb();
      const closeRows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, id));
      expect(closeRows.filter((r) => r.action === "CLOSE")).toHaveLength(1);
    });

    it("closing a nonexistent period returns 404", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${randomUUID()}/close`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("audit trail", () => {
    it("records CREATE and CLOSE entries", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `AUDIT-${suffix}`,
          startDate: "2027-02-01",
          endDate: "2027-02-28",
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${id}/close`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, id));

      expect(rows.find((r) => r.action === "CREATE")).toBeDefined();
      const closeRow = rows.find((r) => r.action === "CLOSE");
      expect(closeRow).toBeDefined();
      expect(closeRow!.entityType).toBe("accounting_period");
      expect((closeRow!.beforeState as { status: string }).status).toBe("OPEN");
      expect((closeRow!.afterState as { status: string }).status).toBe(
        "CLOSED",
      );
    });
  });
});
