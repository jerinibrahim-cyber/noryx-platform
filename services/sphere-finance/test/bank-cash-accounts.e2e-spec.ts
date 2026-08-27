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
 * Banking-1a — Bank/Cash Account Master
 * (docs/finance-work-item-banking-cash-management-proposal.md §8.1, §12,
 * §16, §20, CTO-approved). Same shape as suppliers.e2e-spec.ts/
 * customers.e2e-spec.ts: proves RBAC is enforced server-side, GL-account
 * validation (existence/tenant/entity/active/type), the new
 * gl_account_id uniqueness invariant (including a real concurrency
 * race), tenant isolation, cross-legal-entity isolation, the audit
 * trail, and the locked "reads never re-check the linked GL account's
 * active state" correction. Runs against a real Postgres instance.
 */
describe("Bank/Cash Accounts (e2e) — RBAC, GL validation, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let assetA1Id: string; // active ASSET account, entity A1
  let assetA1SecondId: string; // a second, distinct active ASSET account, entity A1
  let assetA2Id: string; // active ASSET account, entity A2 — cross-entity rejection
  let assetBId: string; // active ASSET account, tenant B — cross-tenant rejection
  let inactiveAssetA1Id: string; // inactive ASSET account, entity A1
  let liabilityA1Id: string;
  let equityA1Id: string;
  let revenueA1Id: string;
  let expenseA1Id: string;

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
      .values({ slug: `bca-e2e-a-${suffix}`, name: "Banking E2E Tenant A" })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: `bca-e2e-b-${suffix}`, name: "Banking E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BCAA1",
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
        code: "BCAA2",
        countryCode: "AE",
        currencyCode: "USD",
        isDefault: false,
      })
      .returning();
    const [entityB] = await db
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "BCAB1",
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
        code: `BANK-A1-${suffix}`,
        name: "Entity 1 Bank",
        type: "ASSET",
      })
      .returning();
    const [assetA1Second] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BANK-A1-2-${suffix}`,
        name: "Entity 1 Second Bank",
        type: "ASSET",
      })
      .returning();
    const [assetA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `BANK-A2-${suffix}`,
        name: "Entity 2 Bank",
        type: "ASSET",
      })
      .returning();
    const [assetB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantBId,
        legalEntityId: legalEntityBId,
        code: `BANK-B-${suffix}`,
        name: "Tenant B Bank",
        type: "ASSET",
      })
      .returning();
    const [inactiveAssetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `INACTIVE-A1-${suffix}`,
        name: "Entity 1 Inactive Bank",
        type: "ASSET",
        isActive: false,
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `LIAB-A1-${suffix}`,
        name: "Entity 1 Liability",
        type: "LIABILITY",
      })
      .returning();
    const [equityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `EQUITY-A1-${suffix}`,
        name: "Entity 1 Equity",
        type: "EQUITY",
      })
      .returning();
    const [revenueA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `REV-A1-${suffix}`,
        name: "Entity 1 Revenue",
        type: "REVENUE",
      })
      .returning();
    const [expenseA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `EXP-A1-${suffix}`,
        name: "Entity 1 Expense",
        type: "EXPENSE",
      })
      .returning();

    assetA1Id = assetA1!.id;
    assetA1SecondId = assetA1Second!.id;
    assetA2Id = assetA2!.id;
    assetBId = assetB!.id;
    inactiveAssetA1Id = inactiveAssetA1!.id;
    liabilityA1Id = liabilityA1!.id;
    equityA1Id = equityA1!.id;
    revenueA1Id = revenueA1!.id;
    expenseA1Id = expenseA1!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC — enforced server-side", () => {
    it("rejects a request with no token at all (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .expect(401);
    });

    it("rejects a token with neither finance role (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("allows finance.viewer to list (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("allows finance.poster to list (200) — posters must be able to select a Bank/Cash Account operationally", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("allows finance.admin to list (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("allows all three roles to read by id (200 each)", async () => {
      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${admin}`)
        .send({
          code: `RBAC-READ-${Date.now()}`,
          name: "RBAC Read Account",
          kind: "BANK",
          glAccountId: assetA1Id,
        })
        .expect(201);
      const id = created.body.data.id;

      for (const role of [
        "finance.viewer",
        "finance.poster",
        "finance.admin",
      ]) {
        await request(app.getHttpServer())
          .get(`/v1/finance/bank-cash-accounts/${id}`)
          .set(
            "Authorization",
            `Bearer ${tokenFor(tenantAId, legalEntityA1Id, [role])}`,
          )
          .expect(200);
      }
    });

    it("rejects finance.viewer attempting to create (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-VIEWER-${Date.now()}`,
          name: "Should be blocked",
          kind: "BANK",
          glAccountId: assetA1Id,
        })
        .expect(403);
    });

    it("rejects finance.poster attempting to create (403) — only finance.admin manages Bank/Cash Account master data", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-POSTER-${Date.now()}`,
          name: "Should be blocked",
          kind: "BANK",
          glAccountId: assetA1Id,
        })
        .expect(403);
    });

    it("allows finance.admin to create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `RBAC-ADMIN-${Date.now()}`,
          name: "Admin created this",
          kind: "BANK",
          glAccountId: assetA1SecondId,
        })
        .expect(201);
      expect(res.body.data.code).toMatch(/^RBAC-ADMIN-/);
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.currencyCode).toBe("AED");
    });
  });

  describe("validation — master data (code)", () => {
    it("rejects a code with disallowed characters (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: "BAD CODE!",
          name: "Should be rejected",
          kind: "BANK",
          glAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("rejects a missing name (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `NO-NAME-${Date.now()}`,
          kind: "BANK",
          glAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("rejects an invalid kind value (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `BAD-KIND-${Date.now()}`,
          name: "Bad kind",
          kind: "SAVINGS",
          glAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("rejects a `code` field on update — code is immutable, not part of UpdateBankCashAccountDto (400, forbidNonWhitelisted)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `IMMUTABLE-GL-${Date.now()}`,
          name: "Immutable code test GL account",
          type: "ASSET",
        })
        .returning();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `IMMUTABLE-${Date.now()}`,
          name: "Immutable code test",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "SHOULD-NOT-BE-ACCEPTED" })
        .expect(400);
    });

    it("rejects a duplicate code within the same legal entity (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const code = `DUP-${Date.now()}`;
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `DUP-GL-${Date.now()}`,
          name: "Duplicate code test GL account",
          type: "ASSET",
        })
        .returning();
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code,
          name: "First",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code,
          name: "Duplicate",
          kind: "CASH",
          glAccountId: assetA1SecondId,
        })
        .expect(409);
    });

    it("allows the same code under two different legal entities of the same tenant (201 both)", async () => {
      const code = `SHARED-CODE-${Date.now()}`;
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [assetE1] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `SHARED-GL-A1-${Date.now()}`,
          name: "Shared code test — entity 1 GL account",
          type: "ASSET",
        })
        .returning();
      const [assetE2] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA2Id,
          code: `SHARED-GL-A2-${Date.now()}`,
          name: "Shared code test — entity 2 GL account",
          type: "ASSET",
        })
        .returning();
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send({
          code,
          name: "Entity 1 account",
          kind: "CASH",
          glAccountId: assetE1!.id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${tokenA2}`)
        .send({
          code,
          name: "Entity 2 account",
          kind: "CASH",
          glAccountId: assetE2!.id,
        })
        .expect(201);
    });
  });

  describe("validation — GL account (glAccountId)", () => {
    it("rejects a nonexistent glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `NONEXISTENT-GL-${Date.now()}`,
          name: "Bad GL ref",
          kind: "BANK",
          glAccountId: randomUUID(),
        })
        .expect(400);
    });

    it("rejects a glAccountId belonging to a different legal entity (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CROSS-ENTITY-GL-${Date.now()}`,
          name: "Cross entity GL ref",
          kind: "BANK",
          glAccountId: assetA2Id, // belongs to entity A2, caller is A1
        })
        .expect(400);
    });

    it("rejects a glAccountId belonging to a different tenant (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CROSS-TENANT-GL-${Date.now()}`,
          name: "Cross tenant GL ref",
          kind: "BANK",
          glAccountId: assetBId, // belongs to tenant B entirely
        })
        .expect(400);
    });

    it("rejects an inactive glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `INACTIVE-GL-${Date.now()}`,
          name: "Inactive GL ref",
          kind: "BANK",
          glAccountId: inactiveAssetA1Id,
        })
        .expect(400);
    });

    it("rejects a LIABILITY-type glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `LIAB-GL-${Date.now()}`,
          name: "Liability GL ref",
          kind: "BANK",
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("rejects an EQUITY-type glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `EQUITY-GL-${Date.now()}`,
          name: "Equity GL ref",
          kind: "BANK",
          glAccountId: equityA1Id,
        })
        .expect(400);
    });

    it("rejects a REVENUE-type glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `REV-GL-${Date.now()}`,
          name: "Revenue GL ref",
          kind: "BANK",
          glAccountId: revenueA1Id,
        })
        .expect(400);
    });

    it("rejects an EXPENSE-type glAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `EXP-GL-${Date.now()}`,
          name: "Expense GL ref",
          kind: "BANK",
          glAccountId: expenseA1Id,
        })
        .expect(400);
    });

    it("accepts an ACTIVE ASSET-type glAccountId (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `ASSET-ACCEPT-${Date.now()}`,
          name: "Fresh ASSET account",
          type: "ASSET",
        })
        .returning();
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `ASSET-OK-${Date.now()}`,
          name: "Asset accepted",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      expect(res.body.data.glAccountId).toBe(asset!.id);
    });

    it("rejects a glAccountId already claimed by another Bank/Cash Account (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `ASSET-CLAIM-${Date.now()}`,
          name: "Claimed ASSET account",
          type: "ASSET",
        })
        .returning();

      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CLAIM-FIRST-${Date.now()}`,
          name: "First claimant",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CLAIM-SECOND-${Date.now()}`,
          name: "Second claimant",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(409);
    });

    it("rejects updating a Bank/Cash Account's glAccountId to one already claimed by another (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [assetX] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `ASSET-X-${Date.now()}`,
          name: "Asset X",
          type: "ASSET",
        })
        .returning();
      const [assetY] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `ASSET-Y-${Date.now()}`,
          name: "Asset Y",
          type: "ASSET",
        })
        .returning();

      await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `BCA-X-${Date.now()}`,
          name: "Account X",
          kind: "BANK",
          glAccountId: assetX!.id,
        })
        .expect(201);
      const bcaY = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `BCA-Y-${Date.now()}`,
          name: "Account Y",
          kind: "BANK",
          glAccountId: assetY!.id,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bcaY.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ glAccountId: assetX!.id })
        .expect(409);
    });

    it("re-submitting a Bank/Cash Account's own current glAccountId on update never self-conflicts (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `SELF-${Date.now()}`,
          name: "Self reference account",
          type: "ASSET",
        })
        .returning();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `SELF-BCA-${Date.now()}`,
          name: "Self reference",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ glAccountId: asset!.id, name: "Renamed, same GL" })
        .expect(200);
    });

    it("concurrency: two simultaneous creates racing for the same glAccountId — exactly one succeeds, the DB unique constraint closes the race", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `RACE-${Date.now()}`,
          name: "Race account",
          type: "ASSET",
        })
        .returning();
      const suffix = Date.now();

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post("/v1/finance/bank-cash-accounts")
          .set("Authorization", `Bearer ${token}`)
          .send({
            code: `RACE-A-${suffix}`,
            name: "Racer A",
            kind: "BANK",
            glAccountId: asset!.id,
          }),
        request(app.getHttpServer())
          .post("/v1/finance/bank-cash-accounts")
          .set("Authorization", `Bearer ${token}`)
          .send({
            code: `RACE-B-${suffix}`,
            name: "Racer B",
            kind: "BANK",
            glAccountId: asset!.id,
          }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe("read / update / list / deactivate / reactivate", () => {
    let bankCashAccountId: string;

    beforeAll(async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `CRUD-GL-${Date.now()}`,
          name: "CRUD GL account",
          type: "ASSET",
        })
        .returning();
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `CRUD-${Date.now()}`,
          name: "Original Name",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      bankCashAccountId = res.body.data.id;
    });

    it("retrieves the created Bank/Cash Account by id", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.name).toBe("Original Name");
      expect(res.body.data.kind).toBe("BANK");
    });

    it("returns 404 for a nonexistent Bank/Cash Account id", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("updates the Bank/Cash Account's editable fields", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Updated Name", bankName: "Emirates NBD" })
        .expect(200);
      expect(res.body.data.name).toBe("Updated Name");
      expect(res.body.data.bankName).toBe("Emirates NBD");
    });

    it("a partial update leaves unspecified fields unchanged", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ maskedAccountNumber: "****4321" })
        .expect(200);
      expect(res.body.data.maskedAccountNumber).toBe("****4321");
      expect(res.body.data.name).toBe("Updated Name"); // unchanged
      expect(res.body.data.bankName).toBe("Emirates NBD"); // unchanged
    });

    it("lists exclude inactive Bank/Cash Accounts by default, include with includeInactive=true", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/deactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const defaultList = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(
        defaultList.body.data.map((a: { id: string }) => a.id),
      ).not.toContain(bankCashAccountId);

      const fullList = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts?includeInactive=true")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(fullList.body.data.map((a: { id: string }) => a.id)).toContain(
        bankCashAccountId,
      );
    });

    it("reactivate brings the Bank/Cash Account back into the default list", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.data.isActive).toBe(true);

      const defaultList = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(defaultList.body.data.map((a: { id: string }) => a.id)).toContain(
        bankCashAccountId,
      );
    });

    it("deactivate/reactivate are idempotent (repeated calls succeed, no 409)", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/reactivate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
    });

    it("there is no DELETE route for Bank/Cash Accounts (404 — this is master data with no delete lifecycle)", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe("historical-read behavior — a Bank/Cash Account stays readable after its linked GL account is deactivated (locked CTO correction)", () => {
    it("create with an active ASSET GL account, deactivate that GL account, then confirm the Bank/Cash Account remains readable and listable — not reinterpreted as a validation failure on read", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `HIST-GL-${Date.now()}`,
          name: "Historical GL account",
          type: "ASSET",
        })
        .returning();

      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          code: `HIST-BCA-${Date.now()}`,
          name: "Historical Bank Account",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      const bankCashAccountId = created.body.data.id;

      // Deactivate the linked GL account directly (bypassing any Bank/
      // Cash Account write path entirely — this exercises the GL
      // account's own archive lifecycle, unrelated to bank_cash_accounts).
      await financeDb
        .update(chartOfAccounts)
        .set({ isActive: false })
        .where(eq(chartOfAccounts.id, asset!.id));

      // GET by id must still succeed — reads never re-check the linked
      // GL account's active state (locked CTO correction, proposal §12).
      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      expect(res.body.data.id).toBe(bankCashAccountId);
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.glAccountId).toBe(asset!.id);

      // And it must still appear in the default (active-only) list.
      const list = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      expect(list.body.data.map((a: { id: string }) => a.id)).toContain(
        bankCashAccountId,
      );
    });
  });

  describe("cross-tenant isolation", () => {
    let bcaAId: string;
    let bcaBId: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const financeDb = getFinanceDb();
      const [assetA] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `ISO-GL-A-${suffix}`,
          name: "Cross-tenant isolation — tenant A GL account",
          type: "ASSET",
        })
        .returning();
      const [assetB] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `ISO-GL-B-${suffix}`,
          name: "Cross-tenant isolation — tenant B GL account",
          type: "ASSET",
        })
        .returning();

      const resA = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-A-${suffix}`,
          name: "Tenant A Account",
          kind: "BANK",
          glAccountId: assetA!.id,
        })
        .expect(201);
      bcaAId = resA.body.data.id;

      const resB = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.admin"])}`,
        )
        .send({
          code: `ISO-B-${suffix}`,
          name: "Tenant B Account",
          kind: "BANK",
          glAccountId: assetB!.id,
        })
        .expect(201);
      bcaBId = resB.body.data.id;
    });

    it("tenant A lists: sees its own account, not tenant B's — RLS-enforced", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(bcaAId);
      expect(ids).not.toContain(bcaBId);
    });

    it("tenant A cannot directly read tenant B's Bank/Cash Account by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bcaBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot write (deactivate) tenant B's Bank/Cash Account — RLS blocks it, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bcaBId}/deactivate`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bcaBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("cross-legal-entity isolation within the same tenant", () => {
    let bcaA1Id: string;
    let bcaA2Id: string;

    beforeAll(async () => {
      const suffix = Date.now();
      const financeDb = getFinanceDb();
      const [assetE1] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `LE-ISO-GL-A1-${suffix}`,
          name: "Cross-entity isolation — entity 1 GL account",
          type: "ASSET",
        })
        .returning();
      const [assetE2] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA2Id,
          code: `LE-ISO-GL-A2-${suffix}`,
          name: "Cross-entity isolation — entity 2 GL account",
          type: "ASSET",
        })
        .returning();

      const resA1 = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .send({
          code: `LE-ISO-${suffix}`,
          name: "Entity 1 Account",
          kind: "BANK",
          glAccountId: assetE1!.id,
        })
        .expect(201);
      bcaA1Id = resA1.body.data.id;

      const resA2 = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({
          code: `LE-ISO-${suffix}`,
          name: "Entity 2 Account",
          kind: "BANK",
          glAccountId: assetE2!.id,
        })
        .expect(201);
      bcaA2Id = resA2.body.data.id;
    });

    it("entity 1 lists: sees its own account, not entity 2's — same tenant, same RLS session var", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-cash-accounts")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(bcaA1Id);
      expect(ids).not.toContain(bcaA2Id);
    });

    it("entity 1 cannot directly read entity 2's Bank/Cash Account by id (404), even within the same tenant", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bcaA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("entity 1 cannot deactivate entity 2's Bank/Cash Account, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bcaA2Id}/deactivate`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${bcaA2Id}`)
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
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `AUDIT-GL-${Date.now()}`,
          name: "Audit GL account",
          type: "ASSET",
        })
        .returning();
      const code = `AUDIT-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code,
          name: "Audited account",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      const bankCashAccountId = res.body.data.id;

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, bankCashAccountId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("CREATE");
      expect(rows[0]!.entityType).toBe("bank_cash_account");
      expect(rows[0]!.tenantId).toBe(tenantAId);
      expect(rows[0]!.legalEntityId).toBe(legalEntityA1Id);
    });

    it("records an UPDATE entry with before/after state", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `AUDIT-UPD-GL-${Date.now()}`,
          name: "Audit update GL account",
          type: "ASSET",
        })
        .returning();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `AUDIT-UPD-${Date.now()}`,
          name: "Before Name",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      const bankCashAccountId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "After Name" })
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, bankCashAccountId));
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
      const financeDb = getFinanceDb();
      const [asset] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `AUDIT-STATUS-GL-${Date.now()}`,
          name: "Audit status GL account",
          type: "ASSET",
        })
        .returning();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          code: `AUDIT-STATUS-${Date.now()}`,
          name: "Status account",
          kind: "BANK",
          glAccountId: asset!.id,
        })
        .expect(201);
      const bankCashAccountId = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/deactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountId}/reactivate`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, bankCashAccountId));

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
