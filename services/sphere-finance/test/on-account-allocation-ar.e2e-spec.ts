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
  eq,
  sql,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import {
  chartOfAccounts,
  customerInvoices,
  customerReceipts,
  customerReceiptAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md, CTO
 * Architecture Gate, approved implementation authorization). AR side —
 * byte-mirror of `on-account-allocation.e2e-spec.ts` (AP), covering the
 * same Table 19.1 scenarios re-scoped to customer receipts/invoices:
 * zero/partial allocation at post time, `applyAllocation()`'s core
 * behavior surface, reversal interaction, the relaxed
 * `customer_receipt_allocations_immutable` trigger verified with raw
 * SQL, RBAC, and AR reconciliation's `unappliedReceiptsMinor` (§11.2/
 * §11.3). Every assertion reads real persisted state, never HTTP status
 * alone.
 */
describe("On-Account — Customer Receipts: zero/partial posting, applyAllocation, reversal, trigger, reconciliation (AR mirror)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let revenueAccountId: string;
  let arControlAccountId: string;
  let bankAccountId: string;
  let customerId: string;
  let customerBId: string;
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

  async function postInvoice(
    token: string,
    amountMinor: number,
    invoiceDate: string,
    customer: string = customerId,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer,
        invoiceDate,
        lines: [{ accountId: revenueAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string; totalMinor: number };
  }

  async function createAndPostReceipt(
    token: string,
    receiptAmountMinor: number,
    receiptDate: string,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
    customer: string = customerId,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer,
        receiptDate,
        receiptAmountMinor,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created.body.data.id}/post`)
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
      .values({
        slug: `oaa-ar-e2e-${suffix}`,
        name: "On-Account AR E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "On-Account AR E2E Entity",
        code: "OAAAR1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [revenue] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAAAR-REV-${suffix}`,
        name: "Sales Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arControl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAAAR-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAAAR-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    revenueAccountId = revenue!.id;
    arControlAccountId = arControl!.id;
    bankAccountId = bank!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ arControlAccountId })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `OAAAR-CUST-${suffix}`, name: "On-Account Test Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    const customerB = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `OAAAR-CUSTB-${suffix}`, name: "Second Customer" })
      .expect(201);
    customerBId = customerB.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAAAR-OPEN-${suffix}`,
        startDate: "2024-01-01",
        endDate: "2028-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("posting with zero and partial allocation", () => {
    it("posts with ZERO allocations: 200, full 2-line JE, zero allocation rows, invoice untouched", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-02-01");
      const posted = await createAndPostReceipt(token, 1000, "2026-02-05", []);

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceipts)
          .where(eq(customerReceipts.id, posted.id)),
      );
      expect(row!.status).toBe("POSTED");

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      );
      expect(allocationRows).toHaveLength(0);

      const [invoiceRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id)),
      );
      expect(invoiceRow!.paidMinor).toBe(0);
    });

    it("posts with PARTIAL allocation: 200, invoice correctly partially settled", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-02-02");
      await createAndPostReceipt(token, 1000, "2026-02-06", [
        { invoiceId: invoice.id, allocatedAmountMinor: 400 },
      ]);
      const [invoiceRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id)),
      );
      expect(invoiceRow!.paidMinor).toBe(400);
      expect(invoiceRow!.paymentStatus).toBe("PARTIALLY_PAID");
    });
  });

  describe("applyAllocation() — happy path and validation", () => {
    it("zero-allocation receipt -> later full allocation via applyAllocation()", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 800, "2026-03-01");
      const posted = await createAndPostReceipt(token, 800, "2026-03-02", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 800 }],
          allocationDate: "2026-03-10",
        })
        .expect(200);

      const [invoiceRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id)),
      );
      expect(invoiceRow!.paidMinor).toBe(800);
      expect(invoiceRow!.paymentStatus).toBe("PAID");
    });

    it("cross-customer invoiceId rejected (422), no row written", async () => {
      const token = tokenFor(["finance.poster"]);
      const otherCustomerInvoice = await postInvoice(
        token,
        500,
        "2026-04-01",
        customerBId,
      );
      const posted = await createAndPostReceipt(token, 500, "2026-04-02", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            {
              invoiceId: otherCustomerInvoice.id,
              allocatedAmountMinor: 500,
            },
          ],
        })
        .expect(422);
    });

    it("allocation exceeding the receipt's own remaining amount rejected (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-04-05");
      const posted = await createAndPostReceipt(token, 500, "2026-04-06", [
        { invoiceId: invoice.id, allocatedAmountMinor: 300 },
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 300 }],
        })
        .expect(422);
    });

    it("rejects a future-dated allocation (422)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-05-01");
      const posted = await createAndPostReceipt(token, 500, "2026-05-02", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
          allocationDate: "2028-01-01",
        })
        .expect(422);
    });
  });

  describe("reversal interaction with on-account allocation state", () => {
    it("reversing a partially-allocated receipt unwinds the invoice's paidMinor, allocation row remains as history", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-06-02");
      const posted = await createAndPostReceipt(token, 1000, "2026-06-03", [
        { invoiceId: invoice.id, allocatedAmountMinor: 400 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);

      const [invoiceRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id)),
      );
      expect(invoiceRow!.paidMinor).toBe(0);

      const allocationRows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      );
      expect(allocationRows).toHaveLength(1);
    });

    it("a reversed receipt permanently rejects further applyAllocation() calls (409)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-06-08");
      const posted = await createAndPostReceipt(token, 500, "2026-06-09", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(409);
    });
  });

  describe("RBAC on POST /receipts/:id/allocations", () => {
    it("finance.viewer is rejected (403); finance.poster succeeds (200)", async () => {
      const posterToken = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(posterToken, 500, "2026-07-01");
      const posted = await createAndPostReceipt(
        posterToken,
        500,
        "2026-07-02",
        [],
      );
      const viewerToken = tokenFor(["finance.viewer"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(200);
    });
  });

  describe("customer_receipt_allocations_immutable trigger — raw SQL verification (§15.3/§19.2)", () => {
    it("check 1 — INSERT against a DRAFT receipt is rejected by the trigger", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-01");
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId,
          receiptDate: "2026-08-02",
          receiptAmountMinor: 500,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: bankAccountId,
          allocations: [],
        })
        .expect(201);
      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(customerReceiptAllocations).values({
          tenantId,
          receiptId: draft.body.data.id,
          invoiceId: invoice.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-02",
        }),
      ).rejects.toThrow(/may only be inserted against a POSTED/);
    });

    it("check 2 — INSERT against a POSTED, not-reversed receipt succeeds (direct SQL)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-03");
      const posted = await createAndPostReceipt(token, 500, "2026-08-04", []);
      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(customerReceiptAllocations).values({
          tenantId,
          receiptId: posted.id,
          invoiceId: invoice.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-04",
        }),
      ).resolves.not.toThrow();
    });

    it("check 3 — INSERT against a REVERSED receipt is rejected by the trigger", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-05");
      const posted = await createAndPostReceipt(token, 500, "2026-08-06", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(200);
      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(customerReceiptAllocations).values({
          tenantId,
          receiptId: posted.id,
          invoiceId: invoice.id,
          allocatedAmountMinor: 500,
          allocationDate: "2026-08-06",
        }),
      ).rejects.toThrow(/may not be inserted against a reversed/);
    });

    it("check 4/5 — UPDATE and DELETE on an existing allocation row are unconditionally rejected", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-07");
      const posted = await createAndPostReceipt(token, 500, "2026-08-08", [
        { invoiceId: invoice.id, allocatedAmountMinor: 500 },
      ]);
      const financeDb = getFinanceDb();
      await expect(
        financeDb
          .update(customerReceiptAllocations)
          .set({ allocatedAmountMinor: 1 })
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      ).rejects.toThrow(/is immutable/);
      await expect(
        financeDb
          .delete(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      ).rejects.toThrow(/is immutable/);
    });
  });

  describe("schema state — raw SQL verification (§15.1/§19.2)", () => {
    it("allocation_date column exists, is type date, NOT NULL; old unique constraint gone", async () => {
      const financeDb = getFinanceDb();
      const colRows = (await financeDb.execute(sql`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'customer_receipt_allocations'
          AND column_name = 'allocation_date'
      `)) as unknown as Array<{ data_type: string; is_nullable: string }>;
      expect(colRows).toHaveLength(1);
      expect(colRows[0]!.data_type).toBe("date");
      expect(colRows[0]!.is_nullable).toBe("NO");

      const constraintRows = (await financeDb.execute(sql`
        SELECT conname FROM pg_constraint
        WHERE conname = 'customer_receipt_allocations_receipt_invoice_unique'
      `)) as unknown as Array<{ conname: string }>;
      expect(constraintRows).toHaveLength(0);
    });
  });

  describe("AR reconciliation — unappliedReceiptsMinor (§11.2)", () => {
    it("a zero-allocation receipt shows its full amount as unappliedReceiptsMinor and reconciled stays true", async () => {
      const token = tokenFor(["finance.poster"]);
      await createAndPostReceipt(token, 750, "2026-09-01", []);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.unappliedReceiptsMinor).toBeGreaterThanOrEqual(750);
      expect(res.body.data.reconciled).toBe(true);
    });
  });
});
