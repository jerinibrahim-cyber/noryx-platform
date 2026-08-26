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
 * AR-1d — AR/GL Reconciliation (`GET /ar/reconciliation`).
 * docs/finance-work-item-1d-ar-reports-proposal.md §9, §13. Mirrors
 * test/ap-gl-reconciliation.e2e-spec.ts's 4 cases, **plus** the three
 * AR-specific reconciliation scenarios §13 requires beyond AP-1d's own
 * precedent: historical (past) as-of correctness, the CTO-corrected
 * asOf-at-or-after-today acceptance case (the single most important
 * scenario in this Work Item — proposal §9.1's correction), and
 * future-dated-document symmetry. The CTO-corrected scenario's own
 * "current mode is not broken by the fix" check runs as a separate,
 * dedicated `it()` in its own isolated legal entity — see that test's
 * comment for why entity A itself is unsuitable for that specific
 * check once this file's other scenarios have posted documents dated
 * after real "today" into it.
 *
 * `/ar/reconciliation` deliberately has no `customerId` parameter
 * (§9.3, §14 decision 3, resolved) — proven below by a 400 on an
 * unknown `customerId` query param, via the global ValidationPipe's
 * `whitelist:true`/`forbidNonWhitelisted:true`.
 */
describe("AR Reports — AR/GL Reconciliation (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityAId: string;
  let legalEntityBId: string; // legal-entity isolation
  let legalEntityDId: string; // dedicated current-mode sanity check, no future-dated documents
  let revenueAccountAId: string;
  let arAccountAId: string;
  let bankAccountAId: string;
  let revenueAccountBId: string;
  let arAccountBId: string;
  let bankAccountBId: string;
  let posterAToken: string;
  let adminAToken: string;
  let posterBToken: string;
  let adminBToken: string;
  let suffix: number;

  function tokenFor(legalEntityId: string, roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function newCustomer(
    adminToken: string,
    code: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `${code}-${suffix}`, name: code })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPostInvoice(
    posterToken: string,
    revenueAccountId: string,
    customerId: string,
    invoiceDate: string,
    amountMinor: number,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        invoiceDate,
        lines: [{ accountId: revenueAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
  }

  async function createAndPostReceipt(
    posterToken: string,
    bankAccountId: string,
    customerId: string,
    receiptDate: string,
    amountMinor: number,
    allocations: { invoiceId: string; allocatedAmountMinor: number }[],
  ): Promise<{ id: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        receiptDate,
        receiptAmountMinor: amountMinor,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return { id: posted.body.data.id };
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
        slug: `ar-recon-e2e-${suffix}`,
        name: "AR Reconciliation E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entityA] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "AR Reconciliation E2E Entity A",
        code: "ARRECONA",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "AR Reconciliation E2E Entity B",
        code: "ARRECONB",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    legalEntityAId = entityA!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [revA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `ARRECON-REV-A-${suffix}`,
        name: "Consulting Revenue A",
        type: "REVENUE",
      })
      .returning();
    const [arA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `ARRECON-AR-A-${suffix}`,
        name: "Accounts Receivable A",
        type: "ASSET",
      })
      .returning();
    const [bankA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityAId,
        code: `ARRECON-BANK-A-${suffix}`,
        name: "Main Bank A",
        type: "ASSET",
      })
      .returning();
    revenueAccountAId = revA!.id;
    arAccountAId = arA!.id;
    bankAccountAId = bankA!.id;

    const [revB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `ARRECON-REV-B-${suffix}`,
        name: "Consulting Revenue B",
        type: "REVENUE",
      })
      .returning();
    const [arB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `ARRECON-AR-B-${suffix}`,
        name: "Accounts Receivable B",
        type: "ASSET",
      })
      .returning();
    const [bankB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityBId,
        code: `ARRECON-BANK-B-${suffix}`,
        name: "Main Bank B",
        type: "ASSET",
      })
      .returning();
    revenueAccountBId = revB!.id;
    arAccountBId = arB!.id;
    bankAccountBId = bankB!.id;

    adminAToken = tokenFor(legalEntityAId, ["finance.admin"]);
    posterAToken = tokenFor(legalEntityAId, ["finance.poster"]);
    adminBToken = tokenFor(legalEntityBId, ["finance.admin"]);
    posterBToken = tokenFor(legalEntityBId, ["finance.poster"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ arControlAccountId: arAccountAId })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ arControlAccountId: arAccountBId })
      .expect(201);

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        code: `ARRECON-OPEN-A-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        code: `ARRECON-OPEN-B-${suffix}`,
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

  it("reconciled with no activity — both sides are zero", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(res.body.data.subLedgerTotalOutstandingMinor).toBe(0);
    expect(res.body.data.glArControlAccountBalanceMinor).toBe(0);
    expect(res.body.data.differenceMinor).toBe(0);
    expect(res.body.data.reconciled).toBe(true);
  });

  it("sub-ledger total equals the GL AR control account balance across multiple invoices, multiple receipts, multiple customers, and partial settlement", async () => {
    const customerX = await newCustomer(adminAToken, "ReconX");
    const customerY = await newCustomer(adminAToken, "ReconY");

    // Customer X: two invoices, one fully received, one partially
    // received.
    const invoiceX1 = await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customerX,
      "2026-05-01",
      1000,
    );
    const invoiceX2 = await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customerX,
      "2026-05-02",
      2000,
    );
    await createAndPostReceipt(
      posterAToken,
      bankAccountAId,
      customerX,
      "2026-05-10",
      1000,
      [{ invoiceId: invoiceX1.id, allocatedAmountMinor: 1000 }],
    );
    await createAndPostReceipt(
      posterAToken,
      bankAccountAId,
      customerX,
      "2026-05-11",
      500,
      [{ invoiceId: invoiceX2.id, allocatedAmountMinor: 500 }],
    );

    // Customer Y: one untouched invoice, entirely outstanding.
    await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customerY,
      "2026-05-03",
      750,
    );

    const reconciliation = await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);

    expect(reconciliation.body.data.reconciled).toBe(true);
    expect(reconciliation.body.data.differenceMinor).toBe(0);
    expect(reconciliation.body.data.subLedgerTotalOutstandingMinor).toBe(
      reconciliation.body.data.glArControlAccountBalanceMinor,
    );
    // Concretely: invoiceX1 fully received (0 outstanding), invoiceX2
    // 2000-500=1500 outstanding, Y's invoice 750 outstanding entirely.
    expect(reconciliation.body.data.subLedgerTotalOutstandingMinor).toBe(
      0 + 1500 + 750,
    );

    // Cross-check against the GL's own account-balance endpoint
    // directly.
    const glBalance = await request(app.getHttpServer())
      .get(`/v1/finance/accounts/${arAccountAId}/balance`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(reconciliation.body.data.glArControlAccountBalanceMinor).toBe(
      glBalance.body.data.closingBalanceMinor,
    );
  });

  it("legal-entity isolation — entity B's reconciliation is unaffected by entity A's activity, and each reconciles independently", async () => {
    const customerB = await newCustomer(adminBToken, "ReconEntityB");
    const invoiceB = await createAndPostInvoice(
      posterBToken,
      revenueAccountBId,
      customerB,
      "2026-06-01",
      400,
    );
    await createAndPostReceipt(
      posterBToken,
      bankAccountBId,
      customerB,
      "2026-06-05",
      150,
      [{ invoiceId: invoiceB.id, allocatedAmountMinor: 150 }],
    );

    const reconciliationB = await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterBToken}`)
      .expect(200);
    expect(reconciliationB.body.data.legalEntityId).toBe(legalEntityBId);
    expect(reconciliationB.body.data.subLedgerTotalOutstandingMinor).toBe(250);
    expect(reconciliationB.body.data.reconciled).toBe(true);

    // Entity A's own reconciliation (from the previous test) is
    // untouched by entity B's activity — re-fetch and confirm it still
    // holds.
    const reconciliationA = await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(reconciliationA.body.data.legalEntityId).toBe(legalEntityAId);
    expect(reconciliationA.body.data.reconciled).toBe(true);
    expect(reconciliationA.body.data.subLedgerTotalOutstandingMinor).not.toBe(
      reconciliationB.body.data.subLedgerTotalOutstandingMinor,
    );
  });

  it("404s if AR settings have not been configured for the legal entity", async () => {
    const platformDb = getPlatformDb();
    const [entityC] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "AR Reconciliation E2E Entity C (no AR settings)",
        code: "ARRECONC",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const posterCToken = tokenFor(entityC!.id, ["finance.poster"]);

    await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterCToken}`)
      .expect(404);
  });

  it("rejects an unknown customerId query param with a 400 — /ar/reconciliation has no customerId parameter (§9.3, §14 decision 3, resolved)", async () => {
    await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?customerId=${randomUUID()}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(400);
  });

  it("historical (past) as-of mode correctly reconstructs via the allocation join and still reconciles, proving §9.1's two-mode design is actually necessary and correct", async () => {
    const customer = await newCustomer(adminAToken, "ReconHistorical");
    const invoice = await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customer,
      "2026-02-01",
      1000,
    );
    // The receipt is dated well after the historical asOf below, but is
    // already POSTED today — paid_minor on this invoice is already
    // fully settled, right now, regardless of the receipt's own date.
    await createAndPostReceipt(
      posterAToken,
      bankAccountAId,
      customer,
      "2026-04-01",
      1000,
      [{ invoiceId: invoice.id, allocatedAmountMinor: 1000 }],
    );

    const historicalAsOf = "2026-03-01"; // after the invoice, before the receipt.

    const reconciliation = await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?asOf=${historicalAsOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);

    // As-of mode correctly excludes the not-yet-dated (relative to
    // historicalAsOf) receipt's allocation — the invoice remains fully
    // outstanding as of that date, on both the sub-ledger and GL sides,
    // so the two agree.
    const balanceAtCustomer = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customer}/balance?asOf=${historicalAsOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(balanceAtCustomer.body.data.totalOutstandingMinor).toBe(1000);
    expect(reconciliation.body.data.reconciled).toBe(true);

    // Negative control: a naive paid_minor-based (current-mode) read —
    // i.e. what would happen if current mode were wrongly selected for
    // this historical asOf — already shows the invoice as fully
    // received, proving as-of mode's exclusion is load-bearing, not
    // incidental.
    const currentBalance = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customer}/balance`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(currentBalance.body.data.totalOutstandingMinor).toBe(0);
  });

  it("the CTO-corrected acceptance case — an explicit asOf at or after today must still use as-of reconstruction, never the paid_minor fast path, because paid_minor updates at receipt-posting time regardless of the receipt's own receipt_date", async () => {
    // Mirrors the CTO review's own example exactly: an invoice dated
    // 2026-08-01, a receipt dated 2026-09-01 already POSTED and fully
    // allocated against it (so paid_minor already reflects full
    // settlement, right now), and an explicit asOf of 2026-08-31 — at
    // or after real "today" (2026-08-26 at authoring time), NOT a
    // historical date in the colloquial past-only sense. §9.1's
    // correction: mode dispatch is on parameter presence alone, so
    // this asOf must still use as-of reconstruction.
    const customer = await newCustomer(adminAToken, "ReconCtoFix");
    const invoice = await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customer,
      "2026-08-01",
      5000,
    );
    await createAndPostReceipt(
      posterAToken,
      bankAccountAId,
      customer,
      "2026-09-01", // after the asOf used below.
      5000,
      [{ invoiceId: invoice.id, allocatedAmountMinor: 5000 }],
    );

    const asOf = "2026-08-31"; // at/after today; before the receipt's own date.

    // (a) The sub-ledger side, reconstructed via
    // customer_receipt_allocations joined to
    // customer_receipts.receipt_date <= asOf, still shows the invoice
    // as fully outstanding — the 2026-09-01 receipt's allocation is
    // correctly excluded because its receipt_date > asOf.
    const customerBalance = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customer}/balance?asOf=${asOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(customerBalance.body.data.totalOutstandingMinor).toBe(5000);
    expect(customerBalance.body.data.totalReceivedMinor).toBe(0);

    // (b)/(c) The full reconciliation at the same asOf: the GL side,
    // filtered by journal_entries.transaction_date <= asOf, also
    // excludes that receipt's journal entry for the identical reason —
    // both sides therefore agree.
    const reconciliation = await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?asOf=${asOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(reconciliation.body.data.reconciled).toBe(true);
    expect(reconciliation.body.data.differenceMinor).toBe(0);

    // (d) Negative control: a naive paid_minor-based read (i.e. what
    // current mode would have wrongly returned had it been selected
    // for this request, which is exactly the bug the CTO's review
    // caught) already shows the invoice as fully settled — proving the
    // corrected dispatch rule, not just the as-of reconstruction
    // formula itself, is what this test protects.
    const currentBalance = await request(app.getHttpServer())
      .get(`/v1/finance/customers/${customer}/balance`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(currentBalance.body.data.totalOutstandingMinor).toBe(0);
    expect(currentBalance.body.data.totalReceivedMinor).toBe(5000);
  });

  it("a second, minimal variant of the CTO-corrected case: current mode (no asOf at all) is not broken by the fix — proven in a dedicated legal entity with no future-dated document, since entity A above now deliberately carries one (2026-09-01) that legitimately falls outside current mode's own accepted scope (proposal §14 decision 2)", async () => {
    // Deliberately its OWN legal entity, isolated from entity A's
    // accumulated activity above (which now includes documents dated
    // after real "today" by design, to exercise as-of mode elsewhere in
    // this file) — current mode's fast path applies no date filter at
    // all to its own sub-ledger side, so a legal entity that happens to
    // contain a document dated after "today" is exactly AR-1c's own
    // §12.1-documented, CTO-accepted limitation, not a regression this
    // test should be checking. Isolating this check to a legal entity
    // with only ordinary, non-future-dated postings is what actually
    // proves current mode itself still works correctly after the fix.
    const platformDb = getPlatformDb();
    const [entityD] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "AR Reconciliation E2E Entity D (current-mode sanity)",
        code: "ARRECOND",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    legalEntityDId = entityD!.id;

    const financeDb = getFinanceDb();
    const [revD] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityDId,
        code: `ARRECON-REV-D-${suffix}`,
        name: "Consulting Revenue D",
        type: "REVENUE",
      })
      .returning();
    const [arD] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityDId,
        code: `ARRECON-AR-D-${suffix}`,
        name: "Accounts Receivable D",
        type: "ASSET",
      })
      .returning();
    const [bankD] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId: legalEntityDId,
        code: `ARRECON-BANK-D-${suffix}`,
        name: "Main Bank D",
        type: "ASSET",
      })
      .returning();

    const adminDToken = tokenFor(legalEntityDId, ["finance.admin"]);
    const posterDToken = tokenFor(legalEntityDId, ["finance.poster"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminDToken}`)
      .send({ arControlAccountId: arD!.id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminDToken}`)
      .send({
        code: `ARRECON-OPEN-D-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      })
      .expect(201);

    const customer = await newCustomer(adminDToken, "ReconCurrentMode");
    const invoice = await createAndPostInvoice(
      posterDToken,
      revD!.id,
      customer,
      "2026-01-10",
      800,
    );
    await createAndPostReceipt(
      posterDToken,
      bankD!.id,
      customer,
      "2026-01-20",
      800,
      [{ invoiceId: invoice.id, allocatedAmountMinor: 800 }],
    );

    // Calling /ar/reconciliation with NO asOf at all (current mode,
    // correctly using paid_minor directly, no date filtering) is not
    // broken by the fix — only reachable when the caller supplies no
    // asOf at all, per §9.1. Every document in this legal entity is
    // dated well before real "today", so current mode's own accepted
    // scope is not exceeded and this must reconcile.
    const currentReconciliation = await request(app.getHttpServer())
      .get("/v1/finance/ar/reconciliation")
      .set("Authorization", `Bearer ${posterDToken}`)
      .expect(200);
    expect(currentReconciliation.body.data.subLedgerTotalOutstandingMinor).toBe(
      0,
    );
    expect(currentReconciliation.body.data.reconciled).toBe(true);
  });

  it("future-dated documents are excluded symmetrically from both sides in as-of mode — including an invoice (not just a receipt) dated after asOf", async () => {
    const customer = await newCustomer(adminAToken, "ReconFutureSymm");

    // A baseline invoice dated safely before the asOf used below, left
    // entirely unpaid.
    await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customer,
      "2026-10-01",
      1200,
    );

    const asOf = "2026-10-15";

    const before = await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?asOf=${asOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(before.body.data.reconciled).toBe(true);
    const outstandingBefore = before.body.data.subLedgerTotalOutstandingMinor;

    // A second invoice dated AFTER asOf — future-dated relative to the
    // requested asOf, though not relative to real "today". Neither the
    // sub-ledger side (invoice_date <= asOf) nor the GL side
    // (transaction_date <= asOf) should count it.
    await createAndPostInvoice(
      posterAToken,
      revenueAccountAId,
      customer,
      "2026-11-01",
      9999,
    );

    const after = await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?asOf=${asOf}`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(after.body.data.subLedgerTotalOutstandingMinor).toBe(
      outstandingBefore,
    );
    expect(after.body.data.reconciled).toBe(true);
    expect(after.body.data.differenceMinor).toBe(0);

    // Confirmed present, just outside this asOf's window — a later
    // asOf picks it up.
    const later = await request(app.getHttpServer())
      .get(`/v1/finance/ar/reconciliation?asOf=2026-11-30`)
      .set("Authorization", `Bearer ${posterAToken}`)
      .expect(200);
    expect(later.body.data.subLedgerTotalOutstandingMinor).toBe(
      outstandingBefore + 9999,
    );
  });
});
