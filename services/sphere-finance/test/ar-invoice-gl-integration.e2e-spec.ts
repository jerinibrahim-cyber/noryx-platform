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
 * AR-1b — proves docs/finance-work-item-ar-1b-customer-invoicing-proposal.md
 * §7's claim directly: once a customer invoice posts real journal_entries/
 * journal_lines rows, the EXISTING, UNMODIFIED General Ledger read
 * endpoints (`GET /accounts/:id/balance`, `GET /accounts/:id/ledger`,
 * `GET /trial-balance`) reflect it automatically, with zero AR-specific
 * code in the GL read layer. Mirrors ap-bill-gl-integration.e2e-spec.ts
 * with the debit/credit polarity inverted: the AR control account is an
 * ASSET (debit-normal), so a posted invoice increases its balance via a
 * DEBIT-side posting — the opposite of AP's credit-side liability
 * posting.
 */
describe("AR-1b — GL integration (customer invoices post through the real, unmodified GL read layer)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let revenueAccountId: string;
  let arControlAccountId: string;
  let taxOutputAccountId: string;
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
      .values({ slug: `inv-gl-e2e-${suffix}`, name: "Invoice GL E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Invoice GL E2E Entity",
        code: "INVGL1",
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
        code: `INVGL-REV-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arControl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `INVGL-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [taxOutput] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `INVGL-TAX-${suffix}`,
        name: "Output VAT",
        type: "LIABILITY",
      })
      .returning();
    revenueAccountId = revenue!.id;
    arControlAccountId = arControl!.id;
    taxOutputAccountId = taxOutput!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        arControlAccountId,
        taxOutputAccountId,
      })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `INVGL-CUST-${suffix}`, name: "GL Test Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INVGL-OPEN-${suffix}`,
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

  it("a posted invoice's amounts appear in the AR control account's balance/ledger, and in trial balance — via the existing, unmodified GL endpoints", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    // Baseline: AR control account balance before this invoice.
    const before = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arControlAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const closingBefore = before.body.data.closingBalanceMinor as number;

    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        invoiceDate: "2026-09-01",
        lines: [
          {
            accountId: revenueAccountId,
            amountMinor: 1000,
            taxAmountMinor: 50,
          },
        ],
      })
      .expect(201);

    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(posted.body.data.totalMinor).toBe(1050);

    // Account Balance — an ASSET's normal balance is DEBIT, so a
    // debit-side posting increases closingBalanceMinor (the mirror of
    // AP's liability/credit-side increase).
    const after = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arControlAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(after.body.data.closingBalanceMinor).toBe(closingBefore + 1050);
    expect(after.body.data.totalDebitMinor).toBeGreaterThanOrEqual(1050);

    // Account Ledger — the posted journal entry's line appears against
    // the AR control account, on the debit side, with the same
    // journalEntryId the invoice records.
    const ledger = await request(app.getHttpServer())
      .get(
        `/v1/finance/accounts/${arControlAccountId}/ledger?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const ledgerRow = ledger.body.data.find(
      (row: { journalEntryId: string }) =>
        row.journalEntryId === posted.body.data.journalEntryId,
    );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.debitMinor).toBe(1050);

    // Trial Balance — the AR control account's debit total reflects the
    // invoice, and total debits still equal total credits across the
    // whole entity (the fundamental invariant, proven here at the report
    // level rather than just the single-entry level).
    const trialBalance = await request(app.getHttpServer())
      .get("/v1/finance/trial-balance?asOf=2026-12-31")
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(trialBalance.body.meta.totalDebitMinor).toBe(
      trialBalance.body.meta.totalCreditMinor,
    );
    const arRow = trialBalance.body.data.find(
      (row: { accountId: string }) => row.accountId === arControlAccountId,
    );
    expect(arRow).toBeDefined();
    expect(arRow.debitMinor).toBeGreaterThanOrEqual(1050);
  });
});
