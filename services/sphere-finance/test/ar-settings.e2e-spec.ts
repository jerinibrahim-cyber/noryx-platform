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
 * AR-1a — AR Settings
 * (docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §3, §5). Proves the upsert semantics (create-then-update via the same
 * POST), account-reference validation (existence + active +
 * same-legal-entity + ASSET type for the control account, no type
 * constraint for the tax account), tenant/legal-entity isolation, and
 * audit trail. Mirrors ap-settings.e2e-spec.ts exactly (LIABILITY ->
 * ASSET). Runs against a real Postgres instance.
 */
describe("AR Settings (e2e) — upsert, account validation, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let assetAccountA1Id: string;
  let liabilityAccountA1Id: string; // wrong type — for the ASSET rejection test
  let assetAccountA2Id: string; // cross-entity — for the cross-entity rejection test

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
        slug: `ar-settings-e2e-a-${suffix}`,
        name: "AR Settings E2E Tenant A",
      })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({
        slug: `ar-settings-e2e-b-${suffix}`,
        name: "AR Settings E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "ARS1",
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
        code: "ARS2",
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
        code: "ARSB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [assetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `AR-CTRL-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `NOT-ASSET-${suffix}`,
        name: "Some Liability",
        type: "LIABILITY",
      })
      .returning();
    const [assetA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `AR-CTRL-A2-${suffix}`,
        name: "Entity 2 Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    assetAccountA1Id = assetA1!.id;
    liabilityAccountA1Id = liabilityA1!.id;
    assetAccountA2Id = assetA2!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .expect(401);
    });

    it("rejects finance.viewer attempting to configure settings (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: assetAccountA1Id })
        .expect(403);
    });

    it("allows finance.viewer to read (404 — not yet configured for this fresh entity)", async () => {
      const token = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("account validation", () => {
    it("rejects a nonexistent arControlAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: randomUUID() })
        .expect(400);
    });

    it("rejects an arControlAccountId that is not type ASSET (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: liabilityAccountA1Id })
        .expect(400);
    });

    it("rejects an arControlAccountId belonging to a different legal entity (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: assetAccountA2Id })
        .expect(400);
    });

    it("rejects a nonexistent taxOutputAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({
          arControlAccountId: assetAccountA1Id,
          taxOutputAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("accepts a taxOutputAccountId of any active in-scope type (not ASSET-constrained)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({
          arControlAccountId: assetAccountA1Id,
          taxOutputAccountId: liabilityAccountA1Id,
        })
        .expect(201);
      expect(res.body.data.arControlAccountId).toBe(assetAccountA1Id);
      expect(res.body.data.taxOutputAccountId).toBe(liabilityAccountA1Id);
    });
  });

  describe("upsert semantics — POST both creates and updates", () => {
    it("first POST creates the row (audit CREATE)", async () => {
      const token = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      // A distinct legal entity's own ASSET account, created inline
      // to keep this describe block independent of the outer one's state.
      const financeDb = getFinanceDb();
      const [acct] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `AR-CTRL-B-${Date.now()}`,
          name: "Tenant B AR Control",
          type: "ASSET",
        })
        .returning();

      const res = await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: acct!.id })
        .expect(201);
      expect(res.body.data.arControlAccountId).toBe(acct!.id);
      expect(res.body.data.taxOutputAccountId).toBeNull();

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, legalEntityBId));
      const createRow = rows.find(
        (r) => r.entityType === "ar_settings" && r.action === "CREATE",
      );
      expect(createRow).toBeDefined();
      expect(createRow!.beforeState).toBeNull();
    });

    it("a second POST for the same legal entity updates the existing row in place (audit UPDATE), not a second row", async () => {
      // Dedicated, fresh legal entity for this test — legalEntityA1Id is
      // shared with the "account validation" describe block above (which
      // already configures AR settings for it), so reusing it here would
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
          code: `AR-UPSERT-${Date.now()}`,
          countryCode: "AE",
          currencyCode: "AED",
          isDefault: false,
        })
        .returning();
      const freshEntityId = freshEntity!.id;
      const [firstAsset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: freshEntityId,
          code: `AR-CTRL-1-${Date.now()}`,
          name: "First AR Control Candidate",
          type: "ASSET",
        })
        .returning();
      const [secondAsset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: freshEntityId,
          code: `AR-CTRL-2-${Date.now()}`,
          name: "Second AR Control Candidate",
          type: "ASSET",
        })
        .returning();

      const token = tokenFor(tenantAId, freshEntityId, ["finance.admin"]);

      // First POST — a genuine create, this legal entity has never been
      // configured before.
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: firstAsset!.id })
        .expect(201);

      // Second POST — an update in place.
      const res = await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .send({ arControlAccountId: secondAsset!.id })
        .expect(201);
      expect(res.body.data.arControlAccountId).toBe(secondAsset!.id);

      // GET reflects exactly one current configuration, not two rows.
      const getRes = await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.data.arControlAccountId).toBe(secondAsset!.id);

      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, freshEntityId));
      const createRow = rows.find(
        (r) => r.entityType === "ar_settings" && r.action === "CREATE",
      );
      const updateRow = rows.find(
        (r) => r.entityType === "ar_settings" && r.action === "UPDATE",
      );
      expect(createRow).toBeDefined();
      expect(updateRow).toBeDefined();
      expect(
        (updateRow!.beforeState as { arControlAccountId: string })
          .arControlAccountId,
      ).toBe(firstAsset!.id);
      expect(
        (updateRow!.afterState as { arControlAccountId: string })
          .arControlAccountId,
      ).toBe(secondAsset!.id);
    });
  });

  describe("tenant + legal-entity isolation", () => {
    it("tenant A's settings are invisible to tenant B", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ arControlAccountId: assetAccountA1Id })
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenB}`);
      // Either 404 (never configured) or, if a prior test in this file
      // configured tenant B, its OWN control account — never tenant A's.
      if (res.status === 200) {
        expect(res.body.data.arControlAccountId).not.toBe(assetAccountA1Id);
      } else {
        expect(res.status).toBe(404);
      }
    });

    it("entity A1's settings are independent of entity A2's within the same tenant", async () => {
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send({ arControlAccountId: assetAccountA1Id })
        .expect(201);

      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenA2}`)
        .send({ arControlAccountId: assetAccountA2Id })
        .expect(201);

      const resA1 = await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenA1}`)
        .expect(200);
      expect(resA1.body.data.arControlAccountId).toBe(assetAccountA1Id);

      const resA2 = await request(app.getHttpServer())
        .get("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(200);
      expect(resA2.body.data.arControlAccountId).toBe(assetAccountA2Id);
    });
  });
});
