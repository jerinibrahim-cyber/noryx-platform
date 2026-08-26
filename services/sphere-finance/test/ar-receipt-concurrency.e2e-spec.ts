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
import { chartOfAccounts, customerInvoices } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AR-1c — docs/finance-work-item-1c-customer-receipts-proposal.md
 * §8/§9/§13. Concurrent posting of two receipts allocating to the same
 * invoice (must serialize cleanly via the fixed-order multi-invoice lock
 * — either exactly one wins if only one fits, or both succeed if both
 * fit within the invoice's outstanding balance, never over-allocation),
 * no burned receipt/journal number from a failed post between two
 * successful ones, concurrent receipt-post vs. period-close, and two
 * receipts each touching an overlapping-but-different-order set of two
 * invoices (proving the fixed ascending-id lock order prevents deadlock)
 * — same shape as the existing ap-payment-concurrency.e2e-spec.ts, plus
 * the deadlock-avoidance scenario proposal §13 step 7 specifically calls
 * out for the multi-invoice case.
 */
describe("AR-1c — receipt posting concurrency", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let revenueAccountId: string;
  let arControlAccountId: string;
  let bankAccountId: string;
  let customerId: string;
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

  async function postInvoice(
    token: string,
    amountMinor: number,
    invoiceDate: string,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate,
        lines: [
          { accountId: revenueAccountId, amountMinor, taxAmountMinor: 0 },
        ],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
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
        slug: `rcpt-conc-e2e-${suffix}`,
        name: "Receipt Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Receipt Concurrency E2E Entity",
        code: "RCPTCONC1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [revenue] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `RCPTCONC-REV-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arControl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `RCPTCONC-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `RCPTCONC-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    revenueAccountId = revenue!.id;
    arControlAccountId = arControl!.id;
    bankAccountId = bank!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ arControlAccountId })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPTCONC-CUST-${suffix}`,
        name: "Concurrency Test Customer",
      })
      .expect(201);
    customerId = customer.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPTCONC-OPEN-${suffix}`,
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

  it("two concurrent receipts together over-allocating one invoice: exactly one 200, one 422, invoice never exceeds its total", async () => {
    const token = tokenFor(["finance.poster"]);
    const invoice = await postInvoice(token, 1000, "2026-04-10");

    // Two receipts each for 700 against a 1000 invoice — together 1400 >
    // 1000, so at most one can succeed.
    async function createReceipt(amountMinor: number) {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId,
          receiptDate: "2026-04-11",
          receiptAmountMinor: amountMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountId,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: amountMinor },
          ],
        })
        .expect(201);
      return res.body.data.id;
    }
    const [receiptX, receiptY] = await Promise.all([
      createReceipt(700),
      createReceipt(700),
    ]);

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptX}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptY}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 422]);

    const settledInvoice = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(customerInvoices)
        .where(eq(customerInvoices.id, invoice.id))
        .then((rows) => rows[0]!),
    );
    expect(settledInvoice.paidMinor).toBeLessThanOrEqual(
      settledInvoice.totalMinor,
    );
    expect(settledInvoice.paidMinor).toBe(700); // only the winner's allocation applied
  });

  it("two concurrent receipts that both fit within an invoice's outstanding balance both succeed — true concurrency-safe partial allocation, not just first-writer-wins", async () => {
    const token = tokenFor(["finance.poster"]);
    const invoice = await postInvoice(token, 1000, "2026-04-12");

    async function createReceipt(amountMinor: number) {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId,
          receiptDate: "2026-04-13",
          receiptAmountMinor: amountMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountId,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: amountMinor },
          ],
        })
        .expect(201);
      return res.body.data.id;
    }
    // 400 + 500 = 900 <= 1000 — both should fit.
    const [receiptX, receiptY] = await Promise.all([
      createReceipt(400),
      createReceipt(500),
    ]);

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptX}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptY}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const settledInvoice = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(customerInvoices)
        .where(eq(customerInvoices.id, invoice.id))
        .then((rows) => rows[0]!),
    );
    expect(settledInvoice.paidMinor).toBe(900);
    expect(settledInvoice.paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("two concurrent receipts each allocating to a two-invoice set in opposite order never deadlock — the fixed ascending-id lock order serializes them cleanly", async () => {
    const token = tokenFor(["finance.poster"]);
    const invoiceOne = await postInvoice(token, 1000, "2026-04-14");
    const invoiceTwo = await postInvoice(token, 1000, "2026-04-14");
    // Sort by id so we know which is "first" in ascending-id lock order,
    // independent of creation order.
    const [firstById, secondById] = [invoiceOne, invoiceTwo].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

    async function createReceipt(
      allocations: { invoiceId: string; allocatedAmountMinor: number }[],
    ) {
      const totalMinor = allocations.reduce(
        (sum, a) => sum + a.allocatedAmountMinor,
        0,
      );
      const res = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId,
          receiptDate: "2026-04-15",
          receiptAmountMinor: totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountId,
          allocations,
        })
        .expect(201);
      return res.body.data.id;
    }

    // Receipt X's DTO lists invoices in one order; Receipt Y's DTO lists
    // them in the reverse order. Each receipt's own allocations don't
    // overlap the other's on the SAME invoice (300+300 <= 1000 each), so
    // both can legitimately succeed — the point of this test is that
    // they complete at all within the jest timeout, proving no deadlock,
    // not that one wins.
    const receiptX = await createReceipt([
      { invoiceId: firstById.id, allocatedAmountMinor: 300 },
      { invoiceId: secondById.id, allocatedAmountMinor: 300 },
    ]);
    const receiptY = await createReceipt([
      { invoiceId: secondById.id, allocatedAmountMinor: 300 },
      { invoiceId: firstById.id, allocatedAmountMinor: 300 },
    ]);

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptX}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receiptY}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    // Both fit comfortably (300+300 = 600 <= 1000 outstanding on each
    // invoice even after both receipts apply) — both must succeed, and
    // succeeding at all (rather than hanging/erroring on a deadlock)
    // proves the fixed lock order works.
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const [settledOne, settledTwo] = await withTenant(tenantId, (tx) =>
      Promise.all([
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, firstById.id))
          .then((rows) => rows[0]!),
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, secondById.id))
          .then((rows) => rows[0]!),
      ]),
    );
    expect(settledOne.paidMinor).toBe(600);
    expect(settledTwo.paidMinor).toBe(600);
  });

  it("no burned receipt/journal number from a failed post between two successful ones", async () => {
    const token = tokenFor(["finance.poster"]);

    const invoiceOne = await postInvoice(token, 100, "2026-04-16");
    const first = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        receiptDate: "2026-04-17",
        receiptAmountMinor: 100,
        receiptMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ invoiceId: invoiceOne.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    const firstPosted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${first.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // A receipt dated outside any accounting period — its post attempt
    // fails at period resolution, AFTER receipt-number/journal-number
    // allocation would occur, proving the failure rolls back the whole
    // transaction including any allocation that would have happened.
    const invoiceFail = await postInvoice(token, 100, "2026-04-18");
    const failing = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        receiptDate: "2029-01-01",
        receiptAmountMinor: 100,
        receiptMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ invoiceId: invoiceFail.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${failing.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(422);

    const invoiceTwo = await postInvoice(token, 100, "2026-04-19");
    const second = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        receiptDate: "2026-04-20",
        receiptAmountMinor: 100,
        receiptMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ invoiceId: invoiceTwo.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    const secondPosted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${second.body.data.id}/post`)
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
    // receipts — none for the failed one.
    const db = getPlatformDb();
    const postRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "customer_receipt"),
          eq(auditLogs.action, "POST"),
        ),
      );
    const postedIds = new Set(postRows.map((r) => r.entityId));
    expect(postedIds.has(first.body.data.id)).toBe(true);
    expect(postedIds.has(second.body.data.id)).toBe(true);
    expect(postedIds.has(failing.body.data.id)).toBe(false);
  });

  it("concurrent receipt-post vs. period-close serialize cleanly via the period row lock — never a race", async () => {
    const adminToken = tokenFor(["finance.admin"]);
    const posterToken = tokenFor(["finance.poster"]);

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPTCONC-RACE-${suffix}`,
        startDate: "2030-01-01",
        endDate: "2030-01-31",
      })
      .expect(201);
    const periodId = period.body.data.id;

    const invoice = await postInvoice(posterToken, 250, "2030-01-15");
    const receipt = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2030-01-15",
        receiptAmountMinor: 250,
        receiptMethod: "CASH",
        bankCashAccountId: bankAccountId,
        allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 250 }],
      })
      .expect(201);

    const [postRes, closeRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/receipts/${receipt.body.data.id}/post`)
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
