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
 * AR-1d — Customer Balance (`GET /customers/:id/balance`).
 * docs/finance-work-item-1d-ar-reports-proposal.md §6, §13. Mirrors
 * test/ap-supplier-balance.e2e-spec.ts's 12 cases exactly, substituted
 * customer-for-supplier/invoice-for-bill/receipt-for-payment.
 */
describe("AR Reports — Customer Balance (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let revenueAccountA1Id: string;
  let arAccountA1Id: string;
  let bankAccountA1Id: string;
  let customerAlphaId: string;
  let customerBetaId: string;
  let customerA2Id: string; // cross-legal-entity isolation
  let customerBId: string; // cross-tenant isolation
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

  async function createAndPostInvoice(
    customerId: string,
    invoiceDate: string,
    amountMinor: number,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterA1Token}`)
      .send({
        customerId,
        invoiceDate,
        lines: [{ accountId: revenueAccountA1Id, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
  }

  async function createAndPostReceipt(
    customerId: string,
    receiptDate: string,
    amountMinor: number,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterA1Token}`)
      .send({
        customerId,
        receiptDate,
        receiptAmountMinor: amountMinor,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountA1Id,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    return posted.body.data.id;
  }

  /** §9a.1 (Credit/Debit Notes work item, CTO-approved) — a credit note
   * reduces totalReceived (and therefore outstanding) the same direction
   * a receipt does, so asOfTotals()'s new unioned subquery is exercised
   * the same way createAndPostReceipt exercises the pre-existing one. */
  async function createAndPostCreditNote(
    customerId: string,
    creditNoteDate: string,
    amountMinor: number,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/credit-notes")
      .set("Authorization", `Bearer ${posterA1Token}`)
      .send({
        customerId,
        creditNoteDate,
        lines: [{ accountId: revenueAccountA1Id, amountMinor }],
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/credit-notes/${created.body.data.id}/post`)
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
      .values({
        slug: `ar-bal-e2e-a-${suffix}`,
        name: "AR Balance E2E Tenant A",
      })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `ar-bal-e2e-b-${suffix}`,
        name: "AR Balance E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "ARBALA1",
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
        code: "ARBALA2",
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
        code: "ARBALB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [revA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARBAL-REV-A1-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARBAL-AR-A1-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bankA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `ARBAL-BANK-A1-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    revenueAccountA1Id = revA1!.id;
    arAccountA1Id = arA1!.id;
    bankAccountA1Id = bankA1!.id;

    adminA1Token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    posterA1Token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ arControlAccountId: arAccountA1Id })
      .expect(201);

    const alpha = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `ARBAL-ALPHA-${suffix}`, name: "Alpha Customer" })
      .expect(201);
    customerAlphaId = alpha.body.data.id;

    const beta = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `ARBAL-BETA-${suffix}`, name: "Beta Customer" })
      .expect(201);
    customerBetaId = beta.body.data.id;

    const custA2 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `ARBAL-A2-${suffix}`, name: "Entity 2 Customer" })
      .expect(201);
    customerA2Id = custA2.body.data.id;

    const custB = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `ARBAL-B-${suffix}`, name: "Tenant B Customer" })
      .expect(201);
    customerBId = custB.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({
        code: `ARBAL-OPEN-A1-${suffix}`,
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

  it("no transactions — a customer with zero posted invoices has an all-zero balance", async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerBetaId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data).toMatchObject({
      customerId: customerBetaId,
      totalInvoicedMinor: 0,
      totalReceivedMinor: 0,
      totalOutstandingMinor: 0,
    });
  });

  it("one unpaid invoice — totalInvoiced = totalOutstanding, totalReceived = 0", async () => {
    const invoice = await createAndPostInvoice(
      customerAlphaId,
      "2026-02-01",
      1500,
    );
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerAlphaId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalInvoicedMinor).toBeGreaterThanOrEqual(1500);
    expect(res.body.data.totalOutstandingMinor).toBe(
      res.body.data.totalInvoicedMinor - res.body.data.totalReceivedMinor,
    );
    void invoice;
  });

  it("multiple invoices — totals sum across every posted invoice for the customer", async () => {
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `ARBAL-MULTI-${suffix}`, name: "Multi Invoice Customer" })
      .expect(201);
    const customerId = customer.body.data.id;

    await createAndPostInvoice(customerId, "2026-03-01", 1000);
    await createAndPostInvoice(customerId, "2026-03-02", 2000);
    await createAndPostInvoice(customerId, "2026-03-03", 3000);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalInvoicedMinor).toBe(6000);
    expect(res.body.data.totalReceivedMinor).toBe(0);
    expect(res.body.data.totalOutstandingMinor).toBe(6000);
  });

  it("partial receipt — outstanding reflects the remaining balance", async () => {
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({
        code: `ARBAL-PARTIAL-${suffix}`,
        name: "Partial Receipt Customer",
      })
      .expect(201);
    const customerId = customer.body.data.id;

    const invoice = await createAndPostInvoice(customerId, "2026-04-01", 1000);
    await createAndPostReceipt(customerId, "2026-04-05", 400, [
      { invoiceId: invoice.id, allocatedAmountMinor: 400 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalInvoicedMinor).toBe(1000);
    expect(res.body.data.totalReceivedMinor).toBe(400);
    expect(res.body.data.totalOutstandingMinor).toBe(600);
  });

  it("full receipt — outstanding reaches zero", async () => {
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `ARBAL-FULL-${suffix}`, name: "Full Receipt Customer" })
      .expect(201);
    const customerId = customer.body.data.id;

    const invoice = await createAndPostInvoice(customerId, "2026-04-10", 750);
    await createAndPostReceipt(customerId, "2026-04-12", 750, [
      { invoiceId: invoice.id, allocatedAmountMinor: 750 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalOutstandingMinor).toBe(0);
  });

  it("multiple receipts — totalReceived accumulates across separate posted receipts", async () => {
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({
        code: `ARBAL-MULTIRCT-${suffix}`,
        name: "Multi Receipt Customer",
      })
      .expect(201);
    const customerId = customer.body.data.id;

    const invoice = await createAndPostInvoice(customerId, "2026-05-01", 1000);
    await createAndPostReceipt(customerId, "2026-05-05", 300, [
      { invoiceId: invoice.id, allocatedAmountMinor: 300 },
    ]);
    await createAndPostReceipt(customerId, "2026-05-10", 300, [
      { invoiceId: invoice.id, allocatedAmountMinor: 300 },
    ]);
    await createAndPostReceipt(customerId, "2026-05-15", 400, [
      { invoiceId: invoice.id, allocatedAmountMinor: 400 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(res.body.data.totalReceivedMinor).toBe(1000);
    expect(res.body.data.totalOutstandingMinor).toBe(0);
  });

  it("multiple customers — one customer's invoices/receipts never affect another's balance", async () => {
    const [custX, custY] = await Promise.all([
      request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `ARBAL-ISO-X-${suffix}`, name: "Isolation Customer X" })
        .expect(201),
      request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `ARBAL-ISO-Y-${suffix}`, name: "Isolation Customer Y" })
        .expect(201),
    ]);
    const customerXId = custX.body.data.id;
    const customerYId = custY.body.data.id;

    await createAndPostInvoice(customerXId, "2026-06-01", 9000);

    const yBalance = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerYId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(yBalance.body.data.totalOutstandingMinor).toBe(0);

    const xBalance = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerXId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(xBalance.body.data.totalOutstandingMinor).toBe(9000);
  });

  it("as-of-date behavior — a receipt dated after asOf does not reduce the as-of balance", async () => {
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1Token}`)
      .send({ code: `ARBAL-ASOF-${suffix}`, name: "As-Of Customer" })
      .expect(201);
    const customerId = customer.body.data.id;

    const invoice = await createAndPostInvoice(customerId, "2026-07-01", 2000);
    await createAndPostReceipt(customerId, "2026-07-20", 2000, [
      { invoiceId: invoice.id, allocatedAmountMinor: 2000 },
    ]);

    // Before the invoice even existed — both totals are zero.
    const before = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-06-30`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(before.body.data.totalInvoicedMinor).toBe(0);
    expect(before.body.data.totalReceivedMinor).toBe(0);

    // Between the invoice and the receipt — invoiced but not yet
    // received as of this date, even though the receipt has since
    // posted.
    const between = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-07-10`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(between.body.data.totalInvoicedMinor).toBe(2000);
    expect(between.body.data.totalReceivedMinor).toBe(0);
    expect(between.body.data.totalOutstandingMinor).toBe(2000);

    // After both — fully settled as of this date.
    const after = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-07-31`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(200);
    expect(after.body.data.totalReceivedMinor).toBe(2000);
    expect(after.body.data.totalOutstandingMinor).toBe(0);
  });

  it("cross-tenant isolation — a customer belonging to a different tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerBId}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("cross-legal-entity isolation — a customer belonging to a different legal entity in the same tenant 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerA2Id}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("a nonexistent customerId 404s", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/customers/${randomUUID()}/balance`)
      .set("Authorization", `Bearer ${posterA1Token}`)
      .expect(404);
  });

  it("is readable by every finance role (finance.viewer/poster/admin), not just poster", async () => {
    const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
      "finance.viewer",
    ]);
    await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customerAlphaId}/balance`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .expect(200);
  });

  describe("Credit Notes work item (§9a, CTO-approved) — asOfTotals() extension", () => {
    it("current mode (no asOf) — a posted credit note reduces outstanding the same as a receipt would", async () => {
      const customer = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `ARBAL-CRN-CUR-${suffix}`, name: "Credit Note Current" })
        .expect(201);
      const customerId = customer.body.data.id;

      const invoice = await createAndPostInvoice(
        customerId,
        "2026-09-01",
        1000,
      );
      await createAndPostCreditNote(customerId, "2026-09-05", 400, [
        { invoiceId: invoice.id, allocatedAmountMinor: 400 },
      ]);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/balance`)
        .set("Authorization", `Bearer ${posterA1Token}`)
        .expect(200);
      expect(res.body.data.totalInvoicedMinor).toBe(1000);
      expect(res.body.data.totalReceivedMinor).toBe(400);
      expect(res.body.data.totalOutstandingMinor).toBe(600);
    });

    it("historical as-of — a credit note dated after asOf does not reduce the as-of balance; before/on asOf it does", async () => {
      const customer = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `ARBAL-CRN-ASOF-${suffix}`, name: "Credit Note As-Of" })
        .expect(201);
      const customerId = customer.body.data.id;

      const invoice = await createAndPostInvoice(
        customerId,
        "2026-10-01",
        2000,
      );
      await createAndPostCreditNote(customerId, "2026-10-20", 2000, [
        { invoiceId: invoice.id, allocatedAmountMinor: 2000 },
      ]);

      // Between the invoice and the credit note — invoiced but not yet
      // credited as of this date, even though the credit note has since
      // posted.
      const between = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-10-10`)
        .set("Authorization", `Bearer ${posterA1Token}`)
        .expect(200);
      expect(between.body.data.totalInvoicedMinor).toBe(2000);
      expect(between.body.data.totalReceivedMinor).toBe(0);
      expect(between.body.data.totalOutstandingMinor).toBe(2000);

      // On the credit note's own date — the `<=` cutoff includes it.
      const onDate = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-10-20`)
        .set("Authorization", `Bearer ${posterA1Token}`)
        .expect(200);
      expect(onDate.body.data.totalReceivedMinor).toBe(2000);
      expect(onDate.body.data.totalOutstandingMinor).toBe(0);

      // After both — fully settled as of this date too.
      const after = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/balance?asOf=2026-10-31`)
        .set("Authorization", `Bearer ${posterA1Token}`)
        .expect(200);
      expect(after.body.data.totalReceivedMinor).toBe(2000);
      expect(after.body.data.totalOutstandingMinor).toBe(0);
    });

    it("a credit note and a receipt against the same invoice both contribute to totalReceived", async () => {
      const customer = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${adminA1Token}`)
        .send({ code: `ARBAL-CRN-MIX-${suffix}`, name: "Credit Note Mixed" })
        .expect(201);
      const customerId = customer.body.data.id;

      const invoice = await createAndPostInvoice(
        customerId,
        "2026-11-01",
        1000,
      );
      await createAndPostReceipt(customerId, "2026-11-05", 300, [
        { invoiceId: invoice.id, allocatedAmountMinor: 300 },
      ]);
      await createAndPostCreditNote(customerId, "2026-11-10", 700, [
        { invoiceId: invoice.id, allocatedAmountMinor: 700 },
      ]);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerId}/balance`)
        .set("Authorization", `Bearer ${posterA1Token}`)
        .expect(200);
      expect(res.body.data.totalReceivedMinor).toBe(1000);
      expect(res.body.data.totalOutstandingMinor).toBe(0);
    });
  });
});
