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
} from "@noryx/db-core";
import { closeDb as closeFinanceDb, getDb as getFinanceDb } from "../src/db/db";
import { chartOfAccounts } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1d — AP/GL Reconciliation (`GET /ap/reconciliation`). Proves the
 * invariant named in the AP Foundation proposal's §10/§23:
 * sum(all supplier outstanding balances) = AP control account balance.
 * docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.4, §9. This is the named `ap-gl-reconciliation.e2e-spec.ts` file
 * from that proposal's own §17 test list.
 */
describe("AP Reports — AP/GL Reconciliation (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityAId: string;
  let legalEntityBId: string; // legal-entity isolation
  let expenseAccountAId: string;
  let liabilityAccountAId: string;
  let bankAccountAId: string;
  let expenseAccountBId: string;
  let liabilityAccountBId: string;
  let bankAccountBId: string;
  let posterAToken: string;
  let adminAToken: string;
  let posterBToken: string;
  let adminBToken: string;
  let suffix: number;

  function tokenFor(legalEntityId: string, roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function newSupplier(
    adminToken: string,
    code: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `${code}-${suffix}`, name: code })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPostBill(
    posterToken: string,
    expenseAccountId: string,
    supplierId: string,
    billDate: string,
    amountMinor: number,
  ): Promise<{ id: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `RECON-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return { id: posted.body.data.id };
  }

  async function createAndPostPayment(
    posterToken: string,
    bankAccountId: string,
    supplierId: string,
    paymentDate: string,
    amountMinor: number,
    allocations: { billId: string; allocatedAmountMinor: number }[],
  ): Promise<void> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate,
        paymentAmountMinor: amountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
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

    const platformDb = getPlatformDb();
    suffix = Date.now();
    const [tenant] = await platformDb
      .insert(tenants)
      .values({
        slug: `recon-e2e-${suffix}`,
        name: "Reconciliation E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entityA] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Reconciliation E2E Entity A",
        code: "RECONA",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Reconciliation E2E Entity B",
        code: "RECONB",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    legalEntityAId = entityA!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [expA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `RECON-EXP-A-${suffix}`,
        name: "Office Supplies A",
        type: "EXPENSE",
      })
      .returning();
    const [liabilityA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `RECON-AP-A-${suffix}`,
        name: "Accounts Payable A",
        type: "LIABILITY",
      })
      .returning();
    const [bankA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `RECON-BANK-A-${suffix}`,
        name: "Main Bank A",
        type: "ASSET",
      })
      .returning();
    expenseAccountAId = expA!.id;
    liabilityAccountAId = liabilityA!.id;
    bankAccountAId = bankA!.id;

    const [expB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `RECON-EXP-B-${suffix}`,
        name: "Office Supplies B",
        type: "EXPENSE",
      })
      .returning();
    const [liabilityB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `RECON-AP-B-${suffix}`,
        name: "Accounts Payable B",
        type: "LIABILITY",
      })
      .returning();
    const [bankB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `RECON-BANK-B-${suffix}`,
        name: "Main Bank B",
        type: "ASSET",
      })
      .returning();
    expenseAccountBId = expB!.id;
    liabilityAccountBId = liabilityB!.id;
    bankAccountBId = bankB!.id;

    adminAToken = tokenFor(legalEntityAId, ["finance.admin"]);
    posterAToken = tokenFor(legalEntityAId, ["finance.poster"]);
    adminBToken = tokenFor(legalEntityBId, ["finance.admin"]);
    posterBToken = tokenFor(legalEntityBId, ["finance.poster"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ apControlAccountId: liabilityAccountAId })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ apControlAccountId: liabilityAccountBId })
      .expect(201);

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        code: `RECON-OPEN-A-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        code: `RECON-OPEN-B-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  it("reconciled with no activity — both sides are zero", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/finance/ap/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(res.body.data.subLedgerTotalOutstandingMinor).toBe(0);
    expect(res.body.data.glApControlAccountBalanceMinor).toBe(0);
    expect(res.body.data.differenceMinor).toBe(0);
    expect(res.body.data.reconciled).toBe(true);
  });

  it("sub-ledger total equals the GL AP control account balance across multiple bills, multiple payments, multiple suppliers, and partial settlement", async () => {
    const supplierX = await newSupplier(adminAToken, "ReconX");
    const supplierY = await newSupplier(adminAToken, "ReconY");

    // Supplier X: two bills, one fully paid, one partially paid.
    const billX1 = await createAndPostBill(
      posterAToken,
      expenseAccountAId,
      supplierX,
      "2026-05-01",
      1000,
    );
    const billX2 = await createAndPostBill(
      posterAToken,
      expenseAccountAId,
      supplierX,
      "2026-05-02",
      2000,
    );
    await createAndPostPayment(
      posterAToken,
      bankAccountAId,
      supplierX,
      "2026-05-10",
      1000,
      [{ billId: billX1.id, allocatedAmountMinor: 1000 }],
    );
    await createAndPostPayment(
      posterAToken,
      bankAccountAId,
      supplierX,
      "2026-05-11",
      500,
      [{ billId: billX2.id, allocatedAmountMinor: 500 }],
    );

    // Supplier Y: one untouched bill, entirely outstanding.
    await createAndPostBill(
      posterAToken,
      expenseAccountAId,
      supplierY,
      "2026-05-03",
      750,
    );

    const reconciliation = await request(app.getHttpServer())
      .get("/v1/finance/ap/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);

    expect(reconciliation.body.data.reconciled).toBe(true);
    expect(reconciliation.body.data.differenceMinor).toBe(0);
    expect(reconciliation.body.data.subLedgerTotalOutstandingMinor).toBe(
      reconciliation.body.data.glApControlAccountBalanceMinor,
    );
    // Concretely: billX1 fully paid (0 outstanding), billX2 2000-500=1500
    // outstanding, Y's bill 750 outstanding entirely.
    expect(reconciliation.body.data.subLedgerTotalOutstandingMinor).toBe(
      0 + 1500 + 750,
    );

    // Cross-check against the GL's own account-balance endpoint directly.
    const glBalance = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountAId}/balance`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(reconciliation.body.data.glApControlAccountBalanceMinor).toBe(
      glBalance.body.data.closingBalanceMinor,
    );
  });

  it("legal-entity isolation — entity B's reconciliation is unaffected by entity A's activity, and each reconciles independently", async () => {
    const supplierB = await newSupplier(adminBToken, "ReconEntityB");
    const billB = await createAndPostBill(
      posterBToken,
      expenseAccountBId,
      supplierB,
      "2026-06-01",
      400,
    );
    await createAndPostPayment(
      posterBToken,
      bankAccountBId,
      supplierB,
      "2026-06-05",
      150,
      [{ billId: billB.id, allocatedAmountMinor: 150 }],
    );

    const reconciliationB = await request(app.getHttpServer())
      .get("/v1/finance/ap/reconciliation")
      .set("Authorization", `Bearer ${posterBToken}`)
      .expect(200);
    expect(reconciliationB.body.data.legalEntityId).toBe(legalEntityBId);
    expect(reconciliationB.body.data.subLedgerTotalOutstandingMinor).toBe(250);
    expect(reconciliationB.body.data.reconciled).toBe(true);

    // Entity A's own reconciliation (from the previous test) is untouched
    // by entity B's activity — re-fetch and confirm it still holds.
    const reconciliationA = await request(app.getHttpServer())
      .get("/v1/finance/ap/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(reconciliationA.body.data.legalEntityId).toBe(legalEntityAId);
    expect(reconciliationA.body.data.reconciled).toBe(true);
    expect(reconciliationA.body.data.subLedgerTotalOutstandingMinor).not.toBe(
      reconciliationB.body.data.subLedgerTotalOutstandingMinor,
    );
  });

  it("404s if AP settings have not been configured for the legal entity", async () => {
    const platformDb = getPlatformDb();
    const [entityC] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Reconciliation E2E Entity C (no AP settings)",
        code: "RECONC",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const posterCToken = tokenFor(entityC!.id, ["finance.poster"]);

    await request(app.getHttpServer())
      .get("/v1/finance/ap/reconciliation")
      .set("Authorization", `Bearer ${posterCToken}`)
      .expect(404);
  });
});
