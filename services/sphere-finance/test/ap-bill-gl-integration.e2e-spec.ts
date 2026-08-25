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
 * AP-1b — proves docs/finance-work-item-1b-supplier-bills-proposal.md
 * §9's claim directly: once a bill posts real journal_entries/
 * journal_lines rows, the EXISTING, UNMODIFIED General Ledger read
 * endpoints (`GET /accounts/:id/balance`, `GET /accounts/:id/ledger`,
 * `GET /trial-balance`) reflect it automatically, with zero AP-specific
 * code in the GL read layer — the concrete verification of the
 * roadmap's "no parallel posting mechanism" completion-gate language.
 */
describe("AP-1b — GL integration (bills post through the real, unmodified GL read layer)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let taxInputAccountId: string;
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
      .values({ slug: `bill-gl-e2e-${suffix}`, name: "Bill GL E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Bill GL E2E Entity",
        code: "BILLGL1",
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
        code: `BILLGL-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `BILLGL-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [taxInput] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `BILLGL-TAX-${suffix}`,
        name: "Input VAT",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = expense!.id;
    liabilityAccountId = liability!.id;
    taxInputAccountId = taxInput!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        apControlAccountId: liabilityAccountId,
        taxInputAccountId: taxInputAccountId,
      })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `BILLGL-SUP-${suffix}`, name: "GL Test Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILLGL-OPEN-${suffix}`,
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

  it("a posted bill's amounts appear in the AP control account's balance/ledger, and in trial balance — via the existing, unmodified GL endpoints", async () => {
    const posterToken = tokenFor(["finance.poster"]);

    // Baseline: AP control account balance before this bill.
    const before = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const closingBefore = before.body.data.closingBalanceMinor as number;

    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `GL-INTEGRATION-${suffix}`,
        billDate: "2026-09-01",
        lines: [
          {
            accountId: expenseAccountId,
            amountMinor: 1000,
            taxAmountMinor: 50,
          },
        ],
      })
      .expect(201);

    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(posted.body.data.totalMinor).toBe(1050);

    // Account Balance — a LIABILITY's normal balance is CREDIT, so a
    // credit-side posting increases closingBalanceMinor.
    const after = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${liabilityAccountId}/balance?asOf=2026-12-31`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(after.body.data.closingBalanceMinor).toBe(closingBefore + 1050);
    expect(after.body.data.totalCreditMinor).toBeGreaterThanOrEqual(1050);

    // Account Ledger — the posted journal entry's line appears, with the
    // bill's own memo text ("Supplier bill BILL-...") and the same
    // journalEntryId the bill records.
    const ledger = await request(app.getHttpServer())
      .get(
        `/v1/finance/accounts/${liabilityAccountId}/ledger?dateFrom=2026-01-01&dateTo=2026-12-31`,
      )
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const ledgerRow = ledger.body.data.find(
      (row: { journalEntryId: string }) =>
        row.journalEntryId === posted.body.data.journalEntryId,
    );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.creditMinor).toBe(1050);

    // Trial Balance — the AP control account's credit total reflects the
    // bill, and total debits still equal total credits across the whole
    // entity (the fundamental invariant, proven here at the report
    // level rather than just the single-entry level).
    const trialBalance = await request(app.getHttpServer())
      .get("/v1/finance/trial-balance?asOf=2026-12-31")
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(trialBalance.body.meta.totalDebitMinor).toBe(
      trialBalance.body.meta.totalCreditMinor,
    );
    const apRow = trialBalance.body.data.find(
      (row: { accountId: string }) => row.accountId === liabilityAccountId,
    );
    expect(apRow).toBeDefined();
    expect(apRow.creditMinor).toBeGreaterThanOrEqual(1050);
  });
});
