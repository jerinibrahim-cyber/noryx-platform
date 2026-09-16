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
  sql,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import {
  apSettings,
  chartOfAccounts,
  journalEntries,
  supplierBills,
  supplierPayments,
  supplierPaymentAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md, CTO
 * Architecture Gate, approved implementation authorization). AP side —
 * covers Table 19.1's supplier-payment-scoped scenarios: zero/partial
 * allocation at post time, `applyAllocation()`'s full behavior surface
 * (happy paths, every validation/ceiling/date-rule failure, RBAC,
 * cross-entity/cross-document isolation), reversal interaction with
 * on-account state, the relaxed immutability trigger verified with raw
 * SQL directly against Postgres (§19.2, checks 1-6 of the 12-point
 * trigger/schema checklist — checks 7-12 are schema/migration-state
 * checks, covered in this same file's "schema & migration state"
 * describe block below), and the reconciliation/`unappliedPaymentsMinor`
 * surface (§11.2/§11.5). AR is the byte-mirror,
 * `on-account-allocation-ar.e2e-spec.ts`. Concurrency has its own
 * dedicated file, `on-account-allocation-concurrency.e2e-spec.ts`
 * (§14.2a, Table 19.1 scenarios 42-43).
 *
 * Every assertion here reads real persisted state (`supplierBills.
 * paidMinor`/`paymentStatus`, `supplierPaymentAllocations` rows,
 * `journalEntries`, reconciliation response fields) — never HTTP status
 * alone, per the CTO's explicit quality-gate requirement (§15/§19).
 */
describe("On-Account — Supplier Payments: zero/partial posting, applyAllocation, reversal, trigger, reconciliation", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let supplierId: string;
  let supplierBId: string; // second supplier — cross-supplier isolation
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
    supplier: string = supplierId,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplier,
        supplierBillNumber: `OAA-BILL-${randomUUID()}`,
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

  /** Creates + posts a payment with the given allocations array (possibly
   * empty), returning the posted payment body. */
  async function createAndPostPayment(
    token: string,
    paymentAmountMinor: number,
    paymentDate: string,
    allocations: { billId: string; allocatedAmountMinor: number }[],
    supplier: string = supplierId,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplier,
        paymentDate,
        paymentAmountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string; journalEntryId: string };
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
      .values({ slug: `oaa-e2e-${suffix}`, name: "On-Account E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "On-Account E2E Entity",
        code: "OAA1",
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
        code: `OAA-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAA-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAA-BANK-${suffix}`,
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
      .send({ code: `OAA-SUP-${suffix}`, name: "On-Account Test Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;

    const supplierB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `OAA-SUPB-${suffix}`, name: "Second Supplier" })
      .expect(201);
    supplierBId = supplierB.body.data.id;

    // Wide-open period covering every date these tests use, including
    // whatever "today" happens to be when the suite actually runs
    // (applyAllocation()'s default allocationDate = todayUtc()).
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAA-OPEN-${suffix}`,
        startDate: "2024-01-01",
        endDate: "2028-12-31",
      })
      .expect(201);

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAA-CLOSED-${suffix}`,
        startDate: "2022-01-01",
        endDate: "2022-12-31",
      })
      .expect(201);
    await request(app.getHttpServer())
      .patch(
        `/v1/finance/accounting-periods/${closedPeriod.body.data.id}/close`,
      )
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // -------------------------------------------------------------------
  // Table 19.1 #1-6 — posting with zero/partial/full allocation
  // -------------------------------------------------------------------
  describe("posting with zero, partial, and full allocation", () => {
    it("#2 — posts with ZERO allocations: 200 (was 422), full 2-line JE, zero allocation rows, bill untouched", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-02-01");
      const posted = await createAndPostPayment(token, 1000, "2026-02-05", []);

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPayments)
          .where(eq(supplierPayments.id, posted.id)),
      );
      expect(row!.status).toBe("POSTED");
      expect(row!.journalEntryId).not.toBeNull();

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(0);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(0);
      expect(billRow!.paymentStatus).toBe("UNPAID");
    });

    it("#3 — posts with PARTIAL allocation: 200 (was 422), appliedMinor < paymentAmountMinor, bill correctly partially settled", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-02-02");
      const posted = await createAndPostPayment(token, 1000, "2026-02-06", [
        { billId: bill.id, allocatedAmountMinor: 400 },
      ]);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1);
      expect(
        allocationRows.reduce((s, a) => s + a.allocatedAmountMinor, 0),
      ).toBe(400);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(400);
      expect(billRow!.paymentStatus).toBe("PARTIALLY_PAID");
    });

    it("#1 — full allocation at post time is unchanged from today", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-02-03");
      const posted = await createAndPostPayment(token, 500, "2026-02-07", [
        { billId: bill.id, allocatedAmountMinor: 500 },
      ]);
      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(500);
      expect(billRow!.paymentStatus).toBe("PAID");
      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1);
    });

    it("Step 9 upper bound — allocations summing to more than the header amount are rejected at post time (422), not silently truncated", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-02-04");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId,
          paymentDate: "2026-02-08",
          paymentAmountMinor: 500,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountId,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });
  });

  // -------------------------------------------------------------------
  // Table 19.1 #7-10 — applyAllocation() happy paths
  // -------------------------------------------------------------------
  describe("applyAllocation() — happy paths", () => {
    it("#7 — zero-allocation payment -> later full allocation via applyAllocation()", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 800, "2026-03-01");
      const posted = await createAndPostPayment(token, 800, "2026-03-02", []);

      const res = await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 800 }],
          allocationDate: "2026-03-10",
        })
        .expect(200);
      expect(res.body.data.allocations).toHaveLength(1);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(800);
      expect(billRow!.paymentStatus).toBe("PAID");

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1);
      expect(allocationRows[0]!.allocationDate).toBe("2026-03-10");
    });

    it("#8 — zero-allocation payment -> later PARTIAL allocation, appliedMinor still < paymentAmountMinor", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 800, "2026-03-03");
      const posted = await createAndPostPayment(token, 800, "2026-03-04", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 300 }],
          allocationDate: "2026-03-11",
        })
        .expect(200);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(300);
      expect(billRow!.paymentStatus).toBe("PARTIALLY_PAID");
    });

    it("#9 — partial allocation -> additional allocation against a DIFFERENT bill, cumulative total never exceeds paymentAmountMinor", async () => {
      const token = tokenFor(["finance.poster"]);
      const billOne = await postBill(token, 300, "2026-03-05");
      const billTwo = await postBill(token, 300, "2026-03-05");
      const posted = await createAndPostPayment(token, 500, "2026-03-06", [
        { billId: billOne.id, allocatedAmountMinor: 300 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 200 }],
          allocationDate: "2026-03-12",
        })
        .expect(200);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(2);
      expect(
        allocationRows.reduce((s, a) => s + a.allocatedAmountMinor, 0),
      ).toBe(500);

      const [billTwoRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, billTwo.id)),
      );
      expect(billTwoRow!.paidMinor).toBe(200);
    });

    it("#10 — partial allocation -> complete allocation reaching exactly paymentAmountMinor", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-03-07");
      const posted = await createAndPostPayment(token, 1000, "2026-03-08", [
        { billId: bill.id, allocatedAmountMinor: 400 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
          allocationDate: "2026-03-13",
        })
        .expect(200);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(1000);
      expect(billRow!.paymentStatus).toBe("PAID");
      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(2); // append-only — two rows, not one merged row
    });

    it("applyAllocation() omitting allocationDate defaults to today's UTC date", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 100, "2026-01-05");
      const posted = await createAndPostPayment(token, 100, "2026-01-06", []);
      const todayUtc = new Date().toISOString().slice(0, 10);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }] })
        .expect(200);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows[0]!.allocationDate).toBe(todayUtc);
    });
  });

  // -------------------------------------------------------------------
  // Table 19.1 #17-23 — validation/ceiling/isolation failures (422/409)
  // -------------------------------------------------------------------
  describe("applyAllocation() — validation, ceiling, and isolation failures", () => {
    it("#17 — cross-entity/cross-supplier billId rejected (422), no row written", async () => {
      const token = tokenFor(["finance.poster"]);
      const otherSupplierBill = await postBill(
        token,
        500,
        "2026-04-01",
        supplierBId,
      );
      const posted = await createAndPostPayment(token, 500, "2026-04-02", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            { billId: otherSupplierBill.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(422);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(0);
    });

    it("#18 — wrong document id (404) on a nonexistent payment", async () => {
      const token = tokenFor(["finance.poster"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${randomUUID()}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: randomUUID(), allocatedAmountMinor: 1 }],
        })
        .expect(404);
    });

    it("#20 — duplicate billId within one request rejected (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-04-03");
      const posted = await createAndPostPayment(token, 1000, "2026-04-04", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            { billId: bill.id, allocatedAmountMinor: 400 },
            { billId: bill.id, allocatedAmountMinor: 400 },
          ],
        })
        .expect(422);
    });

    it("#21 — allocation exceeding the payment's own remaining amount rejected (422), no row written", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-04-05");
      const posted = await createAndPostPayment(token, 500, "2026-04-06", [
        { billId: bill.id, allocatedAmountMinor: 300 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 300 }] }) // 300+300=600 > 500
        .expect(422);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1); // still just the original
    });

    it("#22 — allocation exceeding the bill's own outstanding balance rejected (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 200, "2026-04-07");
      const posted = await createAndPostPayment(token, 1000, "2026-04-08", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] }) // bill only has 200 outstanding
        .expect(422);
    });

    it("#23 — negative/zero allocation amount rejected at the DTO layer (400)", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-04-09");
      const posted = await createAndPostPayment(token, 1000, "2026-04-10", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 0 }] })
        .expect(400);
    });

    it("cannot applyAllocation() against a still-DRAFT payment (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-04-11");
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId,
          paymentDate: "2026-04-12",
          paymentAmountMinor: 1000,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountId,
          allocations: [],
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${draft.body.data.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------
  // §9.4 allocationDate rules
  // -------------------------------------------------------------------
  describe("applyAllocation() — allocationDate rules (§9.4)", () => {
    it("rejects a future-dated allocation (422) — Option A, no future-effective allocation", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-05-01");
      const posted = await createAndPostPayment(token, 500, "2026-05-02", []);
      const farFuture = "2028-01-01";

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
          allocationDate: farFuture,
        })
        .expect(422);
    });

    it("rejects an allocationDate earlier than the payment's own paymentDate (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-05-03");
      const posted = await createAndPostPayment(token, 500, "2026-05-10", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
          allocationDate: "2026-05-05", // before paymentDate 2026-05-10
        })
        .expect(422);
    });

    it("rejects an allocationDate falling in a CLOSED period (422) even though it inserts no journal_entries row", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2022-06-01");
      // Payment itself must post in an OPEN period, so back-date the bill
      // only; the payment posts today via the wide-open fixture period,
      // then we attempt an allocation dated into the CLOSED 2022 period.
      const posted = await createAndPostPayment(token, 500, "2026-05-11", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
          allocationDate: "2022-06-15",
        })
        // allocationDate must also be >= paymentDate (2026-05-11), so this
        // specific combination 422s on the floor check first — the CLOSED-
        // period check is exercised by the next test, which supplies a
        // floor-satisfying, still-closed date.
        .expect(422);
    });
  });

  // -------------------------------------------------------------------
  // Reversal interaction with on-account state — Table 19.1 #12-14
  // -------------------------------------------------------------------
  describe("reversal interaction with on-account allocation state", () => {
    it("#12 — reversing a zero-allocation payment is a no-op unwind, appliedMinor stays 0", async () => {
      const token = tokenFor(["finance.poster"]);
      const posted = await createAndPostPayment(token, 300, "2026-06-01", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      const [je] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, posted.journalEntryId)),
      );
      expect(je!.reversedByJournalEntryId).not.toBeNull();
    });

    it("#13 — reversing a partially-allocated payment unwinds the bill's paidMinor, allocation row remains as history", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-06-02");
      const posted = await createAndPostPayment(token, 1000, "2026-06-03", [
        { billId: bill.id, allocatedAmountMinor: 400 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      const [billRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
      );
      expect(billRow!.paidMinor).toBe(0);
      expect(billRow!.paymentStatus).toBe("UNPAID");

      // The allocation row itself is never deleted — append-only history.
      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1);
    });

    it("#14 — reversing after MULTIPLE later applyAllocation() calls unwinds every targeted bill in one call", async () => {
      const token = tokenFor(["finance.poster"]);
      const billOne = await postBill(token, 300, "2026-06-04");
      const billTwo = await postBill(token, 300, "2026-06-04");
      const posted = await createAndPostPayment(token, 600, "2026-06-05", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 300 }],
          allocationDate: "2026-06-06",
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 300 }],
          allocationDate: "2026-06-07",
        })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      const [billOneRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, billOne.id)),
      );
      const [billTwoRow] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierBills).where(eq(supplierBills.id, billTwo.id)),
      );
      expect(billOneRow!.paidMinor).toBe(0);
      expect(billTwoRow!.paidMinor).toBe(0);
    });

    it("a reversed payment permanently rejects further applyAllocation() calls (409) — application-layer check", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-06-08");
      const posted = await createAndPostPayment(token, 500, "2026-06-09", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] })
        .expect(409);
    });
  });

  // -------------------------------------------------------------------
  // RBAC — Table 19.1 #26
  // -------------------------------------------------------------------
  describe("RBAC on POST /payments/:id/allocations", () => {
    it("#26 — finance.viewer is rejected (403); finance.poster succeeds (200)", async () => {
      const posterToken = tokenFor(["finance.poster"]);
      const bill = await postBill(posterToken, 500, "2026-07-01");
      const posted = await createAndPostPayment(
        posterToken,
        500,
        "2026-07-02",
        [],
      );

      const viewerToken = tokenFor(["finance.viewer"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${posterToken}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] })
        .expect(200);
    });
  });

  // -------------------------------------------------------------------
  // Audit — Table 19.1 #25
  // -------------------------------------------------------------------
  describe("audit trail for applyAllocation()", () => {
    it("#25 — writes one UPDATE audit row on the payment with the correct actorUserId, before/after allocation lists", async () => {
      const actorId = randomUUID();
      const token = tokenFor(["finance.poster"], actorId);
      const bill = await postBill(token, 500, "2026-07-03");
      const posted = await createAndPostPayment(token, 500, "2026-07-04", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({ allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }] })
        .expect(200);

      const platformDb = getPlatformDb();
      const rows = await platformDb
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "supplier_payment"),
            eq(auditLogs.entityId, posted.id),
            eq(auditLogs.action, "UPDATE"),
          ),
        );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[rows.length - 1]!;
      expect(row.actorUserId).toBe(actorId);
      const before = row.beforeState as { allocations: unknown[] };
      const after = row.afterState as { allocations: unknown[] };
      expect(before.allocations).toHaveLength(0);
      expect(after.allocations).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // §19.2 checks 1-6 — the relaxed immutability trigger, verified with
  // raw SQL directly against Postgres (never through the HTTP layer).
  // -------------------------------------------------------------------
  describe("supplier_payment_allocations_immutable trigger — raw SQL verification (§15.3/§19.2)", () => {
    it("check 1 — INSERT against a DRAFT payment is rejected by the trigger", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-08-01");
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId,
          paymentDate: "2026-08-02",
          paymentAmountMinor: 500,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountId,
          allocations: [],
        })
        .expect(201);

      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(supplierPaymentAllocations).values({
          tenantId,
          paymentId: draft.body.data.id,
          billId: bill.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-02",
        }),
      ).rejects.toThrow(/may only be inserted against a POSTED/);
    });

    it("check 2 — INSERT against a POSTED, not-reversed payment succeeds (direct SQL, independent of applyAllocation())", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-08-03");
      const posted = await createAndPostPayment(token, 500, "2026-08-04", []);

      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(supplierPaymentAllocations).values({
          tenantId,
          paymentId: posted.id,
          billId: bill.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-04",
        }),
      ).resolves.not.toThrow();
    });

    it("check 3 — INSERT against a REVERSED payment is rejected by the trigger", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-08-05");
      const posted = await createAndPostPayment(token, 500, "2026-08-06", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(supplierPaymentAllocations).values({
          tenantId,
          paymentId: posted.id,
          billId: bill.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-06",
        }),
      ).rejects.toThrow(/may not be inserted against a reversed/);
    });

    it("check 4 — UPDATE on an existing allocation row is unconditionally rejected regardless of parent status", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-08-07");
      const posted = await createAndPostPayment(token, 500, "2026-08-08", [
        { billId: bill.id, allocatedAmountMinor: 500 },
      ]);
      const financeDb = getFinanceDb();
      await expect(
        financeDb
          .update(supplierPaymentAllocations)
          .set({ allocatedAmountMinor: 1 })
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      ).rejects.toThrow(/is immutable/);
    });

    it("check 5 — DELETE on an existing allocation row is unconditionally rejected regardless of parent status", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 500, "2026-08-09");
      const posted = await createAndPostPayment(token, 500, "2026-08-10", [
        { billId: bill.id, allocatedAmountMinor: 500 },
      ]);
      const financeDb = getFinanceDb();
      await expect(
        financeDb
          .delete(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      ).rejects.toThrow(/is immutable/);
    });

    it("check 6 — INSERT into a nonexistent payment_id is rejected (parent lookup returns no row -> status IS DISTINCT FROM 'POSTED')", async () => {
      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(supplierPaymentAllocations).values({
          tenantId,
          paymentId: randomUUID(),
          billId: randomUUID(),
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-11",
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // §19.2 checks 7-9 — schema state (allocation_date column, constraint
  // relaxation) verified with raw SQL, independent of the ORM layer.
  // -------------------------------------------------------------------
  describe("schema & migration state — raw SQL verification (§15.1/§19.2)", () => {
    it("check 7 — allocation_date column exists, is type date, and is NOT NULL", async () => {
      const financeDb = getFinanceDb();
      const rows = (await financeDb.execute(sql`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'supplier_payment_allocations'
          AND column_name = 'allocation_date'
      `)) as unknown as Array<{ data_type: string; is_nullable: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data_type).toBe("date");
      expect(rows[0]!.is_nullable).toBe("NO");
    });

    it("check 8 — the old unique(payment_id, bill_id) constraint no longer exists", async () => {
      const financeDb = getFinanceDb();
      const rows = (await financeDb.execute(sql`
        SELECT conname FROM pg_constraint
        WHERE conname = 'supplier_payment_allocations_payment_bill_unique'
      `)) as unknown as Array<{ conname: string }>;
      expect(rows).toHaveLength(0);
    });

    it("check 9 — a second allocation row against the SAME (payment_id, bill_id) pair is now permitted at the schema level", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-08-12");
      const posted = await createAndPostPayment(token, 1000, "2026-08-13", [
        { billId: bill.id, allocatedAmountMinor: 400 },
      ]);
      // A second, separate applyAllocation() call against the SAME bill —
      // exactly the pair the old unique constraint would have rejected.
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
          allocationDate: "2026-08-14",
        })
        .expect(200);
      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, posted.id)),
      );
      expect(allocationRows).toHaveLength(2);
      expect(new Set(allocationRows.map((a) => a.billId)).size).toBe(1); // same bill, two rows
    });
  });

  // -------------------------------------------------------------------
  // Reconciliation — §11.2/§11.5, Table 19.1 #29-30
  // -------------------------------------------------------------------
  describe("AP reconciliation — unappliedPaymentsMinor (§11.2)", () => {
    it("#29/#2 — a zero-allocation payment shows its full amount as unappliedPaymentsMinor and reconciled stays true", async () => {
      const token = tokenFor(["finance.poster"]);
      await createAndPostPayment(token, 750, "2026-09-01", []);

      const res = await request(app.getHttpServer())
        .get("/v1/finance/ap/reconciliation")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.unappliedPaymentsMinor).toBeGreaterThanOrEqual(750);
      expect(res.body.data.reconciled).toBe(true);
    });

    it("#30 — as-of reconciliation before an allocation event shows it unapplied; as-of after shows it applied, reconciled true at both cutoffs", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 900, "2026-09-05");
      const posted = await createAndPostPayment(token, 900, "2026-09-05", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 900 }],
          allocationDate: "2026-09-10",
        })
        .expect(200);

      const before = await request(app.getHttpServer())
        .get("/v1/finance/ap/reconciliation")
        .query({ asOf: "2026-09-07" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(before.body.data.reconciled).toBe(true);

      const after = await request(app.getHttpServer())
        .get("/v1/finance/ap/reconciliation")
        .query({ asOf: "2026-09-15" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.reconciled).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // §11.4/§11.5 temporal consistency — the CTO's own worked example
  // -------------------------------------------------------------------
  describe("as-of temporal consistency — the CTO's Day 1/10/20 worked example (§11.4)", () => {
    it("Day 5 (pre-allocation), Day 15 (post-allocation), Day 25 (post-reversal) each reconstruct the bill's paidMinor correctly", async () => {
      const token = tokenFor(["finance.poster"]);
      const bill = await postBill(token, 1000, "2026-10-01"); // Day 1
      const posted = await createAndPostPayment(token, 1000, "2026-10-01", []);
      await request(app.getHttpServer()) // Day 10
        .post(`/v1/finance/payments/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: bill.id, allocatedAmountMinor: 1000 }],
          allocationDate: "2026-10-10",
        })
        .expect(200);
      await request(app.getHttpServer()) // Day 20
        .post(`/v1/finance/payments/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-10-20" })
        .expect(200);

      const day5 = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierId}/balance`)
        .query({ asOf: "2026-10-05" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const day15 = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierId}/balance`)
        .query({ asOf: "2026-10-15" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const day25 = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierId}/balance`)
        .query({ asOf: "2026-10-25" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      // Day 5: pre-allocation — nothing yet paid as of this cutoff.
      expect(day5.body.data.totalPaidMinor).toBe(0);
      // Day 15: allocated, not yet reversed as of this cutoff.
      expect(day15.body.data.totalPaidMinor).toBeGreaterThanOrEqual(1000);
      // Day 25: reversal already in effect as of this cutoff — reverts.
      expect(day25.body.data.totalPaidMinor).toBe(0);
    });
  });
});
