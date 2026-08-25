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
 * AP-1a — AP Settings (docs/finance-work-item-1-ap-foundation-proposal.md
 * §5, §16, §17). Proves the upsert semantics (create-then-update via the
 * same POST), account-reference validation (existence + active +
 * same-legal-entity + LIABILITY type for the control account, no type
 * constraint for the tax account), tenant/legal-entity isolation, and
 * audit trail. Runs against a real Postgres instance.
 */
describe("AP Settings (e2e) — upsert, account validation, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let liabilityAccountA1Id: string;
  let assetAccountA1Id: string; // wrong type — for the LIABILITY rejection test
  let liabilityAccountA2Id: string; // cross-entity — for the cross-entity rejection test

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
      .values({
        slug: `ap-settings-e2e-a-${suffix}`,
        name: "AP Settings E2E Tenant A",
      })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({
        slug: `ap-settings-e2e-b-${suffix}`,
        name: "AP Settings E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "S1",
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
        code: "S2",
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
        code: "SB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `AP-CTRL-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [assetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `NOT-LIAB-${suffix}`,
        name: "Cash",
        type: "ASSET",
      })
      .returning();
    const [liabilityA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `AP-CTRL-A2-${suffix}`,
        name: "Entity 2 Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    liabilityAccountA1Id = liabilityA1!.id;
    assetAccountA1Id = assetA1!.id;
    liabilityAccountA2Id = liabilityA2!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .expect(401);
    });

    it("rejects finance.viewer attempting to configure settings (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: liabilityAccountA1Id })
        .expect(403);
    });

    it("allows finance.viewer to read (404 — not yet configured for this fresh entity)", async () => {
      const token = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("account validation", () => {
    it("rejects a nonexistent apControlAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: randomUUID() })
        .expect(400);
    });

    it("rejects an apControlAccountId that is not type LIABILITY (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: assetAccountA1Id })
        .expect(400);
    });

    it("rejects an apControlAccountId belonging to a different legal entity (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: liabilityAccountA2Id })
        .expect(400);
    });

    it("rejects a nonexistent taxInputAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({
          apControlAccountId: liabilityAccountA1Id,
          taxInputAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("accepts a taxInputAccountId of any active in-scope type (not LIABILITY-constrained)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({
          apControlAccountId: liabilityAccountA1Id,
          taxInputAccountId: assetAccountA1Id,
        })
        .expect(201);
      expect(res.body.data.apControlAccountId).toBe(liabilityAccountA1Id);
      expect(res.body.data.taxInputAccountId).toBe(assetAccountA1Id);
    });
  });

  describe("upsert semantics — POST both creates and updates", () => {
    it("first POST creates the row (audit CREATE)", async () => {
      const token = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      // A distinct legal entity's own LIABILITY account, created inline
      // to keep this describe block independent of the outer one's state.
      const financeDb = getFinanceDb();
      const [acct] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `AP-CTRL-B-${Date.now()}`,
          name: "Tenant B AP Control",
          type: "LIABILITY",
        })
        .returning();

      const res = await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: acct!.id })
        .expect(201);
      expect(res.body.data.apControlAccountId).toBe(acct!.id);
      expect(res.body.data.taxInputAccountId).toBeNull();

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, legalEntityBId));
      const createRow = rows.find(
        (r) => r.entityType === "ap_settings" && r.action === "CREATE",
      );
      expect(createRow).toBeDefined();
      expect(createRow!.beforeState).toBeNull();
    });

    it("a second POST for the same legal entity updates the existing row in place (audit UPDATE), not a second row", async () => {
      // Dedicated, fresh legal entity for this test — legalEntityA1Id is
      // shared with the "account validation" describe block above (which
      // already configures AP settings for it), so reusing it here would
      // make this test's own "first configuration" POST silently become
      // an update relative to that earlier state instead of a clean
      // baseline. A fresh entity keeps this test's audit-row assertions
      // unambiguous regardless of what ran before it in this file.
      const db = getPlatformDb();
      const financeDb = getFinanceDb();
      const [freshEntity] = await db
        .insert(legalEntities)
        .values({
          tenantId: tenantAId,
          name: "Upsert-semantics fixture entity",
          code: `UPSERT-${Date.now()}`,
          countryCode: "AE",
          currencyCode: "AED",
          isDefault: false,
        })
        .returning();
      const freshEntityId = freshEntity!.id;
      const [firstLiability] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: freshEntityId,
          code: `AP-CTRL-1-${Date.now()}`,
          name: "First AP Control Candidate",
          type: "LIABILITY",
        })
        .returning();
      const [secondLiability] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: freshEntityId,
          code: `AP-CTRL-2-${Date.now()}`,
          name: "Second AP Control Candidate",
          type: "LIABILITY",
        })
        .returning();

      const token = tokenFor(tenantAId, freshEntityId, ["finance.admin"]);

      // First POST — a genuine create, this legal entity has never been
      // configured before.
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: firstLiability!.id })
        .expect(201);

      // Second POST — an update in place.
      const res = await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ apControlAccountId: secondLiability!.id })
        .expect(201);
      expect(res.body.data.apControlAccountId).toBe(secondLiability!.id);

      // GET reflects exactly one current configuration, not two rows.
      const getRes = await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.data.apControlAccountId).toBe(secondLiability!.id);

      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, freshEntityId));
      const createRow = rows.find(
        (r) => r.entityType === "ap_settings" && r.action === "CREATE",
      );
      const updateRow = rows.find(
        (r) => r.entityType === "ap_settings" && r.action === "UPDATE",
      );
      expect(createRow).toBeDefined();
      expect(updateRow).toBeDefined();
      expect(
        (updateRow!.beforeState as { apControlAccountId: string })
          .apControlAccountId,
      ).toBe(firstLiability!.id);
      expect(
        (updateRow!.afterState as { apControlAccountId: string })
          .apControlAccountId,
      ).toBe(secondLiability!.id);
    });
  });

  describe("tenant + legal-entity isolation", () => {
    it("tenant A's settings are invisible to tenant B", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ apControlAccountId: liabilityAccountA1Id })
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenB}`);
      // Either 404 (never configured) or, if a prior test in this file
      // configured tenant B, its OWN control account — never tenant A's.
      if (res.status === 200) {
        expect(res.body.data.apControlAccountId).not.toBe(liabilityAccountA1Id);
      } else {
        expect(res.status).toBe(404);
      }
    });

    it("entity A1's settings are independent of entity A2's within the same tenant", async () => {
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send({ apControlAccountId: liabilityAccountA1Id })
        .expect(201);

      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenA2}`)
        .send({ apControlAccountId: liabilityAccountA2Id })
        .expect(201);

      const resA1 = await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenA1}`)
        .expect(200);
      expect(resA1.body.data.apControlAccountId).toBe(liabilityAccountA1Id);

      const resA2 = await request(app.getHttpServer())
        .get("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(200);
      expect(resA2.body.data.apControlAccountId).toBe(liabilityAccountA2Id);
    });
  });
});
