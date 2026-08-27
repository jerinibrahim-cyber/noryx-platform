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
  apSettings,
  chartOfAccounts,
  journalEntries,
  journalLines,
  supplierBills,
  supplierDebitNotes,
  supplierDebitNoteLines,
  supplierDebitNoteAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Credit/Debit Notes work item — Supplier Debit Notes (AP)
 * (docs/finance-work-item-credit-debit-notes-proposal.md §5, §9, §10,
 * §13, §14, §16, CTO-approved). Exact AP mirror of
 * customer-credit-notes.e2e-spec.ts, applied to suppliers/supplier_bills
 * instead of customers/customer_invoices, with the reversed-from-AR
 * polarity check (Dr AP control / Cr each line's account + Cr tax
 * input). Covers RBAC, draft CRUD (create/list/get/edit/delete, both
 * lines and allocations), validation, posting (happy path with exact
 * Dr/Cr verification, partial/multi-bill allocation, every 422/409
 * failure mode, bill paidMinor/paymentStatus settlement), post-posting
 * immutability at the DB trigger level (header + lines + allocations),
 * cross-tenant/cross-legal-entity isolation, and the audit trail. Runs
 * against a real Postgres instance.
 */
describe("Supplier Debit Notes (e2e) — draft CRUD, lines, allocation, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let expenseAccountA1Id: string;
  let apControlAccountA1Id: string;
  let taxInputAccountA1Id: string;
  let inactiveAccountA1Id: string;
  let expenseAccountA2Id: string;
  let apControlAccountA2Id: string;
  let supplierA1Id: string;
  let supplierA1bId: string; // second supplier in A1 — cross-supplier test
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

  /** Creates + posts a bill for supplierId, returning {id, totalMinor}.
   * accountId defaults to entity A1's expense account — callers posting
   * in a different legal entity must pass that entity's own account. */
  async function createAndPostBill(
    token: string,
    supplierId: string,
    billDate: string,
    amountMinor = 1000,
    accountId: string = expenseAccountA1Id,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `DBN-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId, amountMinor, taxAmountMinor: 0 }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
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
      .values({ slug: `dbn-e2e-a-${suffix}`, name: "Debit Note E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `dbn-e2e-b-${suffix}`, name: "Debit Note E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "DBNA1",
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
        code: "DBNA2",
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
        code: "DBNB1",
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
        code: `DBN-EXP-A1-${suffix}`,
        name: "Office Supplies Expense",
        type: "EXPENSE",
      })
      .returning();
    const [apCtrlA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `DBN-AP-CTRL-A1-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [taxInA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `DBN-TAXIN-A1-${suffix}`,
        name: "Input Tax Receivable",
        type: "ASSET",
      })
      .returning();
    const [inactiveA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `DBN-INACTIVE-A1-${suffix}`,
        name: "Archived Expense Account",
        type: "EXPENSE",
        isActive: false,
      })
      .returning();
    expenseAccountA1Id = expA1!.id;
    apControlAccountA1Id = apCtrlA1!.id;
    taxInputAccountA1Id = taxInA1!.id;
    inactiveAccountA1Id = inactiveA1!.id;

    const [expA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `DBN-EXP-A2-${suffix}`,
        name: "Entity 2 Expense",
        type: "EXPENSE",
      })
      .returning();
    const [apCtrlA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `DBN-AP-CTRL-A2-${suffix}`,
        name: "Entity 2 Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    expenseAccountA2Id = expA2!.id;
    apControlAccountA2Id = apCtrlA2!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        apControlAccountId: apControlAccountA1Id,
        taxInputAccountId: taxInputAccountA1Id,
      })
      .expect(201);

    const supplierA1 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `DBN-SUP-A1-${suffix}`, name: "Acme Supplier" })
      .expect(201);
    supplierA1Id = supplierA1.body.data.id;

    const supplierA1b = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `DBN-SUP-A1B-${suffix}`, name: "Second Supplier" })
      .expect(201);
    supplierA1bId = supplierA1b.body.data.id;

    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const supplierA2 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `DBN-SUP-A2-${suffix}`, name: "Entity 2 Supplier" })
      .expect(201);
    supplierA2Id = supplierA2.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ apControlAccountId: apControlAccountA2Id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({
        code: `DBN-A2-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);

    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
    const supplierB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `DBN-SUP-B-${suffix}`, name: "Tenant B Supplier" })
      .expect(201);
    supplierBId = supplierB.body.data.id;

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `DBN-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `DBN-CLOSED-${suffix}`,
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
        .get("/v1/finance/debit-notes")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/edit/delete/post (403)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const bill = await createAndPostBill(
        posterToken,
        supplierA1Id,
        "2026-02-01",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 100 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }],
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin can read but cannot write — same split as bills/payments", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const bill = await createAndPostBill(
        posterToken,
        supplierA1Id,
        "2026-02-01",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(403);
    });
  });

  describe("validation at create/edit time", () => {
    it("rejects an empty lines array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects an empty allocations array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [],
        })
        .expect(400);
    });

    it("rejects a nonexistent supplierId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: randomUUID(),
          debitNoteDate: "2026-02-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects a nonexistent/inactive line accountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      const base = {
        supplierId: supplierA1Id,
        debitNoteDate: "2026-02-05",
        allocations: [
          { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
        ],
      };
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...base,
          lines: [{ accountId: randomUUID(), amountMinor: bill.totalMinor }],
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...base,
          lines: [
            { accountId: inactiveAccountA1Id, amountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects an allocation referencing a bill belonging to a different supplier (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1bId, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id, // note belongs to A1, bill to A1b
          debitNoteDate: "2026-02-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects an allocation referencing a cross-legal-entity or cross-tenant bill (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const crossEntityBill = await createAndPostBill(
        a2Token,
        supplierA2Id,
        "2026-02-01",
        1000,
        expenseAccountA2Id,
      );
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [
            { billId: crossEntityBill.id, allocatedAmountMinor: 1000 },
          ],
        })
        .expect(400);
    });

    it("rejects an allocations array allocating to the same bill twice (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-02-01",
        1000,
      );
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-02-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: 500 },
            { billId: bill.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(400);
    });
  });

  describe("draft CRUD", () => {
    it("creates a debit note: stores fields, DRAFT status, null internalReference, computed totals", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-03-01",
        1500,
      );
      const res = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-03-05",
          reason: "Return",
          memo: "March return",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 1500 }],
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.subtotalMinor).toBe(1500);
      expect(res.body.data.taxMinor).toBe(0);
      expect(res.body.data.totalMinor).toBe(1500);
      expect(res.body.data.reason).toBe("Return");
      expect(res.body.data.lines).toHaveLength(1);
      expect(res.body.data.allocations).toHaveLength(1);
    });

    it("404s (not 403) on a nonexistent id and on a cross-legal-entity id within the same tenant", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/debit-notes/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const a2Token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const billA2 = await createAndPostBill(
        a2Token,
        supplierA2Id,
        "2026-03-01",
        1000,
        expenseAccountA2Id,
      );
      const createdA2 = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${a2Token}`)
        .send({
          supplierId: supplierA2Id,
          debitNoteDate: "2026-03-05",
          lines: [
            { accountId: expenseAccountA2Id, amountMinor: billA2.totalMinor },
          ],
          allocations: [
            {
              billId: billA2.id,
              allocatedAmountMinor: billA2.totalMinor,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/debit-notes/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("list filters by status, supplierId, dateFrom/dateTo", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-05-01");
      await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-05-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(201);

      const bySupplier = await request(app.getHttpServer())
        .get(`/v1/finance/debit-notes?supplierId=${supplierA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        bySupplier.body.data.every(
          (r: { supplierId: string }) => r.supplierId === supplierA1Id,
        ),
      ).toBe(true);

      const byStatus = await request(app.getHttpServer())
        .get("/v1/finance/debit-notes?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byStatus.body.data.every(
          (r: { status: string }) => r.status === "DRAFT",
        ),
      ).toBe(true);

      const byDate = await request(app.getHttpServer())
        .get("/v1/finance/debit-notes?dateFrom=2026-05-01&dateTo=2026-05-31")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(byDate.body.data.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .get("/v1/finance/debit-notes?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("edit: header-only PATCH leaves lines/allocations untouched; full-array replacement of each independently", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const billOne = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-03-01",
        1000,
      );
      const billTwo = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-03-02",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-03-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 1000 }],
        })
        .expect(201);
      const id = created.body.data.id;

      const headerOnly = await request(app.getHttpServer())
        .patch(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(headerOnly.body.data.memo).toBe("Updated memo");
      expect(headerOnly.body.data.lines).toHaveLength(1);
      expect(headerOnly.body.data.allocations).toHaveLength(1);

      const replaced = await request(app.getHttpServer())
        .patch(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1500 }],
          allocations: [
            { billId: billOne.id, allocatedAmountMinor: 1000 },
            { billId: billTwo.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(200);
      expect(replaced.body.data.lines).toHaveLength(1);
      expect(replaced.body.data.allocations).toHaveLength(2);
      expect(replaced.body.data.totalMinor).toBe(1500);
    });

    it("delete: DRAFT only, lines/allocations cascade", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-03-01");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-03-05",
          lines: [
            { accountId: expenseAccountA1Id, amountMinor: bill.totalMinor },
          ],
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const [lines, allocations] = await withTenant(tenantAId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(supplierDebitNoteLines)
            .where(eq(supplierDebitNoteLines.debitNoteId, id)),
          tx
            .select()
            .from(supplierDebitNoteAllocations)
            .where(eq(supplierDebitNoteAllocations.debitNoteId, id)),
        ]),
      );
      expect(lines).toHaveLength(0);
      expect(allocations).toHaveLength(0);
    });
  });

  describe("posting — POST /debit-notes/:id/post", () => {
    it("happy path: reversed polarity Dr AP control, Cr line/Cr tax, bill settles", async () => {
      const posterId = randomUUID();
      const token = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-01",
        2000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-05",
          lines: [
            {
              accountId: expenseAccountA1Id,
              amountMinor: 1800,
              taxAmountMinor: 200,
            },
          ],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 2000 }],
        })
        .expect(201);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^DBN-\d{6}$/);
      expect(posted.body.data.periodId).toBe(openPeriodA1Id);
      expect(posted.body.data.postedBy).toBe(posterId);
      expect(posted.body.data.journalEntryId).toBeTruthy();
      expect(posted.body.data.subtotalMinor).toBe(1800);
      expect(posted.body.data.taxMinor).toBe(200);
      expect(posted.body.data.totalMinor).toBe(2000);

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
      // AP-control line + expense line + tax-input line — reversed
      // polarity from the bill's own posting (proposal §9): DEBIT AP
      // control, CREDIT the expense account and the tax-input account.
      expect(lines).toHaveLength(3);
      const expenseLine = lines.find((l) => l.accountId === expenseAccountA1Id);
      const taxLine = lines.find((l) => l.accountId === taxInputAccountA1Id);
      const apLine = lines.find((l) => l.accountId === apControlAccountA1Id);
      expect(expenseLine!.creditMinor).toBe(1800);
      expect(expenseLine!.debitMinor).toBe(0);
      expect(taxLine!.creditMinor).toBe(200);
      expect(taxLine!.debitMinor).toBe(0);
      expect(apLine!.creditMinor).toBe(0);
      expect(apLine!.debitMinor).toBe(2000);

      const settledBill = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierBills)
          .where(eq(supplierBills.id, bill.id))
          .then((rows) => rows[0]!),
      );
      expect(settledBill.paidMinor).toBe(2000);
      expect(settledBill.paymentStatus).toBe("PAID");
    });

    it("partial allocation across two bills in a single post()", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const billOne = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-10",
        700,
      );
      const billTwo = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-11",
        300,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-12",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [
            { billId: billOne.id, allocatedAmountMinor: 700 },
            { billId: billTwo.id, allocatedAmountMinor: 300 },
          ],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
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
      // Still a 2-line entry (no tax) — allocations don't create extra JE
      // lines, only ONE debit to AP control for the full note amount.
      expect(lines).toHaveLength(2);

      const [settledOne, settledTwo] = await withTenant(tenantAId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(supplierBills)
            .where(eq(supplierBills.id, billOne.id))
            .then((rows) => rows[0]!),
          tx
            .select()
            .from(supplierBills)
            .where(eq(supplierBills.id, billTwo.id))
            .then((rows) => rows[0]!),
        ]),
      );
      expect(settledOne.paidMinor).toBe(700);
      expect(settledOne.paymentStatus).toBe("PAID");
      expect(settledTwo.paidMinor).toBe(300);
      expect(settledTwo.paymentStatus).toBe("PAID");
    });

    it("partial bill settlement leaves the bill PARTIALLY_PAID", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-02",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-05",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 400 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 400 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const settledBill = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierBills)
          .where(eq(supplierBills.id, bill.id))
          .then((rows) => rows[0]!),
      );
      expect(settledBill.paidMinor).toBe(400);
      expect(settledBill.paymentStatus).toBe("PARTIALLY_PAID");
    });

    it("422 when a single bill's allocation exceeds its outstanding balance", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-15",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-16",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 600 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 — a fully paid bill rejects a further allocation (no refund/on-account functionality)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-15",
        500,
      );
      // Fully settle the bill with a first debit note.
      const first = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-16",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${first.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      // A second debit note attempting to allocate against the now-
      // fully-paid bill is rejected — outstanding is 0.
      const second = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-17",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 100 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${second.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when the sum of allocations does not equal the debit note total — no debit on account", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-17",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-18",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 1000 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 400 }], // < 1000
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when posting against a DRAFT (not yet posted) bill", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const draftBill = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          supplierBillNumber: `DBN-DRAFT-${randomUUID()}`,
          billDate: "2026-06-19",
          lines: [
            {
              accountId: expenseAccountA1Id,
              amountMinor: 500,
              taxAmountMinor: 0,
            },
          ],
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-20",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [
            {
              billId: draftBill.body.data.id,
              allocatedAmountMinor: 500,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("re-validates the line account at posting time — rejects (422) an account archived after draft creation", async () => {
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
          code: `DBN-ARCHIVABLE-${suffix}`,
          name: "Archived After Draft",
          type: "EXPENSE",
        })
        .returning();

      const bill = await createAndPostBill(
        posterToken,
        supplierA1Id,
        "2026-06-21",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-22",
          lines: [{ accountId: toArchive!.id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${toArchive!.id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(422);
    });

    it("422 when this debit note carries tax but no tax input account is configured", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      // Entity A2's AP settings have NO taxInputAccountId configured
      // (seeded without one in beforeAll).
      const bill = await createAndPostBill(
        token,
        supplierA2Id,
        "2026-06-01",
        1100,
        expenseAccountA2Id,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA2Id,
          debitNoteDate: "2026-06-05",
          lines: [
            {
              accountId: expenseAccountA2Id,
              amountMinor: 1000,
              taxAmountMinor: 100,
            },
          ],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 1100 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with no covering accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-23",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: NO_PERIOD_DATE,
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with a covering but CLOSED accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-30",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2025-01-15",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when AP settings are not configured for the legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA2Id,
        "2026-06-01",
        500,
        expenseAccountA2Id,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA2Id,
          debitNoteDate: "2026-06-05",
          lines: [{ accountId: expenseAccountA2Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);

      const financeDb = getFinanceDb();
      await financeDb
        .delete(apSettings)
        .where(
          and(
            eq(apSettings.tenantId, tenantAId),
            eq(apSettings.legalEntityId, legalEntityA2Id),
          ),
        );

      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      // Restore for any later test in this file that relies on entity
      // A2 having AP settings configured.
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"])}`,
        )
        .send({ apControlAccountId: apControlAccountA2Id })
        .expect(201);
    });

    it("409 when posting an already-POSTED debit note", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-24",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-25",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("409 on edit/delete of a POSTED debit note (clean error, not a raw trigger error)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-26",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-06-27",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "attempted edit" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });
  });

  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostDebitNote(): Promise<string> {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-07-01",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-07-02",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE/DELETE of a POSTED supplier_debit_notes row — zero exceptions", async () => {
      const id = await createAndPostDebitNote();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierDebitNotes)
            .set({ memo: "bypassing the service layer" })
            .where(eq(supplierDebitNotes.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(supplierDebitNotes).where(eq(supplierDebitNotes.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects INSERT/UPDATE/DELETE of supplier_debit_note_lines once the parent note is POSTED — zero exceptions", async () => {
      const id = await createAndPostDebitNote();
      const existingLine = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierDebitNoteLines)
          .where(eq(supplierDebitNoteLines.debitNoteId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierDebitNoteLines)
            .set({ amountMinor: 9999 })
            .where(eq(supplierDebitNoteLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(supplierDebitNoteLines)
            .where(eq(supplierDebitNoteLines.id, existingLine.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(supplierDebitNoteLines).values({
            tenantId: tenantAId,
            debitNoteId: id,
            lineNumber: 99,
            accountId: expenseAccountA1Id,
            amountMinor: 100,
          }),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );
    });

    it("rejects INSERT/UPDATE/DELETE of supplier_debit_note_allocations once the parent note is POSTED — zero exceptions", async () => {
      const id = await createAndPostDebitNote();
      const existingAllocation = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierDebitNoteAllocations)
          .where(eq(supplierDebitNoteAllocations.debitNoteId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierDebitNoteAllocations)
            .set({ allocatedAmountMinor: 9999 })
            .where(eq(supplierDebitNoteAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(supplierDebitNoteAllocations)
            .where(eq(supplierDebitNoteAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );

      const otherBill = await createAndPostBill(
        tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]),
        supplierA1Id,
        "2026-07-03",
        200,
      );
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(supplierDebitNoteAllocations).values({
            tenantId: tenantAId,
            debitNoteId: id,
            billId: otherBill.id,
            allocatedAmountMinor: 200,
          }),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_debit_notes is POSTED/,
      );
    });
  });

  describe("audit trail", () => {
    it("writes CREATE/UPDATE/DELETE/POST rows on the debit note, a linked journal_entry CREATE row, and an UPDATE row per settled bill", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-08-01",
        750,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-08-02",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 750 }],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 750 }],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/debit-notes/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/debit-notes/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const debitNoteRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "supplier_debit_note"),
          ),
        );
      const actions = debitNoteRows.map((r) => r.action).sort();
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

      const billAuditRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, bill.id),
            eq(auditLogs.entityType, "supplier_bill"),
            eq(auditLogs.action, "UPDATE"),
          ),
        );
      expect(billAuditRows.length).toBeGreaterThanOrEqual(1);
      const afterState = billAuditRows[billAuditRows.length - 1]!
        .afterState as { paidMinor: number; paymentStatus: string };
      expect(afterState.paidMinor).toBe(750);
      expect(afterState.paymentStatus).toBe("PAID");

      // Now delete a fresh DRAFT debit note and confirm the DELETE row.
      const anotherBill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-08-03",
        200,
      );
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          debitNoteDate: "2026-08-04",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 200 }],
          allocations: [{ billId: anotherBill.id, allocatedAmountMinor: 200 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/debit-notes/${draft.body.data.id}`)
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
