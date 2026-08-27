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
 * AP-1d — Supplier Statement (`GET /suppliers/:id/statement`).
 * docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.2, §9.
 */
describe("AP Reports — Supplier Statement (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityBId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let supplierBId: string; // cross-tenant isolation
  let posterToken: string;
  let adminToken: string;
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

  async function newSupplier(code: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `${code}-${suffix}`, name: code })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPostBill(
    supplierId: string,
    billDate: string,
    amountMinor: number,
    supplierBillNumber?: string,
  ): Promise<{ id: string; totalMinor: number; internalReference: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: supplierBillNumber ?? `STMT-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      totalMinor: posted.body.data.totalMinor,
      internalReference: posted.body.data.internalReference,
    };
  }

  async function createAndPostPayment(
    supplierId: string,
    paymentDate: string,
    amountMinor: number,
    allocations: { billId: string; allocatedAmountMinor: number }[],
  ): Promise<{ id: string; internalReference: string }> {
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
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      internalReference: posted.body.data.internalReference,
    };
  }

  /** §9a.2 (Credit/Debit Notes work item, CTO-approved) — a debit note
   * contributes a "DEBIT_NOTE" StatementLine, structured identically to
   * the PAYMENT block, negative-signed. */
  async function createAndPostDebitNote(
    supplierId: string,
    debitNoteDate: string,
    amountMinor: number,
    allocations: { billId: string; allocatedAmountMinor: number }[],
    reason?: string,
  ): Promise<{ id: string; internalReference: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/debit-notes")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        debitNoteDate,
        reason,
        lines: [{ accountId: expenseAccountId, amountMinor }],
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      internalReference: posted.body.data.internalReference,
    };
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
      .values({ slug: `stmt-e2e-a-${suffix}`, name: "Statement E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `stmt-e2e-b-${suffix}`, name: "Statement E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "STMTA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "STMTB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [exp] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `STMT-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `STMT-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `STMT-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = exp!.id;
    liabilityAccountId = liability!.id;
    bankAccountId = bank!.id;

    adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    posterToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountId })
      .expect(201);

    const supB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `STMT-B-${suffix}`, name: "Tenant B Supplier" })
      .expect(201);
    supplierBId = supB.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `STMT-OPEN-${suffix}`,
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

  it("empty statement — a supplier with no activity returns zero rows and opening = closing = 0", async () => {
    const supplierId = await newSupplier("Empty");
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/statement`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.openingBalanceMinor).toBe(0);
    expect(res.body.meta.closingBalanceMinor).toBe(0);
  });

  it("bills, payments, allocations, running balance, and chronological ordering — full walkthrough", async () => {
    const supplierId = await newSupplier("Walkthrough");

    const billA = await createAndPostBill(
      supplierId,
      "2026-02-01",
      1000,
      "WT-INV-A",
    );
    const billB = await createAndPostBill(
      supplierId,
      "2026-02-10",
      500,
      "WT-INV-B",
    );
    const payment = await createAndPostPayment(supplierId, "2026-02-15", 700, [
      { billId: billA.id, allocatedAmountMinor: 700 },
    ]);

    const res = await request(app.getHttpServer())
      .get(
        `/v1/finance/suppliers/${supplierId}/statement?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(res.body.meta.openingBalanceMinor).toBe(0);
    expect(res.body.data).toHaveLength(3);

    // Chronological order: billA (Feb 1), billB (Feb 10), payment (Feb 15).
    const [rowA, rowB, rowPay] = res.body.data;
    expect(rowA).toMatchObject({
      type: "BILL",
      date: "2026-02-01",
      billId: billA.id,
      amountMinor: 1000,
      runningBalanceMinor: 1000,
    });
    expect(rowB).toMatchObject({
      type: "BILL",
      date: "2026-02-10",
      billId: billB.id,
      amountMinor: 500,
      runningBalanceMinor: 1500,
    });
    expect(rowPay).toMatchObject({
      type: "PAYMENT",
      date: "2026-02-15",
      paymentId: payment.id,
      amountMinor: -700,
      runningBalanceMinor: 800,
    });
    // Payment allocations are visible on the payment row.
    expect(rowPay.allocations).toEqual([
      {
        billId: billA.id,
        billReference: billA.internalReference,
        allocatedAmountMinor: 700,
      },
    ]);

    expect(res.body.meta.closingBalanceMinor).toBe(800);
    expect(res.body.meta.closingBalanceMinor).toBe(1000 + 500 - 700);
  });

  it("date ranges — opening balance reflects everything strictly before dateFrom, and rows outside the range are excluded", async () => {
    const supplierId = await newSupplier("DateRange");

    await createAndPostBill(supplierId, "2026-03-01", 1000, "DR-INV-1");
    const billMid = await createAndPostBill(
      supplierId,
      "2026-03-15",
      500,
      "DR-INV-2",
    );
    await createAndPostBill(supplierId, "2026-04-01", 200, "DR-INV-3");

    const res = await request(app.getHttpServer())
      .get(
        `/v1/finance/suppliers/${supplierId}/statement?dateFrom=2026-03-10&dateTo=2026-03-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    // The March 1 bill (1000) is strictly before dateFrom -> opening
    // balance. The March 15 bill is inside the window. The April 1 bill
    // is after dateTo -> excluded entirely.
    expect(res.body.meta.openingBalanceMinor).toBe(1000);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].billId).toBe(billMid.id);
    expect(res.body.data[0].runningBalanceMinor).toBe(1500);
    expect(res.body.meta.closingBalanceMinor).toBe(1500);
  });

  it("cross-tenant isolation — a supplier belonging to a different tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierBId}/statement`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(404);
  });

  it("rejects dateTo before dateFrom with a 400", async () => {
    const supplierId = await newSupplier("BadRange");
    await request(app.getHttpServer())
      .get(
        `/v1/finance/suppliers/${supplierId}/statement?dateFrom=2026-02-01&dateTo=2026-01-01`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(400);
  });

  describe("Debit Notes work item (§9a.2, CTO-approved) — DEBIT_NOTE statement rows", () => {
    it("a posted debit note appears as a DEBIT_NOTE row, negative-signed, with its own allocations, merged into chronological order", async () => {
      const supplierId = await newSupplier("DbnWalkthrough");

      const bill = await createAndPostBill(
        supplierId,
        "2026-06-01",
        1000,
        "DBN-WT-BILL",
      );
      const payment = await createAndPostPayment(
        supplierId,
        "2026-06-05",
        300,
        [{ billId: bill.id, allocatedAmountMinor: 300 }],
      );
      void payment;
      const debitNote = await createAndPostDebitNote(
        supplierId,
        "2026-06-10",
        400,
        [{ billId: bill.id, allocatedAmountMinor: 400 }],
        "Goodwill adjustment",
      );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/suppliers/${supplierId}/statement?dateFrom=2026-01-01&dateTo=2026-12-31`,
        )
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(3);
      const [rowBill, rowPay, rowDbn] = res.body.data;
      expect(rowBill.type).toBe("BILL");
      expect(rowPay.type).toBe("PAYMENT");
      expect(rowDbn).toMatchObject({
        type: "DEBIT_NOTE",
        date: "2026-06-10",
        reference: debitNote.internalReference,
        description: "Goodwill adjustment",
        amountMinor: -400,
        runningBalanceMinor: 1000 - 300 - 400,
      });
      expect(rowDbn.debitNoteId).toBe(debitNote.id);
      expect(rowDbn.allocations).toEqual([
        {
          billId: bill.id,
          billReference: bill.internalReference,
          allocatedAmountMinor: 400,
        },
      ]);

      expect(res.body.meta.closingBalanceMinor).toBe(1000 - 300 - 400);
    });

    it("debit note description falls back to a generic label when reason is omitted (mirrors PAYMENT's fallback chain, §9a.2)", async () => {
      const supplierId = await newSupplier("DbnDescFallback");
      const bill = await createAndPostBill(
        supplierId,
        "2026-06-01",
        500,
        "DBN-FALLBACK-BILL",
      );
      const debitNote = await createAndPostDebitNote(
        supplierId,
        "2026-06-05",
        500,
        [{ billId: bill.id, allocatedAmountMinor: 500 }],
        // no reason — falls back to "Debit note".
      );

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${supplierId}/statement`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      const row = res.body.data.find(
        (r: { type: string }) => r.type === "DEBIT_NOTE",
      );
      expect(row.description).toBe("Debit note");
      void debitNote;
    });

    it("opening balance reflects a debit note dated strictly before dateFrom (via the §9a.1-extended asOfTotals(strict:true))", async () => {
      const supplierId = await newSupplier("DbnOpeningBalance");
      const bill = await createAndPostBill(
        supplierId,
        "2026-07-01",
        1000,
        "DBN-OPEN-BILL",
      );
      await createAndPostDebitNote(supplierId, "2026-07-05", 300, [
        { billId: bill.id, allocatedAmountMinor: 300 },
      ]);
      const billInWindow = await createAndPostBill(
        supplierId,
        "2026-07-15",
        200,
        "DBN-OPEN-BILL-2",
      );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/suppliers/${supplierId}/statement?dateFrom=2026-07-10&dateTo=2026-07-31`,
        )
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      // The July 1 bill (1000) and July 5 debit note (-300) are both
      // strictly before dateFrom -> folded into opening balance (700).
      // Only the July 15 bill falls inside the window.
      expect(res.body.meta.openingBalanceMinor).toBe(700);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].billId).toBe(billInWindow.id);
      expect(res.body.data[0].runningBalanceMinor).toBe(900);
      expect(res.body.meta.closingBalanceMinor).toBe(900);
    });
  });
});
