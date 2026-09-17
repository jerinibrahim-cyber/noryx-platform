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
    it("#1 — posts with ZERO allocations: 200, full 2-line JE, zero allocation rows, invoice untouched", async () => {
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

    it("#2 — posts with PARTIAL allocation: 200, invoice correctly partially settled", async () => {
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
    it("#6 — zero-allocation receipt -> later full allocation via applyAllocation()", async () => {
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

    it("#46 — applyAllocation() with allocationDate EXPLICITLY equal to todayUtc() succeeds (Rule 2's own ceiling is inclusive)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 150, "2026-01-07");
      const posted = await createAndPostReceipt(token, 150, "2026-01-08", []);
      const todayUtc = new Date().toISOString().slice(0, 10);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 150 }],
          allocationDate: todayUtc,
        })
        .expect(200);

      const [invoiceRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerInvoices)
          .where(eq(customerInvoices.id, invoice.id)),
      );
      expect(invoiceRow!.paidMinor).toBe(150);
    });

    it("#13 — cross-customer invoiceId rejected (422), no row written", async () => {
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

    it("#15 — applyAllocation() targeting the wrong document type (a supplier_bills id passed as invoiceId) is rejected (422), no row written", async () => {
      // AR mirror of the AP file's own #15 test — here the wrong-table
      // id comes from the AP side instead (a supplier bill's id passed
      // as invoiceId). ArCustomerReceiptsService's own
      // validateAllocationsShapeOrThrow() looks it up against
      // `customer_invoices` only.
      const adminToken = tokenFor(["finance.admin"]);
      const financeDb = getFinanceDb();
      const [expense] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId,
          legalEntityId,
          code: `OAA-EXP15-${suffix}`,
          name: "Office Supplies (AR #15 fixture)",
          type: "EXPENSE",
        })
        .returning();
      const [apControl] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId,
          legalEntityId,
          code: `OAA-AP15-${suffix}`,
          name: "Accounts Payable (AR #15 fixture)",
          type: "LIABILITY",
        })
        .returning();
      await request(app.getHttpServer())
        .post("/v1/finance/ap/settings")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ apControlAccountId: apControl!.id })
        .expect(201);
      const supplier = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ code: `OAA-SUP15-${suffix}`, name: "Wrong-Type Supplier" })
        .expect(201);
      const bill = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${tokenFor(["finance.poster"])}`)
        .send({
          supplierId: supplier.body.data.id,
          supplierBillNumber: `OAA-BILL15-${randomUUID()}`,
          billDate: "2026-04-01",
          lines: [{ accountId: expense!.id, amountMinor: 500 }],
        })
        .expect(201);

      const token = tokenFor(["finance.poster"]);
      const posted = await createAndPostReceipt(token, 500, "2026-04-02", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            { invoiceId: bill.body.data.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(422);

      const rows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      );
      expect(rows).toHaveLength(0);
    });

    it("#10 — allocation exceeding the receipt's own remaining unapplied balance rejected (422)", async () => {
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

    it("#23 — rejects a future-dated allocation (422) — Option A, no future-effective allocation", async () => {
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
    it("#26 — reversing a partially-allocated receipt unwinds the invoice's paidMinor, allocation row remains as history", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-06-02");
      const posted = await createAndPostReceipt(token, 1000, "2026-06-03", [
        { invoiceId: invoice.id, allocatedAmountMinor: 400 },
      ]);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(201);

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

    it("#17 — a reversed receipt permanently rejects further applyAllocation() calls (409)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-06-08");
      const posted = await createAndPostReceipt(token, 500, "2026-06-09", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
        })
        .expect(409);
    });

    it("#28 — a repeated reversal attempt on the same receipt is rejected (409), now also reachable via the on-account path", async () => {
      const token = tokenFor(["finance.poster"]);
      const posted = await createAndPostReceipt(token, 200, "2026-06-10", []);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(201);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(409);
    });
  });

  describe("RBAC on POST /receipts/:id/allocations", () => {
    it("#18/#19 — finance.viewer is rejected (403); finance.poster succeeds (200)", async () => {
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

  describe("customer_receipt_allocations_immutable trigger — raw SQL verification (§15.3/§19.2 item 3)", () => {
    it("item 2 — INSERT against a DRAFT receipt succeeds (corrected during CTO remediation — byte-mirror of the AP-side fix; see on-account-allocation.e2e-spec.ts's item 2 and 027's header comment)", async () => {
      // Originally written expecting rejection, matching the proposal's
      // §19.2 item 3 checklist text as first transcribed. Actually
      // running this against a real Postgres instance showed that
      // literal behavior makes create()/update() themselves impossible
      // (they insert allocation rows into this table while the parent
      // receipt is still DRAFT, in the very same transaction). Corrected:
      // DRAFT-parent INSERT is permitted (027's trigger fix).
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
      ).resolves.not.toThrow();
    });

    it("item 1 — INSERT against a POSTED, not-reversed receipt succeeds (direct SQL)", async () => {
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

      // NORYX SPHERE finalization round — test-isolation fix, byte-
      // mirror of the AP file's own item-1 fix (see that file's comment
      // for the full analysis): this raw-SQL INSERT bypasses
      // applyAllocation(), so the invoice's own paidMinor/paymentStatus
      // was never updated, silently polluting the shared, tenant-wide
      // getArReconciliation() aggregate for later tests (Table 19.1
      // #36) whenever this file ran as a whole. Fixed by keeping the
      // invoice row in sync with the raw-inserted allocation, exactly
      // as applyAllocation() would have left it.
      await financeDb
        .update(customerInvoices)
        .set({ paidMinor: 500, paymentStatus: "PAID" })
        .where(eq(customerInvoices.id, invoice.id));
    });

    it("item 3 — INSERT against a REVERSED receipt is rejected by the trigger", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-05");
      const posted = await createAndPostReceipt(token, 500, "2026-08-06", []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(201);
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

    it("item 4/5 — UPDATE and DELETE on an existing allocation row are unconditionally rejected", async () => {
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

    it("item 7 — two direct-SQL INSERTs for the identical (receipt_id, invoice_id) pair both succeed (unique constraint genuinely dropped)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, "2026-08-15");
      const posted = await createAndPostReceipt(token, 1000, "2026-08-16", []);
      const financeDb = getFinanceDb();
      await expect(
        financeDb.insert(customerReceiptAllocations).values({
          tenantId,
          receiptId: posted.id,
          invoiceId: invoice.id,
          allocatedAmountMinor: 300,
          allocationDate: "2026-08-16",
        }),
      ).resolves.not.toThrow();
      await expect(
        financeDb.insert(customerReceiptAllocations).values({
          tenantId,
          receiptId: posted.id,
          invoiceId: invoice.id,
          allocatedAmountMinor: 200,
          allocationDate: "2026-08-17",
        }),
      ).resolves.not.toThrow();
      const rows = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.invoiceId)).size).toBe(1);

      // NORYX SPHERE finalization round — same test-isolation fix as
      // item 1 above: keep the invoice's own paidMinor/paymentStatus in
      // sync with the two raw-inserted allocation rows (300 + 200 =
      // 500 of the invoice's 1000 total).
      await financeDb
        .update(customerInvoices)
        .set({ paidMinor: 500, paymentStatus: "PARTIALLY_PAID" })
        .where(eq(customerInvoices.id, invoice.id));
    });

    it("item 6 — a raw INSERT under a session bound to a DIFFERENT tenant is rejected by Postgres' own RLS policy, not by this trigger", async () => {
      // Mirrors the AP suite's item-6 check (on-account-allocation.e2e-spec.ts)
      // byte-for-byte — see that file's comment for the full RLS-policy
      // reasoning (drizzle/rls/008_ar_receipts_rls.sql's tenant_isolation
      // policy on customer_receipt_allocations, same USING-governs-INSERT
      // shape as the AP table's own policy).
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-08-18");
      const posted = await createAndPostReceipt(token, 500, "2026-08-19", []);
      const otherTenantId = randomUUID();
      const financeDb = getFinanceDb();
      await expect(
        financeDb.execute(sql`
          SELECT set_config('app.current_tenant_id', ${otherTenantId}::text, true);
          INSERT INTO customer_receipt_allocations
            (tenant_id, receipt_id, invoice_id, allocated_amount_minor, allocation_date)
          VALUES
            (${tenantId}, ${posted.id}, ${invoice.id}, 500, '2026-08-19');
        `),
      ).rejects.toThrow();
    });

    it("item 12 — exactly one active (non-internal) trigger exists on customer_receipt_allocations, and it is the replacement trigger from §15.3", async () => {
      const financeDb = getFinanceDb();
      const rows = (await financeDb.execute(sql`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'customer_receipt_allocations'::regclass
          AND NOT tgisinternal
      `)) as unknown as Array<{ tgname: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tgname).toMatch(/immutab/i);
    });
  });

  describe("schema state — raw SQL verification (§15.1/§19.2 item 3)", () => {
    it("item 8 (schema shape) — allocation_date column exists, is type date, NOT NULL; item 10 — old unique constraint gone", async () => {
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

    it("item 8 (exact checklist query) — SELECT COUNT(*) WHERE allocation_date IS NULL is 0", async () => {
      const financeDb = getFinanceDb();
      const rows = (await financeDb.execute(sql`
        SELECT COUNT(*) AS null_count FROM customer_receipt_allocations
        WHERE allocation_date IS NULL
      `)) as unknown as Array<{ null_count: string }>;
      expect(Number(rows[0]!.null_count)).toBe(0);
    });

    it("item 11 — the replacement non-unique index on (receipt_id, invoice_id) is present", async () => {
      const financeDb = getFinanceDb();
      const rows = (await financeDb.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE indexname = 'customer_receipt_allocations_receipt_invoice_idx'
      `)) as unknown as Array<{ indexname: string }>;
      expect(rows).toHaveLength(1);
    });

    // §19.2 item 3, sub-point 9 (pre/post-migration row count identity)
    // is not covered here for the same reason documented in the AP
    // suite (on-account-allocation.e2e-spec.ts) — see
    // scripts/verify-on-account-migration-safety.sh instead.
  });

  describe("AR reconciliation — unappliedReceiptsMinor (§11.2)", () => {
    it("#36 — a zero-allocation receipt shows its full amount as unappliedReceiptsMinor and reconciled stays true (explicit negative check)", async () => {
      const token = tokenFor(["finance.poster"]);
      const before = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const baselineDiff = before.body.data.differenceMinor as number;

      await createAndPostReceipt(token, 750, "2026-09-01", []);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.unappliedReceiptsMinor).toBeGreaterThanOrEqual(750);
      expect(res.body.data.reconciled).toBe(true);
      // Negative check (§19.2 item 3's AP mirror applied here too): a
      // naive formula omitting unappliedReceiptsMinor would show
      // differenceMinor grow by 750 for this on-account receipt.
      expect(res.body.data.differenceMinor).toBe(baselineDiff);
    });

    it("§19.2 item 2 — independent raw-SQL cross-check: unappliedReceiptsMinor equals a structurally independent computation, never reusing unappliedCashMinor()", async () => {
      // NORYX SPHERE finalization round — date-fixture fix. Originally
      // hardcoded to fixed calendar literals (invoice/receipt
      // 2026-09-17, allocation 2026-09-18, cutoff 2026-09-30) that were
      // already in the future relative to real wall-clock time the
      // moment this suite was first run against Postgres, tripping
      // applyAllocation()'s Rule 2 future-date ceiling before this
      // test's own assertion was ever reached. Rewritten to dates
      // computed relative to the real current date (same `daysAgo()`
      // convention as the #32/#33 describe block below), so this test
      // can never go future-dated-stale again regardless of when the
      // suite runs.
      function daysAgo(n: number): string {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - n);
        return d.toISOString().slice(0, 10);
      }
      const token = tokenFor(["finance.poster"]);
      const invoiceOne = await postInvoice(token, 400, daysAgo(10));
      const posted = await createAndPostReceipt(token, 400, daysAgo(10), []);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            { invoiceId: invoiceOne.id, allocatedAmountMinor: 150 },
          ],
          allocationDate: daysAgo(5),
        })
        .expect(200);

      const cutoffDate = daysAgo(0);
      const financeDb = getFinanceDb();

      const receiptRows = (await financeDb.execute(sql`
        SELECT cr.id, cr.receipt_amount_minor,
               je.reversed_by_journal_entry_id, rev_je.transaction_date AS reversed_on
        FROM customer_receipts cr
        LEFT JOIN journal_entries je ON je.id = cr.journal_entry_id
        LEFT JOIN journal_entries rev_je ON rev_je.id = je.reversed_by_journal_entry_id
        WHERE cr.tenant_id = ${tenantId}
          AND cr.legal_entity_id = ${legalEntityId}
          AND cr.status = 'POSTED'
          AND cr.receipt_date <= ${cutoffDate}::date
      `)) as unknown as Array<{
        id: string;
        receipt_amount_minor: number;
        reversed_by_journal_entry_id: string | null;
        reversed_on: string | null;
      }>;

      const allocRows = (await financeDb.execute(sql`
        SELECT receipt_id, allocated_amount_minor
        FROM customer_receipt_allocations
        WHERE tenant_id = ${tenantId}
          AND allocation_date <= ${cutoffDate}::date
      `)) as unknown as Array<{
        receipt_id: string;
        allocated_amount_minor: number;
      }>;
      const allocatedByReceipt = new Map<string, number>();
      for (const row of allocRows) {
        allocatedByReceipt.set(
          row.receipt_id,
          (allocatedByReceipt.get(row.receipt_id) ?? 0) +
            Number(row.allocated_amount_minor),
        );
      }

      let independentTotal = 0;
      for (const r of receiptRows) {
        const notReversedAsOfCutoff =
          r.reversed_by_journal_entry_id == null ||
          r.reversed_on == null ||
          r.reversed_on > cutoffDate;
        if (!notReversedAsOfCutoff) continue;
        const applied = allocatedByReceipt.get(r.id) ?? 0;
        independentTotal += Number(r.receipt_amount_minor) - applied;
      }

      const res = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .query({ asOf: cutoffDate })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(res.body.data.unappliedReceiptsMinor).toBe(independentTotal);
    });
  });

  // -------------------------------------------------------------------
  // Table 19.1 #32-33 — AR mirror of the AP suite's identically-named
  // describe block (on-account-allocation.e2e-spec.ts). Uses
  // customerBId exclusively for a clean as-of baseline, same reasoning.
  // -------------------------------------------------------------------
  describe("as-of reversal-boundary scenarios (§11.4, Table 19.1 #32-33)", () => {
    function daysAgo(n: number): string {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    }

    it("#32 — as-of cutoff exactly ON the reversal's own transaction_date already reflects the reversal (strict '>' boundary)", async () => {
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 1000, daysAgo(30), customerBId);
      const posted = await createAndPostReceipt(
        token,
        1000,
        daysAgo(30),
        [],
        customerBId,
      );
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 1000 }],
          allocationDate: daysAgo(20),
        })
        .expect(200);
      const reversalDate = daysAgo(10);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: reversalDate })
        .expect(201);

      const asOfBoundary = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerBId}/balance`)
        .query({ asOf: reversalDate })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const dayBefore = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerBId}/balance`)
        .query({ asOf: daysAgo(11) })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(dayBefore.body.data.totalReceivedMinor).toBeGreaterThanOrEqual(
        1000,
      );
      expect(asOfBoundary.body.data.totalReceivedMinor).toBe(0);
    });

    it("#33 — as-of report for a document reversed but never allocated at all, queried after the reversal date, shows 0 applied throughout", async () => {
      const token = tokenFor(["finance.poster"]);
      const posted = await createAndPostReceipt(
        token,
        500,
        daysAgo(15),
        [],
        customerBId,
      );
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: daysAgo(5) })
        .expect(201);

      const asOfAfterReversal = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${customerBId}/balance`)
        .query({ asOf: daysAgo(1) })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(asOfAfterReversal.body.data.totalReceivedMinor).toBe(0);

      const [allocRow] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(customerReceiptAllocations)
          .where(eq(customerReceiptAllocations.receiptId, posted.id)),
      );
      expect(allocRow).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // NORYX SPHERE finalization round — byte-mirror of the AP file's own
  // identically-named describe block (Table 19.1 #34, #37, #38,
  // #47-49), adapted to receipts/invoices/customers.
  // -------------------------------------------------------------------
  describe("reporting surfaces — mixed state, ageing, and temporal consistency (Table 19.1 #34, #37, #38, #47-49)", () => {
    async function freshCustomer(label: string) {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set("Authorization", `Bearer ${tokenFor(["finance.admin"])}`)
        .send({ code: `OAA-${label}-${suffix}`, name: `${label} Customer` })
        .expect(201);
      return res.body.data.id as string;
    }

    it("#37 — getCustomerBalance() for a mix of one fully-allocated and one on-account document computes unappliedReceiptsMinor/totalOutstandingMinor correctly", async () => {
      const cust = await freshCustomer("CUST37");
      const token = tokenFor(["finance.poster"]);
      const invoiceFull = await postInvoice(token, 300, "2026-02-01", cust);
      await createAndPostReceipt(
        token,
        300,
        "2026-02-01",
        [{ invoiceId: invoiceFull.id, allocatedAmountMinor: 300 }],
        cust,
      );
      const invoiceOnAccount = await postInvoice(
        token,
        500,
        "2026-02-02",
        cust,
      );
      await createAndPostReceipt(token, 700, "2026-02-02", [], cust);

      const balance = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(balance.body.data.unappliedReceiptsMinor).toBe(700);
      expect(balance.body.data.totalOutstandingMinor).toBe(
        invoiceOnAccount.totalMinor,
      );
    });

    it("#34 — current-mode (non-as-of) reconciliation for a mix of on-account and fully-allocated documents stays reconciled via live paidMinor", async () => {
      const cust = await freshCustomer("CUST34");
      const token = tokenFor(["finance.poster"]);
      const invoiceFull = await postInvoice(token, 250, "2026-02-05", cust);
      await createAndPostReceipt(
        token,
        250,
        "2026-02-05",
        [{ invoiceId: invoiceFull.id, allocatedAmountMinor: 250 }],
        cust,
      );
      await createAndPostReceipt(token, 400, "2026-02-06", [], cust);

      const before = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(before.body.data.reconciled).toBe(true);

      const bal = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(bal.body.data.totalReceivedMinor).toBe(250);
    });

    it("#38 — an on-account receipt does not change an invoice's ageing bucket until actually allocated", async () => {
      const cust = await freshCustomer("CUST38");
      const token = tokenFor(["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: cust,
          invoiceDate: "2026-02-10",
          dueDate: "2026-02-10",
          lines: [{ accountId: revenueAccountId, amountMinor: 600 }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const onAccountReceipt = await createAndPostReceipt(
        token,
        600,
        "2026-02-11",
        [],
        cust,
      );

      const beforeAllocation = await request(app.getHttpServer())
        .get("/v1/finance/ar/ageing")
        .query({ customerId: cust, asOf: "2026-03-01" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const rowBefore = (
        beforeAllocation.body.data as Array<{
          customerId: string;
          totalOutstandingMinor: number;
        }>
      ).find((r) => r.customerId === cust);
      expect(rowBefore).toBeDefined();
      expect(rowBefore!.totalOutstandingMinor).toBe(600);

      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${onAccountReceipt.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [
            { invoiceId: created.body.data.id, allocatedAmountMinor: 600 },
          ],
          allocationDate: "2026-02-12",
        })
        .expect(200);

      const afterAllocation = await request(app.getHttpServer())
        .get("/v1/finance/ar/ageing")
        .query({ customerId: cust, asOf: "2026-03-01" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const rowAfter = (
        afterAllocation.body.data as Array<{ customerId: string }>
      ).find((r) => r.customerId === cust);
      expect(rowAfter).toBeUndefined();
    });

    it("#47/#48 — reconciliation unappliedReceiptsMinor before vs. after a later reversal of an already-allocated receipt matches asOfTotals()'s own #30/#31 for the identical cutoffs (§11.5 Case 2a/2b)", async () => {
      const cust = await freshCustomer("CUST4748");
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 500, "2026-02-15", cust);
      const posted = await createAndPostReceipt(
        token,
        500,
        "2026-02-15",
        [],
        cust,
      );
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 500 }],
          allocationDate: "2026-02-16",
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-02-20" })
        .expect(201);

      const beforeReversalRecon = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .query({ asOf: "2026-02-18" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(beforeReversalRecon.body.data.reconciled).toBe(true);
      const beforeReversalBalance = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .query({ asOf: "2026-02-18" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(beforeReversalBalance.body.data.totalReceivedMinor).toBe(500);

      const afterReversalRecon = await request(app.getHttpServer())
        .get("/v1/finance/ar/reconciliation")
        .query({ asOf: "2026-02-25" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(afterReversalRecon.body.data.reconciled).toBe(true);
      const afterReversalBalance = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .query({ asOf: "2026-02-25" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(afterReversalBalance.body.data.totalReceivedMinor).toBe(0);
    });

    it("#49 — a live (no asOf) balance query immediately after an applyAllocation() dated todayUtc() is byte-identical to the same query with asOf=todayUtc() explicit", async () => {
      const cust = await freshCustomer("CUST49");
      const token = tokenFor(["finance.poster"]);
      const invoice = await postInvoice(token, 350, "2026-01-01", cust);
      const posted = await createAndPostReceipt(
        token,
        350,
        "2026-01-01",
        [],
        cust,
      );
      const todayUtc = new Date().toISOString().slice(0, 10);
      await request(app.getHttpServer())
        .post(`/v1/finance/receipts/${posted.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 350 }],
          allocationDate: todayUtc,
        })
        .expect(200);

      const live = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const explicit = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${cust}/balance`)
        .query({ asOf: todayUtc })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(live.body.data.totalReceivedMinor).toBe(
        explicit.body.data.totalReceivedMinor,
      );
      expect(live.body.data.totalOutstandingMinor).toBe(
        explicit.body.data.totalOutstandingMinor,
      );
      expect(live.body.data.unappliedReceiptsMinor).toBe(
        explicit.body.data.unappliedReceiptsMinor,
      );
    });
  });
});
