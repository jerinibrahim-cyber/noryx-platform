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
  supplierPayments,
  supplierPaymentAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1c — Supplier Payments & Allocations
 * (docs/finance-work-item-1c-supplier-payments-proposal.md §3, §6, §7,
 * §8, §9, §10, §11). Covers RBAC, draft CRUD (create/list/get/edit/
 * delete), validation, posting (partial/full settlement, multi-bill
 * allocation, every 422/409 failure mode), post-posting immutability at
 * the DB trigger level, cross-tenant/cross-legal-entity isolation, and
 * the audit trail. Runs against a real Postgres instance. GL integration
 * and reconciliation, and concurrency, have their own dedicated files
 * (ap-payment-gl-integration.e2e-spec.ts,
 * ap-payment-concurrency.e2e-spec.ts).
 */
describe("Supplier Payments (e2e) — draft CRUD, allocation, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let expenseAccountA1Id: string;
  let liabilityAccountA1Id: string; // AP control account, entity A1
  let bankAccountA1Id: string; // bank/cash ASSET account, entity A1
  let inactiveAssetAccountA1Id: string;
  let expenseAccountA2Id: string;
  let liabilityAccountA2Id: string; // AP control account, entity A2
  let bankAccountA2Id: string; // bank/cash ASSET account, entity A2
  let supplierA1Id: string;
  let supplierA1bId: string; // second supplier in A1 — cross-supplier bill test
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
   * in a different legal entity must pass that entity's own account
   * (chart_of_accounts is scoped per legal entity; a cross-entity
   * accountId is rejected at bill-creation time). */
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
        supplierBillNumber: `PAY-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId, amountMinor }],
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
      .values({ slug: `pay-e2e-a-${suffix}`, name: "Payment E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `pay-e2e-b-${suffix}`, name: "Payment E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "PAYA1",
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
        code: "PAYA2",
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
        code: "PAYB1",
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
        code: `PAY-EXP-A1-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `PAY-AP-CTRL-A1-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bankA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `PAY-BANK-A1-${suffix}`,
        name: "Main Bank Account",
        type: "ASSET",
      })
      .returning();
    const [inactiveAssetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: `PAY-INACTIVE-A1-${suffix}`,
        name: "Archived Bank Account",
        type: "ASSET",
        isActive: false,
      })
      .returning();
    expenseAccountA1Id = expA1!.id;
    liabilityAccountA1Id = liabilityA1!.id;
    bankAccountA1Id = bankA1!.id;
    inactiveAssetAccountA1Id = inactiveAssetA1!.id;

    const [expA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `PAY-EXP-A2-${suffix}`,
        name: "Entity 2 Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liabilityA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `PAY-AP-CTRL-A2-${suffix}`,
        name: "Entity 2 Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bankA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: `PAY-BANK-A2-${suffix}`,
        name: "Entity 2 Main Bank Account",
        type: "ASSET",
      })
      .returning();
    expenseAccountA2Id = expA2!.id;
    liabilityAccountA2Id = liabilityA2!.id;
    bankAccountA2Id = bankA2!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountA1Id })
      .expect(201);

    const supplierA1 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `PAY-SUP-A1-${suffix}`, name: "Acme Supplies" })
      .expect(201);
    supplierA1Id = supplierA1.body.data.id;

    const supplierA1b = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `PAY-SUP-A1B-${suffix}`, name: "Second Supplier" })
      .expect(201);
    supplierA1bId = supplierA1b.body.data.id;

    const adminA2Token = tokenFor(tenantAId, legalEntityA2Id, [
      "finance.admin",
    ]);
    const supplierA2 = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ code: `PAY-SUP-A2-${suffix}`, name: "Entity 2 Supplier" })
      .expect(201);
    supplierA2Id = supplierA2.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({ apControlAccountId: liabilityAccountA2Id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA2Token}`)
      .send({
        code: `PAY-A2-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);

    const adminBToken = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
    const supplierB = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ code: `PAY-SUP-B-${suffix}`, name: "Tenant B Supplier" })
      .expect(201);
    supplierBId = supplierB.body.data.id;

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAY-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAY-CLOSED-${suffix}`,
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
        .get("/v1/finance/payments")
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
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
        .get("/v1/finance/payments")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: 100,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }],
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin can read but cannot write — same split as bills/journal entries", async () => {
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(403);
    });
  });

  describe("validation at create/edit time", () => {
    it("rejects an empty allocations array (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: 1000,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [],
        })
        .expect(400);
    });

    it("rejects a nonexistent supplierId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: randomUUID(),
          paymentDate: "2026-02-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects a nonexistent/inactive/wrong-type bankCashAccountId (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      const base = {
        supplierId: supplierA1Id,
        paymentDate: "2026-02-05",
        paymentAmountMinor: bill.totalMinor,
        paymentMethod: "CASH",
        allocations: [
          { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
        ],
      };
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: randomUUID() })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: inactiveAssetAccountA1Id })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...base, bankCashAccountId: liabilityAccountA1Id }) // wrong type: LIABILITY, not ASSET
        .expect(400);
    });

    it("rejects an allocation referencing a bill belonging to a different supplier (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1bId, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id, // payment is for supplierA1, bill belongs to supplierA1b
          paymentDate: "2026-02-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: 1000,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: crossEntityBill.id, allocatedAmountMinor: 1000 },
          ],
        })
        .expect(400);
    });

    it("a cross-tenant supplierId is rejected the same way a cross-entity one is (400) — RLS plus the explicit legal-entity predicate together close both angles", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierBId,
          paymentDate: "2026-02-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(400);
    });

    it("rejects a zero/negative paymentAmountMinor at the DTO level (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-02-01");
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-02-05",
          paymentAmountMinor: 0,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }],
        })
        .expect(400);
    });
  });

  describe("draft CRUD", () => {
    it("creates a payment: stores fields, DRAFT status, null internalReference", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-03-01",
        1500,
      );
      const res = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-03-05",
          paymentAmountMinor: 1500,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          reference: "TRF-0001",
          memo: "March settlement",
          allocations: [{ billId: bill.id, allocatedAmountMinor: 1500 }],
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.paymentAmountMinor).toBe(1500);
      expect(res.body.data.reference).toBe("TRF-0001");
      expect(res.body.data.allocations).toHaveLength(1);
    });

    it("404s (not 403) on a nonexistent id and on a cross-legal-entity id within the same tenant", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/payments/${randomUUID()}`)
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${a2Token}`)
        .send({
          supplierId: supplierA2Id,
          paymentDate: "2026-03-05",
          paymentAmountMinor: billA2.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA2Id,
          allocations: [
            { billId: billA2.id, allocatedAmountMinor: billA2.totalMinor },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/payments/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("list filters by status, supplierId, dateFrom/dateTo", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-05-01");
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-05-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(201);

      const bySupplier = await request(app.getHttpServer())
        .get(`/v1/finance/payments?supplierId=${supplierA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        bySupplier.body.data.every(
          (p: { supplierId: string }) => p.supplierId === supplierA1Id,
        ),
      ).toBe(true);

      const byStatus = await request(app.getHttpServer())
        .get("/v1/finance/payments?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        byStatus.body.data.every(
          (p: { status: string }) => p.status === "DRAFT",
        ),
      ).toBe(true);

      const byDate = await request(app.getHttpServer())
        .get("/v1/finance/payments?dateFrom=2026-05-01&dateTo=2026-05-31")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(byDate.body.data.length).toBeGreaterThanOrEqual(1);

      await request(app.getHttpServer())
        .get("/v1/finance/payments?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("GET /bills?paymentStatus= filters bills by payment status", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-05-10",
        1000,
      );
      const unpaid = await request(app.getHttpServer())
        .get(
          `/v1/finance/bills?paymentStatus=UNPAID&supplierId=${supplierA1Id}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        unpaid.body.data.some((b: { id: string }) => b.id === bill.id),
      ).toBe(true);

      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-05-11",
          paymentAmountMinor: 1000,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 1000 }],
        })
        .then((res) =>
          request(app.getHttpServer())
            .post(`/v1/finance/payments/${res.body.data.id}/post`)
            .set("Authorization", `Bearer ${token}`)
            .expect(200),
        );

      const paid = await request(app.getHttpServer())
        .get(`/v1/finance/bills?paymentStatus=PAID&supplierId=${supplierA1Id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(paid.body.data.some((b: { id: string }) => b.id === bill.id)).toBe(
        true,
      );

      await request(app.getHttpServer())
        .get("/v1/finance/bills?paymentStatus=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("edit: header-only PATCH leaves allocations untouched; full-array allocation replacement", async () => {
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-03-05",
          paymentAmountMinor: 1000,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 1000 }],
        })
        .expect(201);
      const id = created.body.data.id;

      const headerOnly = await request(app.getHttpServer())
        .patch(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(headerOnly.body.data.memo).toBe("Updated memo");
      expect(headerOnly.body.data.allocations).toHaveLength(1);

      const replaced = await request(app.getHttpServer())
        .patch(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          paymentAmountMinor: 1500,
          allocations: [
            { billId: billOne.id, allocatedAmountMinor: 1000 },
            { billId: billTwo.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(200);
      expect(replaced.body.data.allocations).toHaveLength(2);
      expect(replaced.body.data.paymentAmountMinor).toBe(1500);
    });

    it("delete: DRAFT only, allocations cascade", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(token, supplierA1Id, "2026-03-01");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-03-05",
          paymentAmountMinor: bill.totalMinor,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: bill.id, allocatedAmountMinor: bill.totalMinor },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);

      const allocations = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, id)),
      );
      expect(allocations).toHaveLength(0);
    });
  });

  describe("posting — POST /payments/:id/post", () => {
    it("full settlement: allocates the entire bill outstanding, bill becomes PAID", async () => {
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-05",
          paymentAmountMinor: 2000,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 2000 }],
        })
        .expect(201);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^PAY-\d{6}$/);
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
      const debitLine = lines.find((l) => l.accountId === liabilityAccountA1Id);
      const creditLine = lines.find((l) => l.accountId === bankAccountA1Id);
      expect(debitLine!.debitMinor).toBe(2000);
      expect(creditLine!.creditMinor).toBe(2000);

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

    it("partial settlement: allocates less than the bill's total, bill becomes PARTIALLY_PAID", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-02",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-05",
          paymentAmountMinor: 400,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 400 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
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

      // A second payment completes settlement.
      const second = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-06",
          paymentAmountMinor: 600,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${second.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const fullySettledBill = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierBills)
          .where(eq(supplierBills.id, bill.id))
          .then((rows) => rows[0]!),
      );
      expect(fullySettledBill.paidMinor).toBe(1000);
      expect(fullySettledBill.paymentStatus).toBe("PAID");
    });

    it("multiple-bill allocation: one payment settles two bills in a single post()", async () => {
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-12",
          paymentAmountMinor: 1000,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            { billId: billOne.id, allocatedAmountMinor: 700 },
            { billId: billTwo.id, allocatedAmountMinor: 300 },
          ],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
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
      // only ONE debit to AP control for the full payment amount.
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

    it("422 when a single bill's allocation exceeds its outstanding balance", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-15",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-16",
          paymentAmountMinor: 600,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when the sum of allocations does not equal the payment amount", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-17",
        1000,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-18",
          paymentAmountMinor: 1000,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 400 }], // < 1000
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
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
          supplierBillNumber: `PAY-DRAFTBILL-${suffix}`,
          billDate: "2026-06-19",
          lines: [{ accountId: expenseAccountA1Id, amountMinor: 500 }],
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-20",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [
            {
              billId: draftBill.body.data.id,
              allocatedAmountMinor: 500,
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
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
          code: `PAY-ARCHIVABLE-${suffix}`,
          name: "Archived After Draft",
          type: "ASSET",
        })
        .returning();

      const bill = await createAndPostBill(
        posterToken,
        supplierA1Id,
        "2026-06-21",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-22",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: toArchive!.id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${toArchive!.id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
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
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: NO_PERIOD_DATE,
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 with a covering but CLOSED accounting period", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      // The BILL posts fine (dated inside the OPEN period) — only the
      // PAYMENT is dated inside the closed period, isolating the
      // closed-period check to the payment's own posting attempt.
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-30",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2025-01-15",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("422 when AP settings are not configured for the legal entity", async () => {
      const token = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      // Entity A2's AP settings must exist for the BILL to post (bill
      // posting also debits/credits the AP control account) — so this
      // test posts the bill normally, then removes AP settings before
      // attempting to post the PAYMENT, isolating the missing-settings
      // check to the payment's own posting attempt (re-validated
      // independently, same posture as the bank/cash account
      // re-validation test above).
      const bill = await createAndPostBill(
        token,
        supplierA2Id,
        "2026-06-01",
        500,
        expenseAccountA2Id,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA2Id,
          paymentDate: "2026-06-05",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA2Id,
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
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
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
        .send({ apControlAccountId: liabilityAccountA2Id })
        .expect(201);
    });

    it("409 when posting an already-POSTED payment", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-24",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-25",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("409 on edit/delete of a POSTED payment (clean error, not a raw trigger error)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-06-26",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-06-27",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "attempted edit" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });
  });

  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostPayment(): Promise<string> {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-07-01",
        500,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-07-02",
          paymentAmountMinor: 500,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 500 }],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/payments/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE of any column on a POSTED supplier_payments row — zero exceptions", async () => {
      const id = await createAndPostPayment();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierPayments)
            .set({ memo: "bypassing the service layer" })
            .where(eq(supplierPayments.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects a raw DELETE of a POSTED supplier_payments row", async () => {
      const id = await createAndPostPayment();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(supplierPayments).where(eq(supplierPayments.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects INSERT/UPDATE/DELETE of supplier_payment_allocations once the parent payment is POSTED — zero exceptions", async () => {
      const id = await createAndPostPayment();
      const existingAllocation = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.paymentId, id))
          .then((rows) => rows[0]!),
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(supplierPaymentAllocations)
            .set({ allocatedAmountMinor: 9999 })
            .where(eq(supplierPaymentAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_payments is POSTED/,
      );

      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(supplierPaymentAllocations)
            .where(eq(supplierPaymentAllocations.id, existingAllocation.id)),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_payments is POSTED/,
      );

      const otherBill = await createAndPostBill(
        tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]),
        supplierA1Id,
        "2026-07-03",
        200,
      );
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(supplierPaymentAllocations).values({
            tenantId: tenantAId,
            paymentId: id,
            billId: otherBill.id,
            allocatedAmountMinor: 200,
          }),
        ),
      ).rejects.toThrow(
        /immutable once its parent supplier_payments is POSTED/,
      );
    });
  });

  describe("audit trail", () => {
    it("writes CREATE/UPDATE/DELETE/POST rows on the payment, a linked journal_entry CREATE row, and an UPDATE row per settled bill", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-08-01",
        750,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-08-02",
          paymentAmountMinor: 750,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: bill.id, allocatedAmountMinor: 750 }],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/payments/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/payments/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const paymentRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "supplier_payment"),
          ),
        );
      const actions = paymentRows.map((r) => r.action).sort();
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
      expect(billAuditRows).toHaveLength(1);
      const afterState = billAuditRows[0]!.afterState as {
        paidMinor: number;
        paymentStatus: string;
      };
      expect(afterState.paidMinor).toBe(750);
      expect(afterState.paymentStatus).toBe("PAID");

      // Now delete a fresh DRAFT payment and confirm the DELETE row.
      const anotherBill = await createAndPostBill(
        token,
        supplierA1Id,
        "2026-08-03",
        200,
      );
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${token}`)
        .send({
          supplierId: supplierA1Id,
          paymentDate: "2026-08-04",
          paymentAmountMinor: 200,
          paymentMethod: "CASH",
          bankCashAccountId: bankAccountA1Id,
          allocations: [{ billId: anotherBill.id, allocatedAmountMinor: 200 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/payments/${draft.body.data.id}`)
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
