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
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Tax/VAT Phase 4 — VAT Position Report.
 * docs/finance-work-item-tax-vat-phase-4-discovery.md §9.
 *
 * Every account, tax code/rate, customer/supplier, invoice/credit-note/
 * bill/debit-note used here is created and posted through the real
 * HTTP API, never inserted directly — same discipline every other
 * Finance e2e suite in this codebase follows.
 */
describe("VAT Position Report (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let revenueAccountA1Id: string;
  let arControlAccountA1Id: string;
  let taxOutputAccountA1Id: string;
  let expenseAccountA1Id: string;
  let apControlAccountA1Id: string;
  let taxInputAccountA1Id: string;

  let customerA1Id: string;
  let supplierA1Id: string;
  let openPeriodA1Id: string;

  let taxCodeStandardId: string; // STANDARD, 500bp
  let taxCodeZeroId: string; // ZERO_RATED, 0bp
  let taxCodeExemptId: string; // EXEMPT, 0bp

  function tokenFor(
    tenantId: string | null,
    legalEntityId: string | null,
    roles: string[],
  ) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function createAccount(
    token: string,
    body: { code: string; name: string; type: string },
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body.data.id;
  }

  async function createTaxCode(
    token: string,
    code: string,
    treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT",
    rateBasisPoints: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/tax-codes")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, name: code, treatment })
      .expect(201);
    const taxCodeId = res.body.data.id as string;
    await request(app.getHttpServer())
      .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rateBasisPoints, effectiveFrom: "2020-01-01" })
      .expect(201);
    return taxCodeId;
  }

  async function createAndPostInvoice(
    token: string,
    invoiceDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId: customerA1Id, invoiceDate, lines })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  async function createAndPostCreditNote(
    token: string,
    creditNoteDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
    invoiceId: string,
    allocatedAmountMinor: number,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/credit-notes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customerA1Id,
        creditNoteDate,
        lines,
        allocations: [{ invoiceId, allocatedAmountMinor }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/credit-notes/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  async function createAndPostBill(
    token: string,
    billDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplierA1Id,
        supplierBillNumber: `SBN-${randomUUID().slice(0, 8)}`,
        billDate,
        lines,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
  }

  async function createAndPostDebitNote(
    token: string,
    debitNoteDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
    billId: string,
    allocatedAmountMinor: number,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/debit-notes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplierA1Id,
        debitNoteDate,
        lines,
        allocations: [{ billId, allocatedAmountMinor }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  function vatPosition(token: string, query: Record<string, string>) {
    return request(app.getHttpServer())
      .get("/v1/finance/tax-reports/vat-position")
      .set("Authorization", `Bearer ${token}`)
      .query(query);
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
        slug: `vat-pos-e2e-a-${suffix}`,
        name: "VAT Position E2E Tenant A",
      })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `vat-pos-e2e-b-${suffix}`,
        name: "VAT Position E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "VAT Position Tenant A — Entity 1",
        code: "VATPOSA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "VAT Position Tenant A — Entity 2",
        code: "VATPOSA2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "VAT Position Tenant B — Entity 1",
        code: "VATPOSB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    revenueAccountA1Id = await createAccount(adminA1, {
      code: "VAT-REV",
      name: "Revenue",
      type: "REVENUE",
    });
    arControlAccountA1Id = await createAccount(adminA1, {
      code: "VAT-AR",
      name: "AR Control",
      type: "ASSET",
    });
    taxOutputAccountA1Id = await createAccount(adminA1, {
      code: "VAT-TAXOUT",
      name: "Tax Output",
      type: "LIABILITY",
    });
    expenseAccountA1Id = await createAccount(adminA1, {
      code: "VAT-EXP",
      name: "Expense",
      type: "EXPENSE",
    });
    apControlAccountA1Id = await createAccount(adminA1, {
      code: "VAT-AP",
      name: "AP Control",
      type: "LIABILITY",
    });
    taxInputAccountA1Id = await createAccount(adminA1, {
      code: "VAT-TAXIN",
      name: "Tax Input",
      type: "ASSET",
    });

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        arControlAccountId: arControlAccountA1Id,
        taxOutputAccountId: taxOutputAccountA1Id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        apControlAccountId: apControlAccountA1Id,
        taxInputAccountId: taxInputAccountA1Id,
      })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({ code: `VATCUST-${suffix}`, name: "VAT Position Customer" })
      .expect(201);
    customerA1Id = customer.body.data.id;

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({ code: `VATSUPP-${suffix}`, name: "VAT Position Supplier" })
      .expect(201);
    supplierA1Id = supplier.body.data.id;

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `VATP-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = period.body.data.id;

    taxCodeStandardId = await createTaxCode(
      adminA1,
      `VAT-STD-${suffix}`,
      "STANDARD",
      500,
    );
    taxCodeZeroId = await createTaxCode(
      adminA1,
      `VAT-ZERO-${suffix}`,
      "ZERO_RATED",
      0,
    );
    taxCodeExemptId = await createTaxCode(
      adminA1,
      `VAT-EXEMPT-${suffix}`,
      "EXEMPT",
      0,
    );
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/tax-reports/vat-position")
        .query({ dateFrom: "2026-02-01", dateTo: "2026-02-28" })
        .expect(401);
    });

    it("finance.viewer, finance.poster, and finance.admin can all read (200) — no write route exists on this controller", async () => {
      for (const role of [
        "finance.viewer",
        "finance.poster",
        "finance.admin",
      ]) {
        const token = tokenFor(tenantAId, legalEntityA1Id, [role]);
        await vatPosition(token, {
          dateFrom: "2026-02-01",
          dateTo: "2026-02-28",
        }).expect(200);
      }
    });
  });

  describe("query validation", () => {
    it("rejects a query with neither dateFrom/dateTo nor periodId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await vatPosition(token, {}).expect(400);
    });

    it("accepts periodId alone, resolving dateFrom/dateTo from the period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      const res = await vatPosition(token, {
        periodId: openPeriodA1Id,
      }).expect(200);
      expect(res.body.meta.periodId).toBe(openPeriodA1Id);
      expect(res.body.meta.dateFrom).toBe("2026-01-01");
      expect(res.body.meta.dateTo).toBe("2026-12-31");
    });
  });

  describe("no tax activity", () => {
    it("returns all-zero totals and empty breakdowns for a window with no posted documents", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      const res = await vatPosition(token, {
        dateFrom: "2019-01-01",
        dateTo: "2019-01-31",
      }).expect(200);
      expect(res.body.data.outputByTaxCode).toEqual([]);
      expect(res.body.data.inputByTaxCode).toEqual([]);
      expect(res.body.meta.outputTaxMinor).toBe(0);
      expect(res.body.meta.inputTaxMinor).toBe(0);
      expect(res.body.meta.netPositionMinor).toBe(0);
      expect(res.body.meta.unclassifiedOutputTaxMinor).toBe(0);
      expect(res.body.meta.unclassifiedInputTaxMinor).toBe(0);
    });
  });

  describe("classification by treatment", () => {
    it("classifies STANDARD, ZERO_RATED, and EXEMPT tax codes correctly and includes supply value", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostInvoice(token, "2026-03-05", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
        },
      ]);
      await createAndPostInvoice(token, "2026-03-06", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 5000,
          taxCodeId: taxCodeZeroId,
        },
      ]);
      await createAndPostInvoice(token, "2026-03-07", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 3000,
          taxCodeId: taxCodeExemptId,
        },
      ]);

      const res = await vatPosition(token, {
        dateFrom: "2026-03-05",
        dateTo: "2026-03-07",
      }).expect(200);

      const rows: Array<{
        taxCodeId: string;
        treatment: string;
        netSupplyValueMinor: number;
        netTaxMinor: number;
      }> = res.body.data.outputByTaxCode;
      const std = rows.find((r) => r.taxCodeId === taxCodeStandardId);
      const zero = rows.find((r) => r.taxCodeId === taxCodeZeroId);
      const exempt = rows.find((r) => r.taxCodeId === taxCodeExemptId);

      expect(std!.treatment).toBe("STANDARD");
      expect(std!.netSupplyValueMinor).toBe(10000);
      expect(std!.netTaxMinor).toBe(500); // 5% of 10000

      expect(zero!.treatment).toBe("ZERO_RATED");
      expect(zero!.netSupplyValueMinor).toBe(5000);
      expect(zero!.netTaxMinor).toBe(0);

      expect(exempt!.treatment).toBe("EXEMPT");
      expect(exempt!.netSupplyValueMinor).toBe(3000);
      expect(exempt!.netTaxMinor).toBe(0);

      expect(res.body.meta.outputTaxMinor).toBe(500);
    });
  });

  describe("credit/debit note polarity — the primary proof obligation", () => {
    it("a credit note reduces net output tax for its tax code, not merely a separate bucket", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoiceId = await createAndPostInvoice(token, "2026-04-05", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
        },
      ]); // tax = 500
      await createAndPostCreditNote(
        token,
        "2026-04-10",
        [
          {
            accountId: revenueAccountA1Id,
            amountMinor: 4000,
            taxCodeId: taxCodeStandardId,
          },
        ], // tax = 200
        invoiceId,
        4200,
      );

      const res = await vatPosition(token, {
        dateFrom: "2026-04-01",
        dateTo: "2026-04-30",
      }).expect(200);
      const row = res.body.data.outputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeStandardId,
      );
      expect(row.netTaxMinor).toBe(300); // 500 - 200, net — never 500 + 200
      expect(row.netSupplyValueMinor).toBe(6000); // 10000 - 4000
      expect(res.body.meta.outputTaxMinor).toBe(300);
    });

    it("a debit note reduces net input tax for its tax code, mirroring the credit-note case", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, "2026-04-05", [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 8000,
          taxCodeId: taxCodeStandardId,
        },
      ]); // tax = 400
      await createAndPostDebitNote(
        token,
        "2026-04-12",
        [
          {
            accountId: expenseAccountA1Id,
            amountMinor: 2000,
            taxCodeId: taxCodeStandardId,
          },
        ], // tax = 100
        bill.id,
        2100,
      );

      const res = await vatPosition(token, {
        dateFrom: "2026-04-01",
        dateTo: "2026-04-30",
      }).expect(200);
      const row = res.body.data.inputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeStandardId,
      );
      expect(row.netTaxMinor).toBe(300); // 400 - 100
      expect(res.body.meta.inputTaxMinor).toBe(300);
    });
  });

  describe("legacy / unclassified tax lines", () => {
    it("a legacy line with no taxCodeId is never dropped — it lands in unclassifiedOutputTaxMinor", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostInvoice(token, "2026-05-05", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxAmountMinor: 60,
        }, // no taxCodeId
      ]);

      const res = await vatPosition(token, {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      }).expect(200);
      expect(res.body.meta.outputTaxMinor).toBe(60);
      expect(res.body.meta.unclassifiedOutputTaxMinor).toBe(60);
      // Never appears in the classified breakdown — it has no tax code.
      expect(
        res.body.data.outputByTaxCode.some(
          (r: { netTaxMinor: number }) => r.netTaxMinor === 60,
        ),
      ).toBe(false);
    });

    it("a legacy input line with no taxCodeId lands in unclassifiedInputTaxMinor", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostBill(token, "2026-05-06", [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 1000,
          taxAmountMinor: 45,
        },
      ]);

      const res = await vatPosition(token, {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      }).expect(200);
      expect(res.body.meta.unclassifiedInputTaxMinor).toBeGreaterThanOrEqual(
        45,
      );
    });
  });

  describe("overridden tax lines", () => {
    it("netTaxMinor reports the overridden (authoritative) amount; netCalculatedTaxMinor retains the calculated figure", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostInvoice(token, "2026-06-05", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 480, // override — calculated would be 500
        },
      ]);

      const res = await vatPosition(token, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      }).expect(200);
      const row = res.body.data.outputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeStandardId,
      );
      expect(row.netTaxMinor).toBe(480);
      expect(row.netCalculatedTaxMinor).toBe(500);
      expect(res.body.meta.outputTaxMinor).toBe(480);
    });
  });

  describe("date-window boundary", () => {
    it("includes a document dated exactly on dateTo, excludes one dated the day after", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostInvoice(token, "2026-07-15", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
        },
      ]); // included — exactly on dateTo, tax = 50
      await createAndPostInvoice(token, "2026-07-16", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 9999,
          taxCodeId: taxCodeStandardId,
        },
      ]); // excluded — one day after dateTo

      const res = await vatPosition(token, {
        dateFrom: "2026-07-15",
        dateTo: "2026-07-15",
      }).expect(200);
      expect(res.body.meta.outputTaxMinor).toBe(50);
    });
  });

  describe("GL cross-check", () => {
    it("reconciles to zero difference in the happy path — output tax equals the tax-output account's own GL movement", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostInvoice(token, "2026-08-05", [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
        },
      ]);

      const res = await vatPosition(token, {
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
      }).expect(200);
      const check = res.body.meta.glCrossCheck;
      expect(check.taxOutputAccountId).toBe(taxOutputAccountA1Id);
      expect(check.glOutputTaxMovementMinor).toBe(res.body.meta.outputTaxMinor);
      expect(check.outputDifferenceMinor).toBe(0);
      expect(check.outputReconciled).toBe(true);
      expect(check.taxInputAccountId).toBe(taxInputAccountA1Id);
      expect(check.inputReconciled).toBe(true);
    });

    it("reports a nonzero, correctly-signed difference when a manual journal entry posts to the tax-output account outside any AR document — the exact edge case discovery §10 flags as out of this report's per-code coverage", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
      }).expect(200);
      expect(before.body.meta.glCrossCheck.outputDifferenceMinor).toBe(0);

      // A hand-posted manual journal entry crediting the tax-output
      // account directly — never touches customer_invoice_lines at all.
      const manualJe = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-09-15",
          lines: [
            { accountId: revenueAccountA1Id, debitMinor: 700, creditMinor: 0 },
            {
              accountId: taxOutputAccountA1Id,
              debitMinor: 0,
              creditMinor: 700,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${manualJe.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await vatPosition(token, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
      }).expect(200);
      // outputTaxMinor (source-line based) is unaffected by the manual
      // entry — it never touched an invoice/credit-note line.
      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor,
      );
      // But the GL movement now includes the manual credit, producing a
      // genuine, correctly-signed difference.
      expect(after.body.meta.glCrossCheck.glOutputTaxMovementMinor).toBe(
        before.body.meta.glCrossCheck.glOutputTaxMovementMinor + 700,
      );
      expect(after.body.meta.glCrossCheck.outputDifferenceMinor).toBe(-700);
      expect(after.body.meta.glCrossCheck.outputReconciled).toBe(false);
    });
  });

  describe("isolation", () => {
    it("does not leak a different legal entity's tax activity into this legal entity's report", async () => {
      const adminA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      const revenueA2Id = await createAccount(adminA2, {
        code: "VAT-A2-REV",
        name: "Revenue A2",
        type: "REVENUE",
      });
      const arA2Id = await createAccount(adminA2, {
        code: "VAT-A2-AR",
        name: "AR Control A2",
        type: "ASSET",
      });
      const taxOutA2Id = await createAccount(adminA2, {
        code: "VAT-A2-TAXOUT",
        name: "Tax Output A2",
        type: "LIABILITY",
      });
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${adminA2}`)
        .send({ arControlAccountId: arA2Id, taxOutputAccountId: taxOutA2Id })
        .expect(201);
      const customerA2 = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA2}`)
        .send({ code: `VATCUSTA2-${suffix}`, name: "A2 Customer" })
        .expect(201);
      const period2 = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminA2}`)
        .send({
          code: `VATP2-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);
      void period2;
      const taxCodeA2 = await createTaxCode(
        adminA2,
        `VAT-A2-STD-${suffix}`,
        "STANDARD",
        500,
      );

      const posterA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${posterA2}`)
        .send({
          customerId: customerA2.body.data.id,
          invoiceDate: "2026-10-05",
          lines: [
            {
              accountId: revenueA2Id,
              amountMinor: 99999,
              taxCodeId: taxCodeA2,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterA2}`)
        .expect(200);

      // Query legal entity A1's report over the same window — must be
      // entirely unaffected by A2's activity.
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      const res = await vatPosition(tokenA1, {
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
      }).expect(200);
      expect(res.body.meta.outputTaxMinor).toBe(0);
      expect(res.body.data.outputByTaxCode).toEqual([]);
    });

    it("rejects a request with no legal entity in scope (400/401 at the guard/context layer, not a data leak)", async () => {
      const tokenNoEntity = tokenFor(tenantAId, null, ["finance.viewer"]);
      const res = await vatPosition(tokenNoEntity, {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect([400, 401, 403]).toContain(res.status);
    });

    it("a cross-tenant token never sees tenant A's tax activity", async () => {
      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      const res = await vatPosition(tokenB, {
        dateFrom: "2026-03-01",
        dateTo: "2026-03-31",
      }).expect(200);
      // Tenant A posted STANDARD/ZERO_RATED/EXEMPT invoices in this exact
      // window (classification test above) — none of it must appear here.
      expect(res.body.data.outputByTaxCode).toEqual([]);
      expect(res.body.meta.outputTaxMinor).toBe(0);
    });
  });
});
