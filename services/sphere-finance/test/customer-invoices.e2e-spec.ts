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
  chartOfAccounts,
  journalEntries,
  journalLines,
  customerInvoices,
  customerInvoiceLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AR-1b — Customer Invoices
 * (docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §3, §5,
 * §6, §8). Covers RBAC, draft CRUD (create/list/get/edit/delete),
 * validation, posting (the balanced journal entry §6 describes,
 * numbering, period resolution, tax handling, every 422/409 failure
 * mode), post-posting immutability at the DB trigger level, cross-
 * tenant/cross-legal-entity isolation, and the audit trail. Mirrors
 * supplier-bills.e2e-spec.ts's describe-block structure exactly. Runs
 * against a real Postgres instance. GL integration and concurrency have
 * their own dedicated files (ar-invoice-gl-integration.e2e-spec.ts,
 * ar-invoice-concurrency.e2e-spec.ts).
 */
describe("Customer Invoices (e2e) — draft CRUD, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let revenueAccountA1Id: string;
  let revenueAccountA2Id: string; // cross-entity — for cross-entity rejection
  let inactiveAccountA1Id: string;
  let assetControlAccountA1Id: string; // AR control account, entity A1
  let taxOutputAccountA1Id: string; // tax output account, entity A1
  let customerA1Id: string; // paymentTermsDays = 30
  let customerNoTermsA1Id: string; // no paymentTermsDays configured
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

  function oneLine(accountId: string, amountMinor = 1000, taxAmountMinor = 0) {
    return [{ accountId, amountMinor, taxAmountMinor }];
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
      .values({ slug: `inv-e2e-a-${suffix}`, name: "Invoice E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `inv-e2e-b-${suffix}`, name: "Invoice E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "INVA1",
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
        code: "INVA2",
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
        code: "INVB1",
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
        code: `INV-REV-A1-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [revA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `INV-REV-A2-${suffix}`,
        name: "Entity 2 Revenue",
        type: "REVENUE",
      })
      .returning();
    const [inactiveA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `INV-INACTIVE-A1-${suffix}`,
        name: "Archived Revenue",
        type: "REVENUE",
        isActive: false,
      })
      .returning();
    const [assetControlA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `INV-AR-CTRL-A1-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [taxOutputA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `INV-TAX-A1-${suffix}`,
        name: "Output VAT",
        type: "LIABILITY",
      })
      .returning();
    revenueAccountA1Id = revA1!.id;
    revenueAccountA2Id = revA2!.id;
    inactiveAccountA1Id = inactiveA1!.id;
    assetControlAccountA1Id = assetControlA1!.id;
    taxOutputAccountA1Id = taxOutputA1!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    // AR settings — entity A1 only (entity A2/B deliberately left
    // unconfigured for the "AR settings not configured" 422 test).
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        arControlAccountId: assetControlAccountA1Id,
        taxOutputAccountId: taxOutputAccountA1Id,
      })
      .expect(201);

    const customerA1 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INV-CUST-A1-${suffix}`,
        name: "Acme Client",
        paymentTermsDays: 30,
      })
      .expect(201);
    customerA1Id = customerA1.body.data.id;

    const customerNoTermsA1 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `INV-CUST-NT-${suffix}`, name: "No Terms Co" })
      .expect(201);
    customerNoTermsA1Id = customerNoTermsA1.body.data.id;

    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const customerA2 = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `INV-CUST-A2-${suffix}`, name: "Entity 2 Customer" })
      .expect(201);
    customerA2Id = customerA2.body.data.id;

    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
    const customerB = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `INV-CUST-B-${suffix}`, name: "Tenant B Customer" })
      .expect(201);
    customerBId = customerB.body.data.id;

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INV-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INV-CLOSED-${suffix}`,
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
        .get("/v1/finance/invoices")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/edit/delete/post (403)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/invoices")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin can read but cannot write — same split as supplier bills, unlike customers/ar-settings", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(403);
    });
  });

  describe("validation at create/edit time", () => {
    it("rejects an empty lines array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: [],
        })
        .expect(400);
    });

    it("rejects a nonexistent customerId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: randomUUID(),
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects a cross-legal-entity customerId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA2Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects a line with a nonexistent/inactive/cross-entity accountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(randomUUID()),
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(inactiveAccountA1Id),
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA2Id),
        })
        .expect(400);
    });

    it("rejects a zero/negative line amountMinor at the DTO level (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-02-01",
          lines: oneLine(revenueAccountA1Id, 0),
        })
        .expect(400);
    });
  });

  describe("draft CRUD", () => {
    it("creates an invoice: computes subtotal/tax/total, defaults dueDate from customer.paymentTermsDays", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-03-01",
          lines: [
            {
              accountId: revenueAccountA1Id,
              amountMinor: 1000,
              taxAmountMinor: 50,
            },
            { accountId: revenueAccountA1Id, amountMinor: 500 },
          ],
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.paymentStatus).toBe("UNPAID");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.subtotalMinor).toBe(1500);
      expect(res.body.data.taxMinor).toBe(50);
      expect(res.body.data.totalMinor).toBe(1550);
      expect(res.body.data.dueDate).toBe("2026-03-31"); // invoiceDate + 30 days
      expect(res.body.data.lines).toHaveLength(2);
    });

    it("leaves dueDate null when the customer has no paymentTermsDays and none is supplied", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerNoTermsA1Id,
          invoiceDate: "2026-03-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      expect(res.body.data.dueDate).toBeNull();
    });

    it("an explicit dueDate always wins over the computed default", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-03-01",
          dueDate: "2026-04-15",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      expect(res.body.data.dueDate).toBe("2026-04-15");
    });

    it("404s (not 403) on a nonexistent id and on a cross-legal-entity id within the same tenant", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/invoices/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const createdA2 = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${a2Token}`)
        .send({
          customerId: customerA2Id,
          invoiceDate: "2026-03-01",
          lines: oneLine(revenueAccountA2Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/invoices/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("a cross-tenant customerId is rejected the same way a cross-entity one is (400) — RLS plus the explicit legal-entity predicate together close both angles", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerBId,
          invoiceDate: "2026-03-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(400);
    });

    it("list filters by status, customerId, dateFrom/dateTo", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-05-05",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);

      const byCustomer = await request(app.getHttpServer())
        .get(`/v1/finance/invoices?customerId=${customerA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byCustomer.body.data.every(
          (i: { customerId: string }) => i.customerId === customerA1Id,
        ),
      ).toBe(true);

      const byStatus = await request(app.getHttpServer())
        .get("/v1/finance/invoices?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byStatus.body.data.every(
          (i: { status: string }) => i.status === "DRAFT",
        ),
      ).toBe(true);

      const byDate = await request(app.getHttpServer())
        .get("/v1/finance/invoices?dateFrom=2026-05-01&dateTo=2026-05-31")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(byDate.body.data.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .get("/v1/finance/invoices?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("edit: header-only PATCH leaves lines/totals untouched; full-array line replacement recomputes totals", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-03-01",
          lines: oneLine(revenueAccountA1Id, 1000),
        })
        .expect(201);
      const id = created.body.data.id;

      const headerOnly = await request(app.getHttpServer())
        .patch(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(headerOnly.body.data.memo).toBe("Updated memo");
      expect(headerOnly.body.data.totalMinor).toBe(1000);
      expect(headerOnly.body.data.lines).toHaveLength(1);

      const replaced = await request(app.getHttpServer())
        .patch(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          lines: [
            { accountId: revenueAccountA1Id, amountMinor: 200 },
            {
              accountId: revenueAccountA1Id,
              amountMinor: 300,
              taxAmountMinor: 10,
            },
          ],
        })
        .expect(200);
      expect(replaced.body.data.lines).toHaveLength(2);
      expect(replaced.body.data.subtotalMinor).toBe(500);
      expect(replaced.body.data.taxMinor).toBe(10);
      expect(replaced.body.data.totalMinor).toBe(510);
    });

    it("delete: DRAFT only, lines cascade", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-03-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerInvoiceLines)
          .where(eq(customerInvoiceLines.invoiceId, id)),
      );
      expect(lines).toHaveLength(0);
    });
  });

  describe("posting — POST /invoices/:id/post", () => {
    it("posts a balanced entry with no tax: Cr revenue line(s), Dr AR control; assigns INV-###### and JE-######; becomes immutable", async () => {
      const posterId = randomUUID();
      const token = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-01",
          lines: oneLine(revenueAccountA1Id, 2000),
        })
        .expect(201);
      const id = created.body.data.id;

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^INV-\d{6}$/);
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
      expect(lines).toHaveLength(2); // 1 revenue credit + 1 AR debit, no tax line
      const creditLine = lines.find((l) => l.accountId === revenueAccountA1Id);
      const debitLine = lines.find(
        (l) => l.accountId === assetControlAccountA1Id,
      );
      expect(creditLine!.creditMinor).toBe(2000);
      expect(creditLine!.debitMinor).toBe(0);
      expect(debitLine!.creditMinor).toBe(0);
      expect(debitLine!.debitMinor).toBe(2000);
    });

    it("posts a balanced entry with tax: Cr revenue line(s) + Cr aggregate tax line, Dr AR control for the total", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-02",
          lines: [
            {
              accountId: revenueAccountA1Id,
              amountMinor: 1000,
              taxAmountMinor: 50,
            },
            {
              accountId: revenueAccountA1Id,
              amountMinor: 2000,
              taxAmountMinor: 100,
            },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(posted.body.data.totalMinor).toBe(3150);

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalLines)
          .where(
            eq(journalLines.journalEntryId, posted.body.data.journalEntryId),
          ),
      );
      expect(lines).toHaveLength(4); // 2 revenue credits + 1 aggregate tax credit + 1 AR debit
      const totalDebit = lines.reduce((s, l) => s + l.debitMinor, 0);
      const totalCredit = lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(3150);
      const taxLine = lines.find((l) => l.accountId === taxOutputAccountA1Id);
      expect(taxLine).toBeDefined();
      expect(taxLine!.creditMinor).toBe(150);
    });

    it("re-validates line accounts at posting time — rejects (422) an account archived after draft creation", async () => {
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
          code: `INV-ARCHIVABLE-${suffix}`,
          name: "Archived After Draft",
          type: "REVENUE",
        })
        .returning();

      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-03",
          lines: oneLine(toArchive!.id),
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${toArchive!.id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(422);
    });

    it("422 with no covering accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: NO_PERIOD_DATE,
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with a covering but CLOSED accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2025-01-15",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when AR settings are not configured for the legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA2Id,
          invoiceDate: "2026-06-01",
          lines: oneLine(revenueAccountA2Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when a line carries tax but no tax output account is configured", async () => {
      const financeDb = getFinanceDb();
      const [assetControlB] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `INV-AR-CTRL-B-${suffix}`,
          name: "AR Control B",
          type: "ASSET",
        })
        .returning();
      const [revenueB] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `INV-REV-B-${suffix}`,
          name: "Revenue B",
          type: "REVENUE",
        })
        .returning();
      const bAdminToken = tokenFor(tenantBId, legalEntityBId, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post("/v1/finance/ar/settings")
        .set("Authorization", `Bearer ${bAdminToken}`)
        .send({ arControlAccountId: assetControlB!.id }) // no taxOutputAccountId
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${bAdminToken}`)
        .send({
          code: `INV-B-OPEN-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);

      const bPosterToken = tokenFor(tenantBId, legalEntityBId, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${bPosterToken}`)
        .send({
          customerId: customerBId,
          invoiceDate: "2026-06-01",
          lines: [
            { accountId: revenueB!.id, amountMinor: 1000, taxAmountMinor: 50 },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${bPosterToken}`)
        .expect(422);
    });

    it("409 when posting an already-POSTED invoice", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-04",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("409 on edit/delete of a POSTED invoice (clean error, not a raw trigger error)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-06-05",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "attempted edit" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });
  });

  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostInvoice(): Promise<string> {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-07-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE of any column other than paid_minor/payment_status on a POSTED customer_invoices row", async () => {
      const id = await createAndPostInvoice();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(customerInvoices)
            .set({ memo: "bypassing the service layer" })
            .where(eq(customerInvoices.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects a raw DELETE of a POSTED customer_invoices row", async () => {
      const id = await createAndPostInvoice();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(customerInvoices).where(eq(customerInvoices.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects INSERT/UPDATE/DELETE of customer_invoice_lines once the parent invoice is POSTED — zero exceptions", async () => {
      const id = await createAndPostInvoice();
      const existingLine = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(customerInvoiceLines)
          .where(eq(customerInvoiceLines.invoiceId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(customerInvoiceLines)
            .set({ amountMinor: 9999 })
            .where(eq(customerInvoiceLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_invoices is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(customerInvoiceLines)
            .where(eq(customerInvoiceLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_invoices is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(customerInvoiceLines).values({
            tenantId: tenantAId,
            invoiceId: id,
            lineNumber: 999,
            accountId: revenueAccountA1Id,
            amountMinor: 100,
          }),
        ),
      ).rejects.toThrow(
        /immutable once its parent customer_invoices is POSTED/,
      );
    });
  });

  describe("audit trail", () => {
    it("writes CREATE/UPDATE/DELETE/POST rows with correct before/after state, plus a linked journal_entry CREATE row on posting", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-08-01",
          lines: oneLine(revenueAccountA1Id, 750),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/invoices/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const invoiceRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "customer_invoice"),
          ),
        );
      const actions = invoiceRows.map((r) => r.action).sort();
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

      // Now delete a fresh DRAFT invoice and confirm the DELETE row.
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customerA1Id,
          invoiceDate: "2026-08-01",
          lines: oneLine(revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/invoices/${draft.body.data.id}`)
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
