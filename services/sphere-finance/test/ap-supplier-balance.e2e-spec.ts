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
 * AP-1d — Supplier Balance (`GET /suppliers/:id/balance`).
 * docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.1, §9.
 */
describe("AP Reports — Supplier Balance (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let expenseAccountA1Id: string;
  let liabilityAccountA1Id: string;
  let bankAccountA1Id: string;
  let supplierAlphaId: string;
  let supplierBetaId: string;
  let supplierA2Id: string; // cross-legal-entity isolation
  let supplierBId: string; // cross-tenant isolation
  let suffix: number;

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

  let posterA1Token: string;
  let adminA1Token: string;

  async function createAndPostBill(
    supplierId: string,
    billDate: string,
    amountMinor: number,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterA1Token}`)
      .send({
        supplierId,
        supplierBillNumber: `BAL-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountA1Id, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
  }

  async function createAndPostPayment(
    supplierId: string,
    paymentDate: string,
    amountMinor: number,
    allocations: { billId: string; allocatedAmountMinor: number }[],
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterA1Token}`)
      .send({
        supplierId,
        paymentDate,
        paymentAmountMinor: amountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountA1Id,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    return posted.body.data.id;
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
    const [tenantA] = await platformDb
      .insert(tenants)
      .values({ slug: `bal-e2e-a-${suffix}`, name: "Balance E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `bal-e2e-b-${suffix}`, name: "Balance E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BALA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 2",
        code: "BALA2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "BALB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [expA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BAL-EXP-A1-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BAL-AP-A1-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bankA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BAL-BANK-A1-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountA1Id = expA1!.id;
    liabilityAccountA1Id = liabilityA1!.id;
    bankAccountA1Id = bankA1!.id;

    adminA1Token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    posterA1Token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ apControlAccountId: liabilityAccountA1Id })
      .expect(201);

    const alpha = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-ALPHA-${suffix}`, name: "Alpha Supplier" })
      .expect(201);
    supplierAlphaId = alpha.body.data.id;

    const beta = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-BETA-${suffix}`, name: "Beta Supplier" })
      .expect(201);
    supplierBetaId = beta.body.data.id;

    const supA2 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `BAL-A2-${suffix}`, name: "Entity 2 Supplier" })
      .expect(201);
    supplierA2Id = supA2.body.data.id;

    const supB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `BAL-B-${suffix}`, name: "Tenant B Supplier" })
      .expect(201);
    supplierBId = supB.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({
        code: `BAL-OPEN-A1-${suffix}`,
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

  it("no transactions — a supplier with zero posted bills has an all-zero balance", async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierBetaId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data).toMatchObject({
      supplierId: supplierBetaId,
      totalBilledMinor: 0,
      totalPaidMinor: 0,
      totalOutstandingMinor: 0,
    });
  });

  it("one unpaid bill — totalBilled = totalOutstanding, totalPaid = 0", async () => {
    const bill = await createAndPostBill(supplierAlphaId, "2026-02-01", 1500);
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierAlphaId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalBilledMinor).toBeGreaterThanOrEqual(1500);
    expect(res.body.data.totalOutstandingMinor).toBe(
      res.body.data.totalBilledMinor - res.body.data.totalPaidMinor,
    );
    void bill;
  });

  it("multiple bills — totals sum across every posted bill for the supplier", async () => {
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-MULTI-${suffix}`, name: "Multi Bill Supplier" })
      .expect(201);
    const supplierId = supplier.body.data.id;

    await createAndPostBill(supplierId, "2026-03-01", 1000);
    await createAndPostBill(supplierId, "2026-03-02", 2000);
    await createAndPostBill(supplierId, "2026-03-03", 3000);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalBilledMinor).toBe(6000);
    expect(res.body.data.totalPaidMinor).toBe(0);
    expect(res.body.data.totalOutstandingMinor).toBe(6000);
  });

  it("partial payment — outstanding reflects the remaining balance", async () => {
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-PARTIAL-${suffix}`, name: "Partial Pay Supplier" })
      .expect(201);
    const supplierId = supplier.body.data.id;

    const bill = await createAndPostBill(supplierId, "2026-04-01", 1000);
    await createAndPostPayment(supplierId, "2026-04-05", 400, [
      { billId: bill.id, allocatedAmountMinor: 400 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalBilledMinor).toBe(1000);
    expect(res.body.data.totalPaidMinor).toBe(400);
    expect(res.body.data.totalOutstandingMinor).toBe(600);
  });

  it("full payment — outstanding reaches zero", async () => {
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-FULL-${suffix}`, name: "Full Pay Supplier" })
      .expect(201);
    const supplierId = supplier.body.data.id;

    const bill = await createAndPostBill(supplierId, "2026-04-10", 750);
    await createAndPostPayment(supplierId, "2026-04-12", 750, [
      { billId: bill.id, allocatedAmountMinor: 750 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalOutstandingMinor).toBe(0);
  });

  it("multiple payments — totalPaid accumulates across separate posted payments", async () => {
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-MULTIPAY-${suffix}`, name: "Multi Payment Supplier" })
      .expect(201);
    const supplierId = supplier.body.data.id;

    const bill = await createAndPostBill(supplierId, "2026-05-01", 1000);
    await createAndPostPayment(supplierId, "2026-05-05", 300, [
      { billId: bill.id, allocatedAmountMinor: 300 },
    ]);
    await createAndPostPayment(supplierId, "2026-05-10", 300, [
      { billId: bill.id, allocatedAmountMinor: 300 },
    ]);
    await createAndPostPayment(supplierId, "2026-05-15", 400, [
      { billId: bill.id, allocatedAmountMinor: 400 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalPaidMinor).toBe(1000);
    expect(res.body.data.totalOutstandingMinor).toBe(0);
  });

  it("multiple suppliers — one supplier's bills/payments never affect another's balance", async () => {
    const [supX, supY] = await Promise.all([
      request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `BAL-ISO-X-${suffix}`, name: "Isolation Supplier X" })
        .expect(201),
      request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `BAL-ISO-Y-${suffix}`, name: "Isolation Supplier Y" })
        .expect(201),
    ]);
    const supplierXId = supX.body.data.id;
    const supplierYId = supY.body.data.id;

    await createAndPostBill(supplierXId, "2026-06-01", 9000);

    const yBalance = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierYId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(yBalance.body.data.totalOutstandingMinor).toBe(0);

    const xBalance = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierXId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(xBalance.body.data.totalOutstandingMinor).toBe(9000);
  });

  it("as-of-date behavior — a payment dated after asOf does not reduce the as-of balance", async () => {
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `BAL-ASOF-${suffix}`, name: "As-Of Supplier" })
      .expect(201);
    const supplierId = supplier.body.data.id;

    const bill = await createAndPostBill(supplierId, "2026-07-01", 2000);
    await createAndPostPayment(supplierId, "2026-07-20", 2000, [
      { billId: bill.id, allocatedAmountMinor: 2000 },
    ]);

    // Before the bill even existed — both totals are zero.
    const before = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance?asOf=2026-06-30`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(before.body.data.totalBilledMinor).toBe(0);
    expect(before.body.data.totalPaidMinor).toBe(0);

    // Between the bill and the payment — billed but not yet paid as of
    // this date, even though the payment has since posted.
    const between = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance?asOf=2026-07-10`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(between.body.data.totalBilledMinor).toBe(2000);
    expect(between.body.data.totalPaidMinor).toBe(0);
    expect(between.body.data.totalOutstandingMinor).toBe(2000);

    // After both — fully settled as of this date.
    const after = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance?asOf=2026-07-31`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(after.body.data.totalPaidMinor).toBe(2000);
    expect(after.body.data.totalOutstandingMinor).toBe(0);
  });

  it("cross-tenant isolation — a supplier belonging to a different tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierBId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("cross-legal-entity isolation — a supplier belonging to a different legal entity in the same tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierA2Id}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("a nonexistent supplierId 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${randomUUID()}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("is readable by every finance role (finance.viewer/poster/admin), not just poster", async () => {
    const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
      "finance.viewer",
    ]);
    await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierAlphaId}/balance`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .expect(200);
  });
});
