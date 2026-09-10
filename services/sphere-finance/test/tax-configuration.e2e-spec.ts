import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import postgres from "postgres";
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
 * Tax / VAT MVP — Phase 1: Tax Configuration Foundation (CTO-approved
 * architecture proposal §3/§7/§9/§11, CTO decision turn, Phase 1
 * implementation authorization). Same shape as
 * suppliers.e2e-spec.ts/accounting-periods.e2e-spec.ts: proves RBAC is
 * enforced server-side, tenant isolation, uniqueness (tax codes),
 * overlap rejection (tax rates, both the friendly 409 and the real
 * EXCLUDE USING gist constraint underneath it), and that the audit
 * trail is written per mutation. Runs against a real Postgres instance.
 *
 * Phase 1 only — no calculation, no AP/AR wiring, no credit/debit note
 * inheritance, no VAT report exist yet, so none of that is tested here.
 */
describe("Tax Configuration (e2e) — RBAC, tenant isolation, uniqueness, overlap, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityAId: string;
  let legalEntityBId: string;

  function tokenFor(tenantId: string, legalEntityId: string, roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
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
      .values({ slug: `tax-e2e-a-${suffix}`, name: "Tax E2E Tenant A" })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: `tax-e2e-b-${suffix}`, name: "Tax E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "TAX-A1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "TAX-B1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityAId = entityA!.id;
    legalEntityBId = entityB!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("Tax Codes — RBAC", () => {
    it("rejects a request with no token at all (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/tax-codes")
        .expect(401);
    });

    it("rejects a token with neither finance role (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("allows finance.viewer and finance.poster to list (200)", async () => {
      for (const role of ["finance.viewer", "finance.poster"]) {
        const token = tokenFor(tenantAId, legalEntityAId, [role]);
        await request(app.getHttpServer())
          .get("/v1/finance/tax-codes")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      }
    });

    it("rejects finance.viewer/finance.poster attempting to create (403) — only finance.admin manages tax configuration", async () => {
      for (const role of ["finance.viewer", "finance.poster"]) {
        const token = tokenFor(tenantAId, legalEntityAId, [role]);
        await request(app.getHttpServer())
          .post("/v1/finance/tax-codes")
          .set("Authorization", `Bearer ${token}`)
          .send({
            code: `RBAC-${role}-${Date.now()}`,
            name: "Should be blocked",
            treatment: "STANDARD",
          })
          .expect(403);
      }
    });

    it("allows finance.admin to create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-ADMIN-${Date.now()}`,
          name: "Admin created this",
          treatment: "STANDARD",
        })
        .expect(201);
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.treatment).toBe("STANDARD");
    });
  });

  describe("Tax Codes — validation and uniqueness", () => {
    it("rejects a code with disallowed characters (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "BAD CODE!", name: "Bad", treatment: "STANDARD" })
        .expect(400);
    });

    it("rejects an invalid treatment (400) — no reverse charge in MVP", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `BAD-TREAT-${Date.now()}`,
          name: "Bad",
          treatment: "REVERSE_CHARGE",
        })
        .expect(400);
    });

    it("rejects a duplicate code within the same legal entity (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const code = `DUP-${Date.now()}`;
      await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "First", treatment: "STANDARD" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Duplicate", treatment: "STANDARD" })
        .expect(409);
    });
  });

  describe("Tax Codes — read / deactivate / reactivate", () => {
    let taxCodeId: string;

    beforeAll(async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CRUD-${Date.now()}`,
          name: "Standard VAT",
          treatment: "STANDARD",
        })
        .expect(201);
      taxCodeId = res.body.data.id;
    });

    it("retrieves the created tax code by id", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.viewer"]);
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/tax-codes/${taxCodeId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.name).toBe("Standard VAT");
    });

    it("returns 404 for a nonexistent tax code id", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/tax-codes/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("lists exclude inactive tax codes by default, include with includeInactive=true", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${taxCodeId}/deactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const defaultList = await request(app.getHttpServer())
        .get("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(
        defaultList.body.data.map((c: { id: string }) => c.id),
      ).not.toContain(taxCodeId);

      const fullList = await request(app.getHttpServer())
        .get("/v1/finance/tax-codes?includeInactive=true")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(fullList.body.data.map((c: { id: string }) => c.id)).toContain(
        taxCodeId,
      );
    });

    it("reactivate brings the tax code back into the default list", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${taxCodeId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("Tax Rates — create/list, RBAC, validation", () => {
    let taxCodeId: string;

    beforeAll(async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RATE-BASE-${Date.now()}`,
          name: "Rate Base Code",
          treatment: "STANDARD",
        })
        .expect(201);
      taxCodeId = res.body.data.id;
    });

    it("rejects finance.poster attempting to create a rate (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 500, effectiveFrom: "2026-01-01" })
        .expect(403);
    });

    it("allows finance.admin to create a rate (201) and finance.viewer to list it (200)", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ rateBasisPoints: 500, effectiveFrom: "2026-01-01" })
        .expect(201);
      expect(created.body.data.rateBasisPoints).toBe(500);
      expect(created.body.data.effectiveTo).toBeNull();

      const viewerToken = tokenFor(tenantAId, legalEntityAId, [
        "finance.viewer",
      ]);
      const list = await request(app.getHttpServer())
        .get(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(
        created.body.data.id,
      );
    });

    it("rejects a rateBasisPoints above the sanity bound (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 10001, effectiveFrom: "2026-01-01" })
        .expect(400);
    });

    it("rejects a taxCodeId that does not exist in this legal entity (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${randomUUID()}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 500, effectiveFrom: "2026-01-01" })
        .expect(400);
    });
  });

  describe("Tax Rates — overlap rejection (409)", () => {
    let taxCodeId: string;

    beforeAll(async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `OVERLAP-${Date.now()}`,
          name: "Overlap Test Code",
          treatment: "STANDARD",
        })
        .expect(201);
      taxCodeId = res.body.data.id;
    });

    it("rejects a rate whose range overlaps an existing bounded rate", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          rateBasisPoints: 500,
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-06-30",
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          rateBasisPoints: 700,
          effectiveFrom: "2026-04-01",
          effectiveTo: "2026-12-31",
        })
        .expect(409);
    });

    it("accepts a rate immediately adjacent to (not overlapping) an existing one — '[)' half-open range", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          rateBasisPoints: 800,
          effectiveFrom: "2027-01-01",
          effectiveTo: "2027-06-30",
        })
        .expect(201);

      // Starts exactly the day after the prior rate's effectiveTo — not
      // an overlap under the '[)' exclusion semantics.
      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 900, effectiveFrom: "2027-07-01" })
        .expect(201);
    });

    it("rejects a second open-ended rate once an open-ended rate already exists", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const code = `OVERLAP-OPEN-${Date.now()}`;
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Open-ended overlap", treatment: "STANDARD" })
        .expect(201);
      const openTaxCodeId = created.body.data.id;

      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${openTaxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 500, effectiveFrom: "2028-01-01" })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${openTaxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 600, effectiveFrom: "2028-06-01" })
        .expect(409);
    });

    it("two concurrent creates for the same overlapping window: exactly one 201, one 409 — proves the EXCLUDE constraint, not just the pre-check, closes the race", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const code = `OVERLAP-RACE-${Date.now()}`;
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Race Test Code", treatment: "STANDARD" })
        .expect(201);
      const raceTaxCodeId = created.body.data.id;

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/tax-codes/${raceTaxCodeId}/rates`)
          .set("Authorization", `Bearer ${token}`)
          .send({
            rateBasisPoints: 500,
            effectiveFrom: "2029-01-01",
            effectiveTo: "2029-12-31",
          }),
        request(app.getHttpServer())
          .post(`/v1/finance/tax-codes/${raceTaxCodeId}/rates`)
          .set("Authorization", `Bearer ${token}`)
          .send({
            rateBasisPoints: 600,
            effectiveFrom: "2029-01-01",
            effectiveTo: "2029-12-31",
          }),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe("Tax Rates — DB-level EXCLUDE constraint proof (bypassing the service layer entirely)", () => {
    it("Postgres itself rejects two overlapping tax_rates rows inserted via raw SQL — proves the constraint is actually live, not merely present in a .sql file", async () => {
      const ownerUrl = process.env.DATABASE_URL!;
      const client = postgres(ownerUrl, { max: 1 });
      try {
        const tenantId = randomUUID();
        const legalEntityId = randomUUID();
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const [taxCode] = await client`
          INSERT INTO tax_codes (tenant_id, legal_entity_id, code, name, treatment)
          VALUES (${tenantId}, ${legalEntityId}, ${`DB-EXCL-${suffix}`}, ${"DB Exclusion Test"}, ${"STANDARD"})
          RETURNING id
        `;
        const taxCodeId = taxCode!.id;

        await client`
          INSERT INTO tax_rates (tenant_id, legal_entity_id, tax_code_id, rate_basis_points, effective_from, effective_to)
          VALUES (${tenantId}, ${legalEntityId}, ${taxCodeId}, 500, '2030-01-01', '2030-06-30')
        `;

        await expect(
          client`
            INSERT INTO tax_rates (tenant_id, legal_entity_id, tax_code_id, rate_basis_points, effective_from, effective_to)
            VALUES (${tenantId}, ${legalEntityId}, ${taxCodeId}, 700, '2030-03-01', '2030-09-30')
          `,
        ).rejects.toThrow();

        await client`DELETE FROM tax_rates WHERE tax_code_id = ${taxCodeId}`;
        await client`DELETE FROM tax_codes WHERE id = ${taxCodeId}`;
      } finally {
        await client.end();
      }
    });
  });

  describe("cross-tenant isolation", () => {
    it("tenant A cannot directly read tenant B's tax code by id (404)", async () => {
      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${tokenB}`)
        .send({
          code: `ISO-B-${Date.now()}`,
          name: "Tenant B Tax Code",
          treatment: "STANDARD",
        })
        .expect(201);
      const taxCodeBId = created.body.data.id;

      await request(app.getHttpServer())
        .get(`/v1/finance/tax-codes/${taxCodeBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityAId, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot create a rate against tenant B's tax code (400 — not found in scope)", async () => {
      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${tokenB}`)
        .send({
          code: `ISO-RATE-B-${Date.now()}`,
          name: "Tenant B Tax Code",
          treatment: "STANDARD",
        })
        .expect(201);
      const taxCodeBId = created.body.data.id;

      await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeBId}/rates`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityAId, ["finance.admin"])}`,
        )
        .send({ rateBasisPoints: 500, effectiveFrom: "2026-01-01" })
        .expect(400);
    });

    it("a raw, predicate-free SELECT scoped to tenant A returns only tenant A's tax codes — direct RLS proof, same shape as rls-hardening.e2e-spec.ts", async () => {
      const appRoleUrl = process.env.APP_ROLE_DATABASE_URL!;
      const ownerUrl = process.env.DATABASE_URL!;
      const owner = postgres(ownerUrl, { max: 1 });
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const [codeA] = await owner`
          INSERT INTO tax_codes (tenant_id, legal_entity_id, code, name, treatment)
          VALUES (${tenantAId}, ${legalEntityAId}, ${`RLS-A-${suffix}`}, ${"RLS A"}, ${"STANDARD"})
          RETURNING id
        `;
        const [codeB] = await owner`
          INSERT INTO tax_codes (tenant_id, legal_entity_id, code, name, treatment)
          VALUES (${tenantBId}, ${legalEntityBId}, ${`RLS-B-${suffix}`}, ${"RLS B"}, ${"STANDARD"})
          RETURNING id
        `;

        const client = postgres(appRoleUrl, { max: 1 });
        try {
          const rows = await client.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
            return tx`SELECT id, tenant_id FROM tax_codes`;
          });
          const ids = rows.map((r) => r.id);
          expect(ids).toContain(codeA!.id);
          expect(ids).not.toContain(codeB!.id);
          expect(rows.every((r) => r.tenant_id === tenantAId)).toBe(true);
        } finally {
          await client.end();
        }
      } finally {
        await owner.end();
      }
    });
  });

  describe("audit trail — written per-action", () => {
    it("records a CREATE entry for a tax code, scoped to the acting tenant and legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const code = `AUDIT-CODE-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({ code, name: "Audited tax code", treatment: "STANDARD" })
        .expect(201);
      const taxCodeId = res.body.data.id;

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, taxCodeId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("CREATE");
      expect(rows[0]!.entityType).toBe("tax_code");
      expect(rows[0]!.tenantId).toBe(tenantAId);
      expect(rows[0]!.legalEntityId).toBe(legalEntityAId);
    });

    it("records DEACTIVATE and REACTIVATE entries with before/after state", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `AUDIT-STATUS-${Date.now()}`,
          name: "Status tax code",
          treatment: "STANDARD",
        })
        .expect(201);
      const taxCodeId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${taxCodeId}/deactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${taxCodeId}/reactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, taxCodeId));

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
    });

    it("records a CREATE entry for a tax rate", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/tax-codes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `AUDIT-RATE-${Date.now()}`,
          name: "Rate audit code",
          treatment: "STANDARD",
        })
        .expect(201);
      const taxCodeId = created.body.data.id;

      const rate = await request(app.getHttpServer())
        .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
        .set("Authorization", `Bearer ${token}`)
        .send({ rateBasisPoints: 500, effectiveFrom: "2026-01-01" })
        .expect(201);
      const taxRateId = rate.body.data.id;

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, taxRateId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("CREATE");
      expect(rows[0]!.entityType).toBe("tax_rate");
    });
  });
});
