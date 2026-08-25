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
  and,
  eq,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import { chartOfAccounts, supplierBills } from "../src/db/schema";
import { sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1c — proves docs/finance-work-item-1c-supplier-payments-proposal.md
 * §9's claims: once a payment posts real journal_entries/journal_lines
 * rows, the EXISTING, UNMODIFIED General Ledger read endpoints
 * (`GET /accounts/:id/balance`, `GET /accounts/:id/ledger`,
 * `GET /trial-balance`) reflect it automatically — the AP control
 * account debits down, the bank/cash account credits down — with zero
 * AP-specific code in the GL read layer. Also proves the sub-ledger/GL
 * reconciliation invariant the AP-1a proposal names explicitly (§10 of
 * that document): after a sequence of bill and payment postings,
 * SUM(supplier_bills.totalMinor - paidMinor) across a legal entity's
 * open (non-fully-paid) bills equals the GL's own closing balance of
 * the AP control account.
 */
describe("AP-1c — GL integration & sub-ledger/GL reconciliation", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string; // AP control
  let bankAccountId: string;
  let supplierId: string;
  let suffix: number;

  function tokenFor(roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
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
      .values({ slug: `pay-gl-e2e-${suffix}`, name: "Payment GL E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Payment GL E2E Entity",
        code: "PAYGL1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [expense] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYGL-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYGL-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PAYGL-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = expense!.id;
    liabilityAccountId = liability!.id;
    bankAccountId = bank!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountId })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `PAYGL-SUP-${suffix}`, name: "GL Test Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PAYGL-OPEN-${suffix}`,
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

  it("a posted payment's amounts appear in the AP control account's balance/ledger and the bank account's balance/ledger, and in trial balance — via the existing, unmodified GL endpoints", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    const apBefore = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const apClosingBefore = apBefore.body.data.closingBalanceMinor as number;

    const bankBefore = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${bankAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const bankClosingBefore = bankBefore.body.data
      .closingBalanceMinor as number;

    const bill = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `PAYGL-BILL-${suffix}`,
        billDate: "2026-09-01",
        lines: [{ accountId: expenseAccountId, amountMinor: 5000 }],
      })
      .expect(201);
    const postedBill = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${bill.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const payment = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate: "2026-09-05",
        paymentAmountMinor: 5000,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [
          { billId: postedBill.body.data.id, allocatedAmountMinor: 5000 },
        ],
      })
      .expect(201);
    const postedPayment = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${payment.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(postedPayment.body.data.paymentAmountMinor).toBe(5000);

    // AP control — payment DEBITS it (a LIABILITY's normal balance is
    // CREDIT, so a debit-side posting decreases closingBalanceMinor).
    const apAfter = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(apAfter.body.data.closingBalanceMinor).toBe(
      apClosingBefore + 5000 - 5000, // the bill credited 5000, the payment debited 5000 back
    );

    // Bank/cash — payment CREDITS it (an ASSET's normal balance is
    // DEBIT, so a credit-side posting decreases closingBalanceMinor).
    const bankAfter = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${bankAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(bankAfter.body.data.closingBalanceMinor).toBe(
      bankClosingBefore - 5000,
    );
    expect(bankAfter.body.data.totalCreditMinor).toBeGreaterThanOrEqual(5000);

    // Ledger — the payment's journal entry line appears against the
    // bank account, with the same journalEntryId the payment records.
    const bankLedger = await request(app.getHttpServer())
      .get(
        `/v1/finance/accounts/${bankAccountId}/ledger?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const ledgerRow = bankLedger.body.data.find(
      (row: { journalEntryId: string }) =>
        row.journalEntryId === postedPayment.body.data.journalEntryId,
    );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.creditMinor).toBe(5000);

    // Trial balance — total debits still equal total credits across the
    // whole entity after both the bill and the payment posted.
    const trialBalance = await request(app.getHttpServer())
      .get("/v1/finance/trial-balance?asOf=2026-12-31")
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(trialBalance.body.meta.totalDebitMinor).toBe(
      trialBalance.body.meta.totalCreditMinor,
    );
  });

  it("sub-ledger/GL reconciliation invariant: SUM(bill outstanding balances) equals the GL's AP control account closing balance, after a mixed sequence of bill and payment postings", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    // Three bills, two paid (one fully, one partially), one untouched.
    async function postBill(amountMinor: number, dateSuffix: string) {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          supplierId,
          supplierBillNumber: `PAYGL-RECON-${dateSuffix}-${suffix}`,
          billDate: `2026-10-${dateSuffix}`,
          lines: [{ accountId: expenseAccountId, amountMinor }],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      return posted.body.data;
    }

    const billFull = await postBill(1000, "01");
    const billPartial = await postBill(2000, "02");
    const billUntouched = await postBill(500, "03");

    const payFull = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate: "2026-10-10",
        paymentAmountMinor: 1000,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billFull.id, allocatedAmountMinor: 1000 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${payFull.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const payPartial = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate: "2026-10-11",
        paymentAmountMinor: 800,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billPartial.id, allocatedAmountMinor: 800 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${payPartial.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    void billUntouched; // left fully outstanding, deliberately

    // Sub-ledger side: SUM(total_minor - paid_minor) across every POSTED
    // bill for this supplier/legal entity.
    const subledgerOutstanding = await withTenant(tenantId, (tx) =>
      tx
        .select({
          total: sql<string>`SUM(${supplierBills.totalMinor} - ${supplierBills.paidMinor})`,
        })
        .from(supplierBills)
        .where(
          and(
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
            eq(supplierBills.status, "POSTED"),
          ),
        )
        .then((rows) => Number(rows[0]!.total)),
    );

    // GL side: the AP control account's own closing balance.
    const apBalance = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(subledgerOutstanding).toBe(apBalance.body.data.closingBalanceMinor);
    // Concretely, of THIS test's three bills: billFull is fully paid
    // (1000 - 1000 = 0 outstanding), billPartial is 2000 - 800 = 1200
    // outstanding, billUntouched is 500 - 0 = 500 outstanding — plus the
    // preceding test's bill in this same legal entity, also fully paid
    // (0 outstanding). The invariant check above (equality with the GL's
    // own AP control balance) is what actually matters; this fixed
    // value just pins the arithmetic concretely for this test's own data.
    expect(subledgerOutstanding).toBe(0 + 1200 + 500 + 0);
  });
});
