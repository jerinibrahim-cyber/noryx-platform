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
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md §3.7, Table
 * 19.1 #39-40, CTO remediation of the independent quality-gate audit).
 *
 * §3.7 claims Balance Sheet and Cash Flow Statement require ZERO code
 * change — the existing header-amount-driven journal posting (a POSTED
 * payment always debits the AP control account / credits the bank
 * account for the full `paymentAmountMinor`, unconditionally of
 * allocation state, §3.4) already produces the correct GL effect for an
 * on-account (zero/partial-allocation) payment, exactly as it does for a
 * fully-allocated one. This file is the smallest-possible regression
 * proof of that claim — a dedicated, isolated fixture, not an addition
 * to financial-statements-balance-sheet.e2e-spec.ts or
 * financial-statements-cash-flow.e2e-spec.ts, since neither of those
 * files' own fixtures needs to change and this work item's own tests
 * should not be interleaved into theirs. financial-statements.service.ts
 * itself is untouched by this work item (confirmed by the diff against
 * the pre-implementation baseline) — these are regression tests, not new
 * feature tests.
 */
describe("On-Account — Balance Sheet & Cash Flow regression (§3.7, Table 19.1 #39-40)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
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
      .values({
        slug: `oaa-fs-e2e-${suffix}`,
        name: "On-Account FS E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "On-Account FS E2E Entity",
        code: "OAAFS1",
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
        code: `OAAFS-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAAFS-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAAFS-BANK-${suffix}`,
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

    // Cash Flow's own cash-identification mechanism (distinct from the
    // apControlAccountId setting above) — registering the same bank
    // asset account here is what lets financial-statements.service.ts
    // recognize it as cash rather than requiring an OPERATING/
    // INVESTING/FINANCING classification.
    await request(app.getHttpServer())
      .post("/v1/finance/bank-cash-accounts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAAFS-BANKACCT-${suffix}`,
        name: "Main Bank Cash Account",
        kind: "BANK",
        glAccountId: bankAccountId,
      })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAAFS-SUP-${suffix}`,
        name: "On-Account FS Test Supplier",
      })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAAFS-OPEN-${suffix}`,
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

  it("#39 — Balance Sheet: the AP control account's balance already reflects a zero-allocation (on-account) payment correctly, with zero code change", async () => {
    const token = tokenFor(["finance.poster"]);

    // Bill for 1000 — credits AP liability 1000 (standard existing
    // behavior, unrelated to this work item).
    const bill = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `OAAFS-BILL-${randomUUID()}`,
        billDate: "2026-02-01",
        lines: [{ accountId: expenseAccountId, amountMinor: 1000 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/bills/${bill.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Payment for 600 with ZERO allocations — Table 19.1 #1: still
    // posts a full 2-line JE unconditionally (§3.4), debiting AP 600,
    // even though it settles no specific bill.
    const payment = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2026-02-05",
        paymentAmountMinor: 600,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${payment.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get("/v1/finance/financial-statements/balance-sheet")
      .query({ asOf: "2026-02-28" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const liabilityRoots = res.body.data.liabilities.roots as Array<{
      accountId: string;
      ownBalanceMinor: number;
      subtotalMinor: number;
    }>;
    const apRow = liabilityRoots.find(
      (r) => r.accountId === liabilityAccountId,
    );
    expect(apRow).toBeDefined();
    // 1000 (bill, credit) - 600 (on-account payment, debit) = 400,
    // asserted directly against real persisted GL state — the correct
    // control-account balance despite the payment being entirely
    // unallocated. Proves §3.7's "zero change required" claim.
    expect(apRow!.ownBalanceMinor).toBe(400);
    expect(apRow!.subtotalMinor).toBe(400);
  });

  it("#40 — Cash Flow Statement: a zero-allocation payment still classifies into the correct Operating bucket, with zero code change", async () => {
    const token = tokenFor(["finance.poster"]);

    // A fresh bill + zero-allocation payment, isolated to its own date
    // window so this test's cash-flow window contains only this pair.
    const bill = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `OAAFS-BILL-${randomUUID()}`,
        billDate: "2026-03-01",
        lines: [{ accountId: expenseAccountId, amountMinor: 500 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/bills/${bill.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // The AP liability account needs an explicit cash-flow
    // classification (OPERATING) for its movement to be counted, same
    // as any other non-cash account — unaffected by this work item.
    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounts/${liabilityAccountId}/cash-flow-category`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ cashFlowCategory: "OPERATING" })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounts/${expenseAccountId}/cash-flow-category`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ cashFlowCategory: "OPERATING" })
      .expect(200);

    const payment = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2026-03-05",
        paymentAmountMinor: 500,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [], // zero allocations — on-account
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${payment.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get("/v1/finance/financial-statements/cash-flow")
      .query({ dateFrom: "2026-03-01", dateTo: "2026-03-31" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // The 500 cash outflow (credit to bank) is driven entirely by the
    // AP liability account's own OPERATING classification — the
    // payment itself carries no cash-flow-category field of its own,
    // so this is a direct proof that classification is unaffected by
    // whether the payment was ever allocated to a bill.
    expect(res.body.data.operatingMinor).toBe(-500);
    expect(res.body.data.netCashMovementMinor).toBe(-500);
    expect(res.body.data.reconciled).toBe(true);
  });
});
