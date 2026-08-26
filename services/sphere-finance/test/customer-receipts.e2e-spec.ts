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
import {
  arSettings,
  chartOfAccounts,
  journalEntries,
  journalLines,
  customerInvoices,
  customerReceipts,
  customerReceiptAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AR-1c — Customer Receipts & Allocations
 * (docs/finance-work-item-1c-customer-receipts-proposal.md §3, §6, §7,
 * §8, §9, §10, §11). Covers RBAC, draft CRUD (create/list/get/edit/
 * delete), validation, posting (partial/full settlement, multi-invoice
 * allocation, every 422/409 failure mode), post-posting immutability at
 * the DB trigger level, cross-tenant/cross-legal-entity isolation, and
 * the audit trail. Mirrors supplier-payments.e2e-spec.ts's describe-block
 * structure exactly. Runs against a real Postgres instance. GL
 * integration/reconciliation and concurrency have their own dedicated
 * files (ar-receipt-gl-integration.e2e-spec.ts,
 * ar-receipt-concurrency.e2e-spec.ts).
 */
describe("Customer Receipts (e2e) — draft CRUD, allocation, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let revenueAccountA1Id: string;
  let arControlAccountA1Id: string; // AR control account, entity A1
  let bankAccountA1Id: string; // bank/cash ASSET account, entity A1
  let inactiveAssetAccountA1Id: string;
  let revenueAccountA2Id: string;
  let arControlAccountA2Id: string; // AR control account, entity A2
  let bankAccountA2Id: string; // bank/cash ASSET account, entity A2
  let customerA1Id: string;
  let customerA1bId: string; // second customer in A1 — cross-customer invoice test
  let customerA2Id: string; // cross-entity
  let customerBId: string; // cross-tenant
  let openPeriodA1Id: string;
  let closedPeriodA1Id: string;
  let suffix: number;

  const NO_PERIOD_DATE = "2027-06-15"; // outside every period seeded below

  function tokenFor(
    tenantId: string,
    legalEntityId: string,
    roles: string[],
    userId?: string,
  ) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  /** Creates + posts an invoice for customerId, returning {id,
   * totalMinor}. accountId defaults to entity A1's revenue account —
   * callers posting in a different legal entity must pass that entity's
   * own account (chart_of_accounts is scoped per legal entity; a
   * cross-entity accountId is rejected at invoice-creation time). */
  async function createAndPostInvoice(
    token: string,
    customerId: string,
    invoiceDate: string,
    amountMinor = 1000,
    accountId: string = revenueAccountA1Id,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate,
        lines: [{ accountId, amountMinor, taxAmountMinor: 0 }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
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
      .values({ slug: `rcpt-e2e-a-${suffix}`, name: "Receipt E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `rcpt-e2e-b-${suffix}`, name: "Receipt E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "RCPTA1",
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
        code: "RCPTA2",
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
        code: "RCPTB1",
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
        code: `RCPT-REV-A1-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arCtrlA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `RCPT-AR-CTRL-A1-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bankA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `RCPT-BANK-A1-${suffix}`,
        name: "Main Bank Account",
        type: "ASSET",
      })
      .returning();
    const [inactiveAssetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `RCPT-INACTIVE-A1-${suffix}`,
        name: "Archived Bank Account",
        type: "ASSET",
        isActive: false,
      })
      .returning();
    revenueAccountA1Id = revA1!.id;
    arControlAccountA1Id = arCtrlA1!.id;
    bankAccountA1Id = bankA1!.id;
    inactiveAssetAccountA1Id = inactiveAssetA1!.id;

    const [revA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `RCPT-REV-A2-${suffix}`,
        name: "Entity 2 Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arCtrlA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `RCPT-AR-CTRL-A2-${suffix}`,
        name: "Entity 2 Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bankA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `RCPT-BANK-A2-${suffix}`,
        name: "Entity 2 Main Bank Account",
        type: "ASSET",
      })
      .returning();
    revenueAccountA2Id = revA2!.id;
    arControlAccountA2Id = arCtrlA2!.id;
    bankAccountA2Id = bankA2!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ arControlAccountId: arControlAccountA1Id })
      .expect(201);

    const customerA1 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `RCPT-CUST-A1-${suffix}`, name: "Acme Client" })
      .expect(201);
    customerA1Id = customerA1.body.data.id;

    const customerA1b = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `RCPT-CUST-A1B-${suffix}`, name: "Second Customer" })
      .expect(201);
    customerA1bId = customerA1b.body.data.id;

    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const customerA2 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `RCPT-CUST-A2-${suffix}`, name: "Entity 2 Customer" })
      .expect(201);
    customerA2Id = customerA2.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ arControlAccountId: arControlAccountA2Id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({
        code: `RCPT-A2-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);

    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
    const customerB = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `RCPT-CUST-B-${suffix}`, name: "Tenant B Customer" })
      .expect(201);
    customerBId = customerB.body.data.id;

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPT-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPT-CLOSED-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      })
      .expect(201);
    closedPeriodA1Id = closedPeriod.body.data.id;
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closedPeriodA1Id}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/receipts")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/edit/delete/post (403)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const invoice = await createAndPostInvoice(
        posterToken,
        customerA1Id,
        "2026-02-01",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/receipts")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: 100,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 100 }],
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin can read but cannot write — same split as invoices/payments", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const invoice = await createAndPostInvoice(
        posterToken,
        customerA1Id,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(403);
    });
  });

  describe("validation at create/edit time", () => {
    it("rejects an empty allocations array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: 1000,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [],
        })
        .expect(400);
    });

    it("rejects a nonexistent customerId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: randomUUID(),
          receiptDate: "2026-02-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects a nonexistent/inactive/wrong-type bankCashAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-02-01",
      );
      const base = {
        customerId: customerA1Id,
        receiptDate: "2026-02-05",
        receiptAmountMinor: invoice.totalMinor,
        receiptMethod: "CASH",
        allocations: [
          { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
        ],
      };
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: randomUUID() })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: inactiveAssetAccountA1Id })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: revenueAccountA1Id }) // wrong type: REVENUE, not ASSET
        .expect(400);
    });

    it("rejects an allocation referencing an invoice belonging to a different customer (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1bId,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id, // receipt is for customerA1, invoice belongs to customerA1b
          receiptDate: "2026-02-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects an allocation referencing a cross-legal-entity or cross-tenant invoice (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const crossEntityInvoice = await createAndPostInvoice(
        a2Token,
        customerA2Id,
        "2026-02-01",
        1000,
        revenueAccountA2Id,
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: 1000,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: crossEntityInvoice.id, allocatedAmountMinor: 1000 },
          ],
        })
        .expect(400);
    });

    it("a cross-tenant customerId is rejected the same way a cross-entity one is (400) — RLS plus the explicit legal-entity predicate together close both angles", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerBId,
          receiptDate: "2026-02-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects a zero/negative receiptAmountMinor at the DTO level (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-02-05",
          receiptAmountMinor: 0,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 100 }],
        })
        .expect(400);
    });
  });

  describe("draft CRUD", () => {
    it("creates a receipt: stores fields, DRAFT status, null internalReference", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-03-01",
        1500,
      );
      const res = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-03-05",
          receiptAmountMinor: 1500,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          reference: "TRF-0001",
          memo: "March settlement",
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 1500 }],
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.receiptAmountMinor).toBe(1500);
      expect(res.body.data.reference).toBe("TRF-0001");
      expect(res.body.data.allocations).toHaveLength(1);
    });

    it("404s (not 403) on a nonexistent id and on a cross-legal-entity id within the same tenant", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/receipts/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const invoiceA2 = await createAndPostInvoice(
        a2Token,
        customerA2Id,
        "2026-03-01",
        1000,
        revenueAccountA2Id,
      );
      const createdA2 = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${a2Token}`)
        .send({
          customerId: customerA2Id,
          receiptDate: "2026-03-05",
          receiptAmountMinor: invoiceA2.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA2Id,
          allocations: [
            {
              invoiceId: invoiceA2.id,
              allocatedAmountMinor: invoiceA2.totalMinor,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/receipts/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("list filters by status, customerId, dateFrom/dateTo", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-05-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-05-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(201);

      const byCustomer = await request(app.getHttpServer())
        .get(`/v1/finance/receipts?customerId=${customerA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byCustomer.body.data.every(
          (r: { customerId: string }) => r.customerId === customerA1Id,
        ),
      ).toBe(true);

      const byStatus = await request(app.getHttpServer())
        .get("/v1/finance/receipts?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byStatus.body.data.every(
          (r: { status: string }) => r.status === "DRAFT",
        ),
      ).toBe(true);

      const byDate = await request(app.getHttpServer())
        .get("/v1/finance/receipts?dateFrom=2026-05-01&dateTo=2026-05-31")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(byDate.body.data.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .get("/v1/finance/receipts?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("GET /invoices?paymentStatus= filters invoices by payment status", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-05-10",
        1000,
      );
      const unpaid = await request(app.getHttpServer())
        .get(
          `/v1/finance/invoices?paymentStatus=UNPAID&customerId=${customerA1Id}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        unpaid.body.data.some((i: { id: string }) => i.id === invoice.id),
      ).toBe(true);

      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-05-11",
          receiptAmountMinor: 1000,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 1000 }],
        })
        .then((res) =>
          request(app.getHttpServer())
            .post(`/v1/finance/receipts/${res.body.data.id}/post`)
            .set("Authorization", `Bearer ${token}`)
            .expect(200),
        );

      const paid = await request(app.getHttpServer())
        .get(
          `/v1/finance/invoices?paymentStatus=PAID&customerId=${customerA1Id}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        paid.body.data.some((i: { id: string }) => i.id === invoice.id),
      ).toBe(true);

      await request(app.getHttpServer())
        .get("/v1/finance/invoices?paymentStatus=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("edit: header-only PATCH leaves allocations untouched; full-array allocation replacement", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoiceOne = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-03-01",
        1000,
      );
      const invoiceTwo = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-03-02",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-03-05",
          receiptAmountMinor: 1000,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoiceOne.id, allocatedAmountMinor: 1000 },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      const headerOnly = await request(app.getHttpServer())
        .patch(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(headerOnly.body.data.memo).toBe("Updated memo");
      expect(headerOnly.body.data.allocations).toHaveLength(1);

      const replaced = await request(app.getHttpServer())
        .patch(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          receiptAmountMinor: 1500,
          allocations: [
            { invoiceId: invoiceOne.id, allocatedAmountMinor: 1000 },
            { invoiceId: invoiceTwo.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(200);
      expect(replaced.body.data.allocations).toHaveLength(2);
      expect(replaced.body.data.receiptAmountMinor).toBe(1500);
    });

    it("delete: DRAFT only, allocations cascade", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-03-01",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-03-05",
          receiptAmountMinor: invoice.totalMinor,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoice.id, allocatedAmountMinor: invoice.totalMinor },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const allocations = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, id)),
      );
      expect(allocations).toHaveLength(0);
    });
  });

  describe("posting — POST /receipts/:id/post", () => {
    it("full settlement: allocates the entire invoice outstanding, invoice becomes PAID", async () => {
      const posterId = randomUUID();
      const token = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-01",
        2000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-05",
          receiptAmountMinor: 2000,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 2000 }],
        })
        .expect(201);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^RCT-\d{6}$/);
      expect(posted.body.data.periodId).toBe(openPeriodA1Id);
      expect(posted.body.data.postedBy).toBe(posterId);
      expect(posted.body.data.journalEntryId).toBeTruthy();

      const je = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, posted.body.data.journalEntryId))
          .then((rows) => rows[0]),
      );
      expect(je!.journalNumber).toMatch(/^JE-\d{6}$/);
      expect(je!.status).toBe("POSTED");

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalLines)
          .where(
            eq(journalLines.journalEntryId, posted.body.data.journalEntryId),
          ),
      );
      expect(lines).toHaveLength(2);
      const debitLine = lines.find((l) => l.accountId === bankAccountA1Id);
      const creditLine = lines.find(
        (l) => l.accountId === arControlAccountA1Id,
      );
      expect(debitLine!.debitMinor).toBe(2000);
      expect(creditLine!.creditMinor).toBe(2000);

      const settledInvoice = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id))
          .then((rows) => rows[0]!),
      );
      expect(settledInvoice.paidMinor).toBe(2000);
      expect(settledInvoice.paymentStatus).toBe("PAID");
    });

    it("partial settlement: allocates less than the invoice's total, invoice becomes PARTIALLY_PAID", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-02",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-05",
          receiptAmountMinor: 400,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 400 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const settledInvoice = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id))
          .then((rows) => rows[0]!),
      );
      expect(settledInvoice.paidMinor).toBe(400);
      expect(settledInvoice.paymentStatus).toBe("PARTIALLY_PAID");

      // A second receipt completes settlement.
      const second = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-06",
          receiptAmountMinor: 600,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${second.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const fullySettledInvoice = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id))
          .then((rows) => rows[0]!),
      );
      expect(fullySettledInvoice.paidMinor).toBe(1000);
      expect(fullySettledInvoice.paymentStatus).toBe("PAID");
    });

    it("multiple-invoice allocation: one receipt settles two invoices in a single post()", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoiceOne = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-10",
        700,
      );
      const invoiceTwo = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-11",
        300,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-12",
          receiptAmountMinor: 1000,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: invoiceOne.id, allocatedAmountMinor: 700 },
            { invoiceId: invoiceTwo.id, allocatedAmountMinor: 300 },
          ],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalLines)
          .where(
            eq(journalLines.journalEntryId, posted.body.data.journalEntryId),
          ),
      );
      // Still a 2-line entry — allocations don't create extra JE lines,
      // only ONE credit to AR control for the full receipt amount.
      expect(lines).toHaveLength(2);

      const [settledOne, settledTwo] = await withTenant(tenantAId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(customerInvoices)
            .where(eq(customerInvoices.id, invoiceOne.id))
            .then((rows) => rows[0]!),
          tx
            .select()
            .from(customerInvoices)
            .where(eq(customerInvoices.id, invoiceTwo.id))
            .then((rows) => rows[0]!),
        ]),
      );
      expect(settledOne.paidMinor).toBe(700);
      expect(settledOne.paymentStatus).toBe("PAID");
      expect(settledTwo.paidMinor).toBe(300);
      expect(settledTwo.paymentStatus).toBe("PAID");
    });

    it("422 when a single invoice's allocation exceeds its outstanding balance", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-15",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-16",
          receiptAmountMinor: 600,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when the sum of allocations does not equal the receipt amount", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-17",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-18",
          receiptAmountMinor: 1000,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 400 }], // < 1000
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when posting against a DRAFT (not yet posted) invoice", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const draftInvoice = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-19",
          lines: [
            {
              accountId: revenueAccountA1Id,
              amountMinor: 500,
              taxAmountMinor: 0,
            },
          ],
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-20",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            {
              invoiceId: draftInvoice.body.data.id,
              allocatedAmountMinor: 500,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("re-validates the bank/cash account at posting time — rejects (422) an account archived after draft creation", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const financeDb = getFinanceDb();
      const [toArchive] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantAId,
          legalEntityId: legalEntityA1Id,
          code: `RCPT-ARCHIVABLE-${suffix}`,
          name: "Archived After Draft",
          type: "ASSET",
        })
        .returning();

      const invoice = await createAndPostInvoice(
        posterToken,
        customerA1Id,
        "2026-06-21",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-22",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: toArchive!.id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${toArchive!.id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(422);
    });

    it("422 with no covering accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-23",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: NO_PERIOD_DATE,
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with a covering but CLOSED accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      // The INVOICE posts fine (dated inside the OPEN period) — only the
      // RECEIPT is dated inside the closed period, isolating the
      // closed-period check to the receipt's own posting attempt.
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-30",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2025-01-15",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when AR settings are not configured for the legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      // Entity A2's AR settings must exist for the INVOICE to post
      // (invoice posting also debits/credits the AR control account) —
      // so this test posts the invoice normally, then removes AR
      // settings before attempting to post the RECEIPT, isolating the
      // missing-settings check to the receipt's own posting attempt
      // (re-validated independently, same posture as the bank/cash
      // account re-validation test above).
      const invoice = await createAndPostInvoice(
        token,
        customerA2Id,
        "2026-06-01",
        500,
        revenueAccountA2Id,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA2Id,
          receiptDate: "2026-06-05",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA2Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);

      const financeDb = getFinanceDb();
      await financeDb
        .delete(arSettings)
        .where(
          and(
            eq(arSettings.tenantId, tenantAId),
            eq(arSettings.legalEntityId, legalEntityA2Id),
          ),
        );

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      // Restore for any later test in this file that relies on entity
      // A2 having AR settings configured.
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({ arControlAccountId: arControlAccountA2Id })
        .expect(201);
    });

    it("409 when posting an already-POSTED receipt", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-24",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-25",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("409 on edit/delete of a POSTED receipt (clean error, not a raw trigger error)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-06-26",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-06-27",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "attempted edit" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });
  });

  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostReceipt(): Promise<string> {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-07-01",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-07-02",
          receiptAmountMinor: 500,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE of any column on a POSTED customer_receipts row — zero exceptions", async () => {
      const id = await createAndPostReceipt();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(customerReceipts)
            .set({ memo: "bypassing the service layer" })
            .where(eq(customerReceipts.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects a raw DELETE of a POSTED customer_receipts row", async () => {
      const id = await createAndPostReceipt();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(customerReceipts).where(eq(customerReceipts.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects INSERT/UPDATE/DELETE of customer_receipt_allocations once the parent receipt is POSTED — zero exceptions", async () => {
      const id = await createAndPostReceipt();
      const existingAllocation = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(customerReceiptAllocations)
            .set({ allocatedAmountMinor: 9999 })
            .where(eq(customerReceiptAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_receipts is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(customerReceiptAllocations)
            .where(eq(customerReceiptAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_receipts is POSTED/,
      );

      const otherInvoice = await createAndPostInvoice(
        tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]),
        customerA1Id,
        "2026-07-03",
        200,
      );
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(customerReceiptAllocations).values({
            tenantId: tenantAId,
            receiptId: id,
            invoiceId: otherInvoice.id,
            allocatedAmountMinor: 200,
          }),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_receipts is POSTED/,
      );
    });
  });

  describe("audit trail", () => {
    it("writes CREATE/UPDATE/DELETE/POST rows on the receipt, a linked journal_entry CREATE row, and an UPDATE row per settled invoice", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const invoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-08-01",
        750,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-08-02",
          receiptAmountMinor: 750,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 750 }],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/receipts/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const receiptRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "customer_receipt"),
          ),
        );
      const actions = receiptRows.map((r) => r.action).sort();
      expect(actions).toEqual(["CREATE", "POST", "UPDATE"]);

      const jeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, posted.body.data.journalEntryId),
            eq(auditLogs.entityType, "journal_entry"),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(jeRows).toHaveLength(1);

      const invoiceAuditRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, invoice.id),
            eq(auditLogs.entityType, "customer_invoice"),
            eq(auditLogs.action, "UPDATE"),
          ),
        );
      expect(invoiceAuditRows).toHaveLength(1);
      const afterState = invoiceAuditRows[0]!.afterState as {
        paidMinor: number;
        paymentStatus: string;
      };
      expect(afterState.paidMinor).toBe(750);
      expect(afterState.paymentStatus).toBe("PAID");

      // Now delete a fresh DRAFT receipt and confirm the DELETE row.
      const anotherInvoice = await createAndPostInvoice(
        token,
        customerA1Id,
        "2026-08-03",
        200,
      );
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          receiptDate: "2026-08-04",
          receiptAmountMinor: 200,
          receiptMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { invoiceId: anotherInvoice.id, allocatedAmountMinor: 200 },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/receipts/${draft.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const deleteRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, draft.body.data.id),
            eq(auditLogs.action, "DELETE"),
          ),
        );
      expect(deleteRows).toHaveLength(1);
    });
  });
});
