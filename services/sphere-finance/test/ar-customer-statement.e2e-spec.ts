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
 * AR-1d — Customer Statement (`GET /customers/:id/statement`).
 * docs/finance-work-item-1d-ar-reports-proposal.md §7, §13. Mirrors
 * test/ap-supplier-statement.e2e-spec.ts's 5 cases.
 */
describe("AR Reports — Customer Statement (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityBId: string;
  let revenueAccountId: string;
  let arAccountId: string;
  let bankAccountId: string;
  let customerBId: string; // cross-tenant isolation
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

  async function newCustomer(code: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `${code}-${suffix}`, name: code })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPostInvoice(
    customerId: string,
    invoiceDate: string,
    amountMinor: number,
    memo?: string,
  ): Promise<{ id: string; totalMinor: number; internalReference: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        invoiceDate,
        memo,
        lines: [{ accountId: revenueAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      totalMinor: posted.body.data.totalMinor,
      internalReference: posted.body.data.internalReference,
    };
  }

  async function createAndPostReceipt(
    customerId: string,
    receiptDate: string,
    amountMinor: number,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
  ): Promise<{ id: string; internalReference: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate,
        receiptAmountMinor: amountMinor,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      internalReference: posted.body.data.internalReference,
    };
  }

  /** §9a.2 (Credit/Debit Notes work item, CTO-approved) — a credit note
   * contributes a "CREDIT_NOTE" StatementLine, structured identically to
   * the RECEIPT block, negative-signed. */
  async function createAndPostCreditNote(
    customerId: string,
    creditNoteDate: string,
    amountMinor: number,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
    reason?: string,
  ): Promise<{ id: string; internalReference: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/credit-notes")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        creditNoteDate,
        reason,
        lines: [{ accountId: revenueAccountId, amountMinor }],
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/credit-notes/${created.body.data.id}/post`)
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
      .values({
        slug: `ar-stmt-e2e-a-${suffix}`,
        name: "AR Statement E2E Tenant A",
      })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `ar-stmt-e2e-b-${suffix}`,
        name: "AR Statement E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "ARSTMTA1",
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
        code: "ARSTMTB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [rev] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARSTMT-REV-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [ar] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARSTMT-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARSTMT-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    revenueAccountId = rev!.id;
    arAccountId = ar!.id;
    bankAccountId = bank!.id;

    adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    posterToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ arControlAccountId: arAccountId })
      .expect(201);

    const custB = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `ARSTMT-B-${suffix}`, name: "Tenant B Customer" })
      .expect(201);
    customerBId = custB.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `ARSTMT-OPEN-${suffix}`,
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

  it("empty statement — a customer with no activity returns zero rows and opening = closing = 0", async () => {
    const customerId = await newCustomer("Empty");
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/statement`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.openingBalanceMinor).toBe(0);
    expect(res.body.meta.closingBalanceMinor).toBe(0);
  });

  it("invoices, receipts, allocations, running balance, and chronological ordering — full walkthrough, including statement-row description fallbacks (§14 decision 1)", async () => {
    const customerId = await newCustomer("Walkthrough");

    const invoiceA = await createAndPostInvoice(
      customerId,
      "2026-02-01",
      1000,
      "Consulting — January",
    );
    const invoiceB = await createAndPostInvoice(
      customerId,
      "2026-02-10",
      500,
      // no memo — falls back to "Invoice" (§14 decision 1).
    );
    const receipt = await createAndPostReceipt(customerId, "2026-02-15", 700, [
      { invoiceId: invoiceA.id, allocatedAmountMinor: 700 },
    ]);

    const res = await request(app.getHttpServer())
      .get(
        `/v1/finance/customers/${customerId}/statement?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(res.body.meta.openingBalanceMinor).toBe(0);
    expect(res.body.data).toHaveLength(3);

    // Chronological order: invoiceA (Feb 1), invoiceB (Feb 10), receipt
    // (Feb 15).
    const [rowA, rowB, rowRct] = res.body.data;
    expect(rowA).toMatchObject({
      type: "INVOICE",
      date: "2026-02-01",
      invoiceId: invoiceA.id,
      description: "Consulting — January",
      amountMinor: 1000,
      runningBalanceMinor: 1000,
    });
    expect(rowB).toMatchObject({
      type: "INVOICE",
      date: "2026-02-10",
      invoiceId: invoiceB.id,
      description: "Invoice",
      amountMinor: 500,
      runningBalanceMinor: 1500,
    });
    expect(rowRct).toMatchObject({
      type: "RECEIPT",
      date: "2026-02-15",
      receiptId: receipt.id,
      amountMinor: -700,
      runningBalanceMinor: 800,
    });
    // Receipt allocations are visible on the receipt row.
    expect(rowRct.allocations).toEqual([
      {
        invoiceId: invoiceA.id,
        invoiceReference: invoiceA.internalReference,
        allocatedAmountMinor: 700,
      },
    ]);

    expect(res.body.meta.closingBalanceMinor).toBe(800);
    expect(res.body.meta.closingBalanceMinor).toBe(1000 + 500 - 700);
  });

  it("receipt description prefers memo, then falls back to reference, then a generic label (§14 decision 1)", async () => {
    const customerId = await newCustomer("RcptDescFallback");
    const invoice = await createAndPostInvoice(customerId, "2026-03-01", 1000);

    const created1 = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-03-05",
        receiptAmountMinor: 300,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        reference: "WIRE-REF-1",
        memo: "Partial settlement",
        allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 300 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created1.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const created2 = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-03-06",
        receiptAmountMinor: 200,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        reference: "WIRE-REF-2",
        // no memo — falls back to reference.
        allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 200 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created2.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const created3 = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-03-07",
        receiptAmountMinor: 100,
        receiptMethod: "CASH",
        bankCashAccountId: bankAccountId,
        // no memo, no reference — falls back to "Receipt".
        allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 100 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created3.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/statement`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const receiptRows = res.body.data.filter(
      (r: { type: string }) => r.type === "RECEIPT",
    );
    expect(receiptRows).toHaveLength(3);
    expect(receiptRows[0].description).toBe("Partial settlement");
    expect(receiptRows[1].description).toBe("WIRE-REF-2");
    expect(receiptRows[2].description).toBe("Receipt");
  });

  it("date ranges — opening balance reflects everything strictly before dateFrom, and rows outside the range are excluded", async () => {
    const customerId = await newCustomer("DateRange");

    await createAndPostInvoice(customerId, "2026-04-01", 1000);
    const invoiceMid = await createAndPostInvoice(
      customerId,
      "2026-04-15",
      500,
    );
    await createAndPostInvoice(customerId, "2026-05-01", 200);

    const res = await request(app.getHttpServer())
      .get(
        `/v1/finance/customers/${customerId}/statement?dateFrom=2026-04-10&dateTo=2026-04-30`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    // The April 1 invoice (1000) is strictly before dateFrom -> opening
    // balance. The April 15 invoice is inside the window. The May 1
    // invoice is after dateTo -> excluded entirely.
    expect(res.body.meta.openingBalanceMinor).toBe(1000);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoiceId).toBe(invoiceMid.id);
    expect(res.body.data[0].runningBalanceMinor).toBe(1500);
    expect(res.body.meta.closingBalanceMinor).toBe(1500);
  });

  it("cross-tenant isolation — a customer belonging to a different tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerBId}/statement`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(404);
  });

  it("rejects dateTo before dateFrom with a 400", async () => {
    const customerId = await newCustomer("BadRange");
    await request(app.getHttpServer())
      .get(
        `/v1/finance/customers/${customerId}/statement?dateFrom=2026-02-01&dateTo=2026-01-01`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(400);
  });

  describe("Credit Notes work item (§9a.2, CTO-approved) — CREDIT_NOTE statement rows", () => {
    it("a posted credit note appears as a CREDIT_NOTE row, negative-signed, with its own allocations, merged into chronological order", async () => {
      const customerId = await newCustomer("CrnWalkthrough");

      const invoice = await createAndPostInvoice(
        customerId,
        "2026-06-01",
        1000,
        "Consulting — June",
      );
      const receipt = await createAndPostReceipt(
        customerId,
        "2026-06-05",
        300,
        [{ invoiceId: invoice.id, allocatedAmountMinor: 300 }],
      );
      void receipt;
      const creditNote = await createAndPostCreditNote(
        customerId,
        "2026-06-10",
        400,
        [{ invoiceId: invoice.id, allocatedAmountMinor: 400 }],
        "Goodwill adjustment",
      );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/customers/${customerId}/statement?dateFrom=2026-01-01&dateTo=2026-12-31`,
        )
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(3);
      const [rowInv, rowRct, rowCrn] = res.body.data;
      expect(rowInv.type).toBe("INVOICE");
      expect(rowRct.type).toBe("RECEIPT");
      expect(rowCrn).toMatchObject({
        type: "CREDIT_NOTE",
        date: "2026-06-10",
        reference: creditNote.internalReference,
        description: "Goodwill adjustment",
        amountMinor: -400,
        runningBalanceMinor: 1000 - 300 - 400,
      });
      expect(rowCrn.creditNoteId).toBe(creditNote.id);
      expect(rowCrn.allocations).toEqual([
        {
          invoiceId: invoice.id,
          invoiceReference: invoice.internalReference,
          allocatedAmountMinor: 400,
        },
      ]);

      expect(res.body.meta.closingBalanceMinor).toBe(1000 - 300 - 400);
    });

    it("credit note description falls back to a generic label when reason is omitted (mirrors RECEIPT's fallback chain, §9a.2)", async () => {
      const customerId = await newCustomer("CrnDescFallback");
      const invoice = await createAndPostInvoice(customerId, "2026-06-01", 500);
      const creditNote = await createAndPostCreditNote(
        customerId,
        "2026-06-05",
        500,
        [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        // no reason — falls back to "Credit note".
      );

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/statement`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      const row = res.body.data.find(
        (r: { type: string }) => r.type === "CREDIT_NOTE",
      );
      expect(row.description).toBe("Credit note");
      void creditNote;
    });

    it("opening balance reflects a credit note dated strictly before dateFrom (via the §9a.1-extended asOfTotals(strict:true))", async () => {
      const customerId = await newCustomer("CrnOpeningBalance");
      const invoice = await createAndPostInvoice(
        customerId,
        "2026-07-01",
        1000,
      );
      await createAndPostCreditNote(customerId, "2026-07-05", 300, [
        { invoiceId: invoice.id, allocatedAmountMinor: 300 },
      ]);
      const invoiceInWindow = await createAndPostInvoice(
        customerId,
        "2026-07-15",
        200,
      );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/customers/${customerId}/statement?dateFrom=2026-07-10&dateTo=2026-07-31`,
        )
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      // The July 1 invoice (1000) and July 5 credit note (-300) are both
      // strictly before dateFrom -> folded into opening balance (700).
      // Only the July 15 invoice falls inside the window.
      expect(res.body.meta.openingBalanceMinor).toBe(700);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].invoiceId).toBe(invoiceInWindow.id);
      expect(res.body.data[0].runningBalanceMinor).toBe(900);
      expect(res.body.meta.closingBalanceMinor).toBe(900);
    });
  });
});
