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
  and,
  eq,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import { chartOfAccounts, supplierBills } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1c — docs/finance-work-item-1c-supplier-payments-proposal.md §8/§9.
 * Concurrent posting of two payments allocating to the same bill (must
 * serialize cleanly via the fixed-order multi-bill lock — either exactly
 * one wins if only one fits, or both succeed if both fit within the
 * bill's outstanding balance, never over-allocation), no burned
 * payment/journal number from a failed post between two successful
 * ones, and concurrent payment-post vs. period-close — same shape as
 * the existing ap-bill-concurrency.e2e-spec.ts/journal-entries
 * concurrency tests.
 */
describe("AP-1c — payment posting concurrency", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let supplierId: string;
  let suffix: number;

  function tokenFor(roles: string[], userId?: string) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function postBill(
    token: string,
    amountMinor: number,
    billDate: string,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `PAYCONC-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data;
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
        slug: `pay-conc-e2e-${suffix}`,
        name: "Payment Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Payment Concurrency E2E Entity",
        code: "PAYCONC1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [expense] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYCONC-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYCONC-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYCONC-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = expense!.id;
    liabilityAccountId = liability!.id;
    bankAccountId = bank!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountId })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAYCONC-SUP-${suffix}`,
        name: "Concurrency Test Supplier",
      })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAYCONC-OPEN-${suffix}`,
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

  it("two concurrent payments together over-allocating one bill: exactly one 200, one 422, bill never exceeds its total", async () => {
    const token = tokenFor(["finance.poster"]);
    const bill = await postBill(token, 1000, "2026-04-10");

    // Two payments each for 700 against a 1000 bill — together 1400 >
    // 1000, so at most one can succeed.
    async function createPayment(amountMinor: number) {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId,
          paymentDate: "2026-04-11",
          paymentAmountMinor: amountMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountId,
          allocations: [{ billId: bill.id, allocatedAmountMinor: amountMinor }],
        })
        .expect(201);
      return res.body.data.id;
    }
    const [paymentX, paymentY] = await Promise.all([
      createPayment(700),
      createPayment(700),
    ]);

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentX}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentY}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 422]);

    const settledBill = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierBills)
        .where(eq(supplierBills.id, bill.id))
        .then((rows) => rows[0]!),
    );
    expect(settledBill.paidMinor).toBeLessThanOrEqual(settledBill.totalMinor);
    expect(settledBill.paidMinor).toBe(700); // only the winner's allocation applied
  });

  it("two concurrent payments that both fit within a bill's outstanding balance both succeed — true concurrency-safe partial allocation, not just first-writer-wins", async () => {
    const token = tokenFor(["finance.poster"]);
    const bill = await postBill(token, 1000, "2026-04-12");

    async function createPayment(amountMinor: number) {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId,
          paymentDate: "2026-04-13",
          paymentAmountMinor: amountMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountId,
          allocations: [{ billId: bill.id, allocatedAmountMinor: amountMinor }],
        })
        .expect(201);
      return res.body.data.id;
    }
    // 400 + 500 = 900 <= 1000 — both should fit.
    const [paymentX, paymentY] = await Promise.all([
      createPayment(400),
      createPayment(500),
    ]);

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentX}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentY}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const settledBill = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierBills)
        .where(eq(supplierBills.id, bill.id))
        .then((rows) => rows[0]!),
    );
    expect(settledBill.paidMinor).toBe(900);
    expect(settledBill.paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("no burned payment/journal number from a failed post between two successful ones", async () => {
    const token = tokenFor(["finance.poster"]);

    const billOne = await postBill(token, 100, "2026-04-14");
    const first = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2026-04-15",
        paymentAmountMinor: 100,
        paymentMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billOne.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    const firstPosted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${first.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // A payment dated outside any accounting period — its post attempt
    // fails at period resolution, AFTER payment-number/journal-number
    // allocation would occur, proving the failure rolls back the whole
    // transaction including any allocation that would have happened.
    const billFail = await postBill(token, 100, "2026-04-16");
    const failing = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2029-01-01",
        paymentAmountMinor: 100,
        paymentMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billFail.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${failing.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(422);

    const billTwo = await postBill(token, 100, "2026-04-17");
    const second = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2026-04-18",
        paymentAmountMinor: 100,
        paymentMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billTwo.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    const secondPosted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${second.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const firstNum = parseInt(
      firstPosted.body.data.internalReference.split("-")[1],
      10,
    );
    const secondNum = parseInt(
      secondPosted.body.data.internalReference.split("-")[1],
      10,
    );
    expect(secondNum).toBe(firstNum + 1); // the failed post between them burned nothing

    // Exactly one POST audit event for each of the two successful
    // payments — none for the failed one.
    const db = getPlatformDb();
    const postRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "supplier_payment"),
          eq(auditLogs.action, "POST"),
        ),
      );
    const postedIds = new Set(postRows.map((r) => r.entityId));
    expect(postedIds.has(first.body.data.id)).toBe(true);
    expect(postedIds.has(second.body.data.id)).toBe(true);
    expect(postedIds.has(failing.body.data.id)).toBe(false);
  });

  it("concurrent payment-post vs. period-close serialize cleanly via the period row lock — never a race", async () => {
    const adminToken = tokenFor(["finance.admin"]);
    const posterToken = tokenFor(["finance.poster"]);

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAYCONC-RACE-${suffix}`,
        startDate: "2030-01-01",
        endDate: "2030-01-31",
      })
      .expect(201);
    const periodId = period.body.data.id;

    const bill = await postBill(posterToken, 250, "2030-01-15");
    const payment = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate: "2030-01-15",
        paymentAmountMinor: 250,
        paymentMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: bill.id, allocatedAmountMinor: 250 }],
      })
      .expect(201);

    const [postRes, closeRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`),
      request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodId}/close`)
        .set("Authorization", `Bearer ${adminToken}`),
    ]);

    expect([200, 422]).toContain(postRes.status);
    expect(closeRes.status).toBe(200);
    if (postRes.status === 200) {
      expect(postRes.body.data.periodId).toBe(periodId);
    }
  });
});
