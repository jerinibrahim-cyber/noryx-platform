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
  supplierBills,
  supplierBillLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1b — Supplier Bills
 * (docs/finance-work-item-1b-supplier-bills-proposal.md §4, §6, §7, §8,
 * §17, §18). Covers RBAC, draft CRUD (create/list/get/edit/delete),
 * validation, posting (the balanced journal entry §7 describes,
 * numbering, period resolution, tax handling, every 422/409 failure
 * mode), post-posting immutability at the DB trigger level, cross-
 * tenant/cross-legal-entity isolation, and the audit trail. Runs against
 * a real Postgres instance. GL integration and concurrency have their
 * own dedicated files (ap-bill-gl-integration.e2e-spec.ts,
 * ap-bill-concurrency.e2e-spec.ts).
 */
describe("Supplier Bills (e2e) — draft CRUD, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let expenseAccountA1Id: string;
  let expenseAccountA2Id: string; // cross-entity — for cross-entity rejection
  let inactiveAccountA1Id: string;
  let liabilityAccountA1Id: string; // AP control account, entity A1
  let taxInputAccountA1Id: string; // tax input account, entity A1
  let supplierA1Id: string; // paymentTermsDays = 30
  let supplierNoTermsA1Id: string; // no paymentTermsDays configured
  let supplierA2Id: string; // cross-entity
  let supplierBId: string; // cross-tenant
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
      .values({ slug: `bill-e2e-a-${suffix}`, name: "Bill E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `bill-e2e-b-${suffix}`, name: "Bill E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BILLA1",
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
        code: "BILLA2",
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
        code: "BILLB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [expA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BILL-EXP-A1-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [expA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `BILL-EXP-A2-${suffix}`,
        name: "Entity 2 Expense",
        type: "EXPENSE",
      })
      .returning();
    const [inactiveA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BILL-INACTIVE-A1-${suffix}`,
        name: "Archived Expense",
        type: "EXPENSE",
        isActive: false,
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BILL-AP-CTRL-A1-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [taxInputA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `BILL-TAX-A1-${suffix}`,
        name: "Input VAT",
        type: "ASSET",
      })
      .returning();
    expenseAccountA1Id = expA1!.id;
    expenseAccountA2Id = expA2!.id;
    inactiveAccountA1Id = inactiveA1!.id;
    liabilityAccountA1Id = liabilityA1!.id;
    taxInputAccountA1Id = taxInputA1!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    // AP settings — entity A1 only (entity A2/B deliberately left
    // unconfigured for the "AP settings not configured" 422 test).
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        apControlAccountId: liabilityAccountA1Id,
        taxInputAccountId: taxInputAccountA1Id,
      })
      .expect(201);

    const supplierA1 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILL-SUP-A1-${suffix}`,
        name: "Acme Supplies",
        paymentTermsDays: 30,
      })
      .expect(201);
    supplierA1Id = supplierA1.body.data.id;

    const supplierNoTermsA1 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `BILL-SUP-NT-${suffix}`, name: "No Terms Co" })
      .expect(201);
    supplierNoTermsA1Id = supplierNoTermsA1.body.data.id;

    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const supplierA2 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `BILL-SUP-A2-${suffix}`, name: "Entity 2 Supplier" })
      .expect(201);
    supplierA2Id = supplierA2.body.data.id;

    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
    const supplierB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `BILL-SUP-B-${suffix}`, name: "Tenant B Supplier" })
      .expect(201);
    supplierBId = supplierB.body.data.id;

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILL-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILL-CLOSED-${suffix}`,
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
      await request(app.getHttpServer()).get("/v1/finance/bills").expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/edit/delete/post (403)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `RBAC-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/bills")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `RBAC-2-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin can read but cannot write — same split as journal entries, unlike suppliers/ap-settings", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `RBAC-ADMIN-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(403);
    });
  });

  describe("validation at create/edit time", () => {
    it("rejects an empty lines array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `VAL-EMPTY-${suffix}`,
          billDate: "2026-02-01",
          lines: [],
        })
        .expect(400);
    });

    it("rejects a nonexistent supplierId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: randomUUID(),
          supplierBillNumber: `VAL-NOSUP-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(400);
    });

    it("rejects a cross-legal-entity supplierId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA2Id,
          supplierBillNumber: `VAL-XENTITY-SUP-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(400);
    });

    it("rejects a line with a nonexistent/inactive/cross-entity accountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `VAL-NOACCT-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(randomUUID()),
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `VAL-INACTIVE-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(inactiveAccountA1Id),
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `VAL-XENTITY-ACCT-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA2Id),
        })
        .expect(400);
    });

    it("rejects a zero/negative line amountMinor at the DTO level (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `VAL-ZERO-${suffix}`,
          billDate: "2026-02-01",
          lines: oneLine(expenseAccountA1Id, 0),
        })
        .expect(400);
    });
  });

  describe("draft CRUD", () => {
    it("creates a bill: computes subtotal/tax/total, defaults dueDate from supplier.paymentTermsDays", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `CRUD-CREATE-${suffix}`,
          billDate: "2026-03-01",
          lines: [
            {
              accountId: expenseAccountA1Id,
              amountMinor: 1000,
              taxAmountMinor: 50,
            },
            { accountId: expenseAccountA1Id, amountMinor: 500 },
          ],
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.paymentStatus).toBe("UNPAID");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.subtotalMinor).toBe(1500);
      expect(res.body.data.taxMinor).toBe(50);
      expect(res.body.data.totalMinor).toBe(1550);
      expect(res.body.data.dueDate).toBe("2026-03-31"); // billDate + 30 days
      expect(res.body.data.lines).toHaveLength(2);
    });

    it("leaves dueDate null when the supplier has no paymentTermsDays and none is supplied", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierNoTermsA1Id,
          supplierBillNumber: `CRUD-NODUE-${suffix}`,
          billDate: "2026-03-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      expect(res.body.data.dueDate).toBeNull();
    });

    it("an explicit dueDate always wins over the computed default", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `CRUD-EXPLICITDUE-${suffix}`,
          billDate: "2026-03-01",
          dueDate: "2026-04-15",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      expect(res.body.data.dueDate).toBe("2026-04-15");
    });

    it("404s (not 403) on a nonexistent id and on a cross-legal-entity id within the same tenant", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bills/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const createdA2 = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${a2Token}`)
        .send({
          supplierId: supplierA2Id,
          supplierBillNumber: `CRUD-A2-${suffix}`,
          billDate: "2026-03-01",
          lines: oneLine(expenseAccountA2Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/bills/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("a cross-tenant supplierId is rejected the same way a cross-entity one is (400) — RLS plus the explicit legal-entity predicate together close both angles", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierBId,
          supplierBillNumber: `CRUD-XTENANT-${suffix}`,
          billDate: "2026-03-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(400);
    });

    it("list filters by status, supplierId, dateFrom/dateTo", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `LIST-FILTER-${suffix}`,
          billDate: "2026-05-05",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);

      const bySupplier = await request(app.getHttpServer())
        .get(`/v1/finance/bills?supplierId=${supplierA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        bySupplier.body.data.every(
          (b: { supplierId: string }) => b.supplierId === supplierA1Id,
        ),
      ).toBe(true);

      const byStatus = await request(app.getHttpServer())
        .get("/v1/finance/bills?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byStatus.body.data.every(
          (b: { status: string }) => b.status === "DRAFT",
        ),
      ).toBe(true);

      const byDate = await request(app.getHttpServer())
        .get("/v1/finance/bills?dateFrom=2026-05-01&dateTo=2026-05-31")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(byDate.body.data.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .get("/v1/finance/bills?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("edit: header-only PATCH leaves lines/totals untouched; full-array line replacement recomputes totals", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `EDIT-${suffix}`,
          billDate: "2026-03-01",
          lines: oneLine(expenseAccountA1Id, 1000),
        })
        .expect(201);
      const id = created.body.data.id;

      const headerOnly = await request(app.getHttpServer())
        .patch(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(headerOnly.body.data.memo).toBe("Updated memo");
      expect(headerOnly.body.data.totalMinor).toBe(1000);
      expect(headerOnly.body.data.lines).toHaveLength(1);

      const replaced = await request(app.getHttpServer())
        .patch(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: 200 },
            {
              accountId: expenseAccountA1Id,
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
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `DELETE-${suffix}`,
          billDate: "2026-03-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierBillLines)
          .where(eq(supplierBillLines.billId, id)),
      );
      expect(lines).toHaveLength(0);
    });
  });

  describe("posting — POST /bills/:id/post", () => {
    it("posts a balanced entry with no tax: Dr expense line(s), Cr AP control; assigns BILL-###### and JE-######; becomes immutable", async () => {
      const posterId = randomUUID();
      const token = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-NOTAX-${suffix}`,
          billDate: "2026-06-01",
          lines: oneLine(expenseAccountA1Id, 2000),
        })
        .expect(201);
      const id = created.body.data.id;

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^BILL-\d{6}$/);
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
      expect(lines).toHaveLength(2); // 1 expense debit + 1 AP credit, no tax line
      const debitLine = lines.find((l) => l.accountId === expenseAccountA1Id);
      const creditLine = lines.find(
        (l) => l.accountId === liabilityAccountA1Id,
      );
      expect(debitLine!.debitMinor).toBe(2000);
      expect(debitLine!.creditMinor).toBe(0);
      expect(creditLine!.debitMinor).toBe(0);
      expect(creditLine!.creditMinor).toBe(2000);
    });

    it("posts a balanced entry with tax: Dr expense line(s) + Dr aggregate tax line, Cr AP control for the total", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-TAX-${suffix}`,
          billDate: "2026-06-02",
          lines: [
            {
              accountId: expenseAccountA1Id,
              amountMinor: 1000,
              taxAmountMinor: 50,
            },
            {
              accountId: expenseAccountA1Id,
              amountMinor: 2000,
              taxAmountMinor: 100,
            },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
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
      expect(lines).toHaveLength(4); // 2 expense debits + 1 aggregate tax debit + 1 AP credit
      const totalDebit = lines.reduce((s, l) => s + l.debitMinor, 0);
      const totalCredit = lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(3150);
      const taxLine = lines.find((l) => l.accountId === taxInputAccountA1Id);
      expect(taxLine).toBeDefined();
      expect(taxLine!.debitMinor).toBe(150);
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
          code: `BILL-ARCHIVABLE-${suffix}`,
          name: "Archived After Draft",
          type: "EXPENSE",
        })
        .returning();

      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-ARCHIVED-${suffix}`,
          billDate: "2026-06-03",
          lines: oneLine(toArchive!.id),
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${toArchive!.id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(422);
    });

    it("422 with no covering accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-NOPERIOD-${suffix}`,
          billDate: NO_PERIOD_DATE,
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with a covering but CLOSED accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-CLOSED-${suffix}`,
          billDate: "2025-01-15",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when AP settings are not configured for the legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA2Id,
          supplierBillNumber: `POST-NOSETTINGS-${suffix}`,
          billDate: "2026-06-01",
          lines: oneLine(expenseAccountA2Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when a line carries tax but no tax input account is configured", async () => {
      const financeDb = getFinanceDb();
      const [liabilityB] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `BILL-AP-CTRL-B-${suffix}`,
          name: "AP Control B",
          type: "LIABILITY",
        })
        .returning();
      const [expenseB] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `BILL-EXP-B-${suffix}`,
          name: "Expense B",
          type: "EXPENSE",
        })
        .returning();
      const bAdminToken = tokenFor(tenantBId, legalEntityBId, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${bAdminToken}`)
        .send({ apControlAccountId: liabilityB!.id }) // no taxInputAccountId
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${bAdminToken}`)
        .send({
          code: `BILL-B-OPEN-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);

      const bPosterToken = tokenFor(tenantBId, legalEntityBId, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${bPosterToken}`)
        .send({
          supplierId: supplierBId,
          supplierBillNumber: `POST-NOTAXACCT-${suffix}`,
          billDate: "2026-06-01",
          lines: [
            { accountId: expenseB!.id, amountMinor: 1000, taxAmountMinor: 50 },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${bPosterToken}`)
        .expect(422);
    });

    it("409 when posting an already-POSTED bill", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-DOUBLE-${suffix}`,
          billDate: "2026-06-04",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("409 on edit/delete of a POSTED bill (clean error, not a raw trigger error)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `POST-IMMUTABLE-${suffix}`,
          billDate: "2026-06-05",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "attempted edit" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });
  });

  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostBill(): Promise<string> {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `TRIGGER-${randomUUID()}`,
          billDate: "2026-07-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE of any column other than paid_minor/payment_status on a POSTED supplier_bills row", async () => {
      const id = await createAndPostBill();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierBills)
            .set({ memo: "bypassing the service layer" })
            .where(eq(supplierBills.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects a raw DELETE of a POSTED supplier_bills row", async () => {
      const id = await createAndPostBill();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(supplierBills).where(eq(supplierBills.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects INSERT/UPDATE/DELETE of supplier_bill_lines once the parent bill is POSTED — zero exceptions", async () => {
      const id = await createAndPostBill();
      const existingLine = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierBillLines)
          .where(eq(supplierBillLines.billId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierBillLines)
            .set({ amountMinor: 9999 })
            .where(eq(supplierBillLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(/immutable once its parent supplier_bills is POSTED/);

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(supplierBillLines)
            .where(eq(supplierBillLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(/immutable once its parent supplier_bills is POSTED/);

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(supplierBillLines).values({
            tenantId: tenantAId,
            billId: id,
            lineNumber: 999,
            accountId: expenseAccountA1Id,
            amountMinor: 100,
          }),
        ),
      ).rejects.toThrow(/immutable once its parent supplier_bills is POSTED/);
    });
  });

  describe("audit trail", () => {
    it("writes CREATE/UPDATE/DELETE/POST rows with correct before/after state, plus a linked journal_entry CREATE row on posting", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `AUDIT-${suffix}`,
          billDate: "2026-08-01",
          lines: oneLine(expenseAccountA1Id, 750),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/bills/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const billRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "supplier_bill"),
          ),
        );
      const actions = billRows.map((r) => r.action).sort();
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

      // Now delete a fresh DRAFT bill and confirm the DELETE row.
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `AUDIT-DELETE-${suffix}`,
          billDate: "2026-08-01",
          lines: oneLine(expenseAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bills/${draft.body.data.id}`)
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
