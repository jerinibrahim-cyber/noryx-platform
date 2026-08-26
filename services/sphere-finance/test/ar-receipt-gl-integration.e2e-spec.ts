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
  lte,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import { chartOfAccounts, customerInvoices } from "../src/db/schema";
import { sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AR-1c — proves docs/finance-work-item-1c-customer-receipts-proposal.md
 * §9's claims: once a receipt posts real journal_entries/journal_lines
 * rows, the EXISTING, UNMODIFIED General Ledger read endpoints
 * (`GET /accounts/:id/balance`, `GET /accounts/:id/ledger`,
 * `GET /trial-balance`) reflect it automatically — the AR control
 * account credits down, the bank/cash account debits up — with zero
 * AR-receipt-specific code in the GL read layer. Also proves the
 * precise §12.1 reconciliation invariant (CTO-approved correction 3):
 * at a shared asOf, SUM(customer_invoices.totalMinor - paidMinor) over
 * POSTED invoices with invoiceDate <= asOf, scoped to one
 * (tenantId, legalEntityId), equals that legal entity's AR control
 * account closing balance via the unmodified
 * `GET /accounts/:id/balance?asOf=<asOf>` endpoint.
 */
describe("AR-1c — GL integration & sub-ledger/GL reconciliation", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let revenueAccountId: string;
  let arControlAccountId: string;
  let bankAccountId: string;
  let customerId: string;
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
      .values({ slug: `rcpt-gl-e2e-${suffix}`, name: "Receipt GL E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Receipt GL E2E Entity",
        code: "RCPTGL1",
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
        code: `RCPTGL-REV-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arControl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `RCPTGL-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `RCPTGL-BANK-${suffix}`,
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
      .send({ code: `RCPTGL-CUST-${suffix}`, name: "GL Test Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `RCPTGL-OPEN-${suffix}`,
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

  it("a posted receipt's amounts appear in the AR control account's balance/ledger and the bank account's balance/ledger, and in trial balance — via the existing, unmodified GL endpoints", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    const arBefore = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arControlAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const arClosingBefore = arBefore.body.data.closingBalanceMinor as number;

    const bankBefore = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${bankAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const bankClosingBefore = bankBefore.body.data
      .closingBalanceMinor as number;

    const invoice = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        invoiceDate: "2026-09-01",
        lines: [
          { accountId: revenueAccountId, amountMinor: 5000, taxAmountMinor: 0 },
        ],
      })
      .expect(201);
    const postedInvoice = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${invoice.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const receipt = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-09-05",
        receiptAmountMinor: 5000,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [
          { invoiceId: postedInvoice.body.data.id, allocatedAmountMinor: 5000 },
        ],
      })
      .expect(201);
    const postedReceipt = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${receipt.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(postedReceipt.body.data.receiptAmountMinor).toBe(5000);

    // AR control — the invoice CREDITED it +5000 (an ASSET's normal
    // balance is DEBIT, so a credit-side posting decreases
    // closingBalanceMinor)... wait, AR-1b's invoice posting DEBITS AR
    // control (the receivable increases when an invoice is raised) and
    // CREDITS revenue/tax. The receipt then CREDITS AR control back down
    // (mirror image, proposal §9) — net zero across invoice+receipt.
    const arAfter = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arControlAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(arAfter.body.data.closingBalanceMinor).toBe(
      arClosingBefore + 5000 - 5000, // the invoice debited 5000, the receipt credited 5000 back
    );

    // Bank/cash — receipt DEBITS it (an ASSET's normal balance is DEBIT,
    // so a debit-side posting increases closingBalanceMinor).
    const bankAfter = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${bankAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(bankAfter.body.data.closingBalanceMinor).toBe(
      bankClosingBefore + 5000,
    );
    expect(bankAfter.body.data.totalDebitMinor).toBeGreaterThanOrEqual(5000);

    // Ledger — the receipt's journal entry line appears against the
    // bank account, with the same journalEntryId the receipt records.
    const bankLedger = await request(app.getHttpServer())
      .get(
        `/v1/finance/accounts/${bankAccountId}/ledger?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const ledgerRow = bankLedger.body.data.find(
      (row: { journalEntryId: string }) =>
        row.journalEntryId === postedReceipt.body.data.journalEntryId,
    );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.debitMinor).toBe(5000);

    // Trial balance — total debits still equal total credits across the
    // whole entity after both the invoice and the receipt posted.
    const trialBalance = await request(app.getHttpServer())
      .get("/v1/finance/trial-balance?asOf=2026-12-31")
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(trialBalance.body.meta.totalDebitMinor).toBe(
      trialBalance.body.meta.totalCreditMinor,
    );
  });

  it("§12.1 reconciliation invariant: SUM(invoice outstanding balances) equals the GL's AR control account closing balance at a shared asOf, after a mixed sequence of invoice and receipt postings", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    // Three invoices, two settled (one fully, one partially), one
    // untouched.
    async function postInvoice(amountMinor: number, dateSuffix: string) {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          customerId,
          invoiceDate: `2026-10-${dateSuffix}`,
          lines: [
            { accountId: revenueAccountId, amountMinor, taxAmountMinor: 0 },
          ],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      return posted.body.data;
    }

    const invoiceFull = await postInvoice(1000, "01");
    const invoicePartial = await postInvoice(2000, "02");
    const invoiceUntouched = await postInvoice(500, "03");

    const receiptFull = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-10-10",
        receiptAmountMinor: 1000,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [
          { invoiceId: invoiceFull.id, allocatedAmountMinor: 1000 },
        ],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${receiptFull.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const receiptPartial = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate: "2026-10-11",
        receiptAmountMinor: 800,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [
          { invoiceId: invoicePartial.id, allocatedAmountMinor: 800 },
        ],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${receiptPartial.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    void invoiceUntouched; // left fully outstanding, deliberately

    const asOf = "2026-12-31";

    // Sub-ledger side: SUM(total_minor - paid_minor) across every POSTED
    // invoice for this legal entity with invoiceDate <= asOf (§12.1's
    // exact filter set).
    const subledgerOutstanding = await withTenant(tenantId, (tx) =>
      tx
        .select({
          total: sql<string>`SUM(${customerInvoices.totalMinor} - ${customerInvoices.paidMinor})`,
        })
        .from(customerInvoices)
        .where(
          and(
            eq(customerInvoices.tenantId, tenantId),
            eq(customerInvoices.legalEntityId, legalEntityId),
            eq(customerInvoices.status, "POSTED"),
            lte(customerInvoices.invoiceDate, asOf),
          ),
        )
        .then((rows) => Number(rows[0]!.total)),
    );

    // GL side: the AR control account's own closing balance at the same
    // asOf — the unmodified GeneralLedgerService endpoint.
    const arBalance = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arControlAccountId}/balance?asOf=${asOf}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(subledgerOutstanding).toBe(arBalance.body.data.closingBalanceMinor);
    // Concretely, of THIS test's three invoices: invoiceFull is fully
    // settled (1000 - 1000 = 0 outstanding), invoicePartial is
    // 2000 - 800 = 1200 outstanding, invoiceUntouched is 500 - 0 = 500
    // outstanding — plus the preceding test's invoice in this same legal
    // entity, also fully settled (0 outstanding). The invariant check
    // above (equality with the GL's own AR control balance) is what
    // actually matters; this fixed value just pins the arithmetic
    // concretely for this test's own data.
    expect(subledgerOutstanding).toBe(0 + 1200 + 500 + 0);
  });
});
