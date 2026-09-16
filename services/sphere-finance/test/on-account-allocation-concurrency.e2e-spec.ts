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
  eq,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import {
  chartOfAccounts,
  supplierBills,
  supplierPayments,
  supplierPaymentAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md §14.2/§14.2a,
 * Table 19.1 scenarios 42-43, CTO Architecture Gate, approved). Proves
 * the concurrency invariant (`SUM(allocatedAmountMinor) <=
 * paymentAmountMinor`) is a genuine DB-backed, lock-order-enforced
 * property — two real HTTP requests issued concurrently against the
 * same fixture row, asserting the database's final state directly, not
 * merely that one returned 200 and one returned 422 (the CTO's explicit
 * requirement, §19.2). AR's concurrency behavior is structurally
 * identical (byte-mirror service code, same lock order) and is not
 * re-proven here — proposal §14.2's own reasoning explicitly treats AP
 * and AR as symmetric for this property.
 */
describe("On-Account — applyAllocation() concurrency invariant (§14.2a)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let supplierId: string;
  let suffix: number;

  function tokenFor(roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
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
        supplierBillNumber: `OAACONC-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string; totalMinor: number };
  }

  async function createAndPostPayment(
    token: string,
    paymentAmountMinor: number,
    paymentDate: string,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate,
        paymentAmountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string };
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
        slug: `oaa-conc-e2e-${suffix}`,
        name: "On-Account Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "On-Account Concurrency E2E Entity",
        code: "OAACONC1",
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
        code: `OAACONC-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAACONC-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAACONC-BANK-${suffix}`,
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
        code: `OAACONC-SUP-${suffix}`,
        name: "Concurrency Test Supplier",
      })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAACONC-OPEN-${suffix}`,
        startDate: "2024-01-01",
        endDate: "2028-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  it("scenario 42 — two concurrent applyAllocation() calls that TOGETHER exceed the payment amount: exactly one 200, one 422; appliedMinor never exceeds paymentAmountMinor", async () => {
    const token = tokenFor(["finance.poster"]);
    const billOne = await postBill(token, 700, "2026-04-10");
    const billTwo = await postBill(token, 700, "2026-04-10");
    // A zero-allocation payment for 1000 — two concurrent applyAllocation()
    // calls each requesting 700 (together 1400 > 1000).
    const payment = await createAndPostPayment(token, 1000, "2026-04-11");

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 700 }],
          allocationDate: "2026-04-12",
        }),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 700 }],
          allocationDate: "2026-04-12",
        }),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 422]);

    // Assert the DATABASE's final state directly (§19.2's explicit
    // requirement) — not merely the HTTP status pair.
    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    const totalApplied = allocationRows.reduce(
      (s, a) => s + a.allocatedAmountMinor,
      0,
    );
    expect(totalApplied).toBeLessThanOrEqual(1000);
    expect(totalApplied).toBe(700); // only the winner's allocation committed
    expect(allocationRows).toHaveLength(1);
  });

  it("scenario — two concurrent applyAllocation() calls that BOTH fit within the payment's remaining amount both succeed", async () => {
    const token = tokenFor(["finance.poster"]);
    const billOne = await postBill(token, 400, "2026-04-13");
    const billTwo = await postBill(token, 500, "2026-04-13");
    const payment = await createAndPostPayment(token, 1000, "2026-04-14");

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 400 }],
          allocationDate: "2026-04-15",
        }),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 500 }],
          allocationDate: "2026-04-15",
        }),
    ]);
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    const totalApplied = allocationRows.reduce(
      (s, a) => s + a.allocatedAmountMinor,
      0,
    );
    expect(totalApplied).toBe(900);
    expect(allocationRows).toHaveLength(2);
  });

  it("scenario 43 — applyAllocation() racing reverse() on the same payment: whichever acquires the header lock first wins, both outcomes leave a consistent, correct final state", async () => {
    const token = tokenFor(["finance.poster"]);
    const bill = await postBill(token, 500, "2026-04-16");
    const payment = await createAndPostPayment(token, 500, "2026-04-17");

    const [allocRes, reverseRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
          allocationDate: "2026-04-18",
        }),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({}),
    ]);

    // reverse() is never blocked by allocation state (§10) — it always
    // succeeds. applyAllocation() either wins the race (200, and
    // reverse() then correctly unwinds it) or loses (409, because
    // reverse() got there first).
    expect(reverseRes.status).toBe(200);
    expect([200, 409]).toContain(allocRes.status);

    const [paymentRow] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, payment.id)),
    );
    const [billRow] = await withTenant(tenantId, (tx) =>
      tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
    );
    // Whichever ordering occurred, the final state is fully consistent:
    // the bill is never left partially/incorrectly settled — either the
    // allocation never landed (bill untouched) or it landed and was then
    // unwound by the reversal (bill back to unpaid).
    expect(billRow!.paidMinor).toBe(0);
    expect(paymentRow!.status).toBe("POSTED"); // reversal doesn't flip status, only the JE
  });
});
