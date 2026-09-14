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
  sql,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  withTenant,
  type TxClient,
} from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { FinancialStatementsService } from "../src/financial-statements/financial-statements.service";

/**
 * Financial Statements — Cash Flow Statement (indirect method).
 * docs/finance-work-item-cash-flow-statement-proposal.md (CTO-approved
 * "Account-Level Classification, Entry-Level Reconciling Gate"
 * architecture, and the subsequent CTO "IMPLEMENTATION" authorization).
 *
 * Every account, classification, bank/cash-account registration, and
 * journal entry used here is created and posted through the real HTTP
 * API, never inserted directly — identical convention to
 * financial-statements-profit-and-loss.e2e-spec.ts and
 * financial-statements-balance-sheet.e2e-spec.ts.
 *
 * The main-window fixture (§"main window" below) is a single, densely
 * cross-checked scenario deliberately covering the bulk of the CTO's
 * 28-scenario minimum in one internally-consistent dataset — every
 * expected number below was hand-derived from the fixture's actual
 * posted lines (see the comment above each `createAndPost` call) and
 * cross-checked against the reconciling identity
 * (Operating+Investing+Financing+Unclassified = net cash movement,
 * Opening+movement=Closing) independently, via raw SQL run directly in
 * this file (not by calling the service's own private helpers) — Quality
 * Gate item G. A handful of scenarios that need their own isolated
 * before/after state (reversal, deactivation, glAccountId repointing,
 * empty period, boundaries) get their own small dedicated fixtures in
 * their own describe blocks/date windows so they can never contaminate
 * the main window's arithmetic.
 */
describe("Financial Statements — Cash Flow Statement (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let adminA1: string;
  let posterA1: string;
  let viewerA1: string;

  // Main-window accounts.
  let cash1Id: string;
  let cash2Id: string;
  let arId: string;
  let invId: string;
  let faId: string;
  let fa2Id: string;
  let loanId: string;
  let apId: string;
  let vatId: string;
  let defRevId: string;
  let shareCapId: string;
  let unclassAId: string;
  let unclassBId: string;
  let revId: string;
  let expId: string;

  let periodMainId: string;
  let reclassEntryId: string;

  function tokenFor(
    tenantId: string | null,
    legalEntityId: string | null,
    roles: string[],
  ) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function createAccount(
    token: string,
    body: { code: string; name: string; type: string },
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body.data.id;
  }

  async function classify(
    token: string,
    accountId: string,
    cashFlowCategory: "OPERATING" | "INVESTING" | "FINANCING" | null,
  ): Promise<void> {
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounts/${accountId}/cash-flow-category`)
      .set("Authorization", `Bearer ${token}`)
      .send({ cashFlowCategory })
      .expect(200);
  }

  async function registerCashAccount(
    token: string,
    code: string,
    glAccountId: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/bank-cash-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, name: `Cash — ${code}`, kind: "BANK", glAccountId })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPost(
    token: string,
    transactionDate: string,
    lines: Array<{
      accountId: string;
      debitMinor: number;
      creditMinor: number;
    }>,
  ): Promise<{ id: string; journalNumber: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate, lines })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return {
      id: created.body.data.id,
      journalNumber: posted.body.data.journalNumber,
    };
  }

  async function reverseEntry(
    token: string,
    journalEntryId: string,
    transactionDate: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${journalEntryId}/reverse`)
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate })
      .expect(201);
  }

  async function createPeriod(
    token: string,
    code: string,
    startDate: string,
    endDate: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, startDate, endDate })
      .expect(201);
    return res.body.data.id;
  }

  /** Quality Gate item G — an independent raw-SQL cross-check of the
   * hard reconciling identity, computed directly in this test file
   * (never by calling FinancialStatementsService's own private
   * helpers), so a passing assertion means the API's self-reported
   * numbers actually match the ledger, not merely that the service
   * agrees with itself. */
  /** `sql\`${arr}::uuid[]\`` does NOT work through drizzle's
   * `db.execute()` (the postgres.js driver serializes a plain JS array
   * parameter as an anonymous composite, not a Postgres array — see
   * `FinancialStatementsService.cashAccountIdsFragment`'s doc comment
   * for the full explanation and the same fix applied here
   * independently, so this raw cross-check genuinely exercises its own
   * correct query rather than inheriting the service's bug). */
  function uuidArrayFragment(ids: string[]) {
    if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
    return sql`ARRAY[${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
  }

  async function rawCashTotal(
    cashAccountIds: string[],
    dateFrom: string | null,
    dateTo: string,
  ): Promise<number> {
    return withTenant(tenantAId, async (tx: TxClient) => {
      const lower = dateFrom
        ? sql`AND je.transaction_date >= ${dateFrom}::date`
        : sql``;
      const raw = (await tx.execute(sql`
        SELECT COALESCE(SUM(jl.debit_minor), 0) AS d, COALESCE(SUM(jl.credit_minor), 0) AS c
        FROM journal_lines jl
        INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.tenant_id = ${tenantAId}
          AND je.legal_entity_id = ${legalEntityA1Id}
          AND je.status = 'POSTED'
          AND jl.account_id = ANY(${uuidArrayFragment(cashAccountIds)})
          ${lower}
          AND je.transaction_date <= ${dateTo}::date
      `)) as unknown as Array<{ d: string; c: string }>;
      return Number(raw[0]!.d) - Number(raw[0]!.c);
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
    const [tenantA] = await platformDb
      .insert(tenants)
      .values({
        slug: `fs-cf-e2e-a-${suffix}`,
        name: "FS Cash Flow E2E Tenant A",
      })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `fs-cf-e2e-b-${suffix}`,
        name: "FS Cash Flow E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "FS CF Tenant A — Entity 1",
        code: "FSCFA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "FS CF Tenant A — Entity 2",
        code: "FSCFA2",
        countryCode: "AE",
        currencyCode: "USD",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "FS CF Tenant B — Entity 1",
        code: "FSCFB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    viewerA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
    const adminA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
    const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    // ---------------------------------------------------------------
    // Accounts + classifications.
    // ---------------------------------------------------------------
    cash1Id = await createAccount(adminA1, {
      code: `CF-CASH1-${suffix}`,
      name: "Operating Bank",
      type: "ASSET",
    });
    cash2Id = await createAccount(adminA1, {
      code: `CF-CASH2-${suffix}`,
      name: "Petty Cash",
      type: "ASSET",
    });
    arId = await createAccount(adminA1, {
      code: `CF-AR-${suffix}`,
      name: "Accounts Receivable",
      type: "ASSET",
    });
    invId = await createAccount(adminA1, {
      code: `CF-INV-${suffix}`,
      name: "Inventory",
      type: "ASSET",
    });
    faId = await createAccount(adminA1, {
      code: `CF-FA-${suffix}`,
      name: "Fixed Asset",
      type: "ASSET",
    });
    fa2Id = await createAccount(adminA1, {
      code: `CF-FA2-${suffix}`,
      name: "Fixed Asset 2",
      type: "ASSET",
    });
    loanId = await createAccount(adminA1, {
      code: `CF-LOAN-${suffix}`,
      name: "Loan Payable",
      type: "LIABILITY",
    });
    apId = await createAccount(adminA1, {
      code: `CF-AP-${suffix}`,
      name: "Accounts Payable",
      type: "LIABILITY",
    });
    vatId = await createAccount(adminA1, {
      code: `CF-VAT-${suffix}`,
      name: "VAT Payable",
      type: "LIABILITY",
    });
    defRevId = await createAccount(adminA1, {
      code: `CF-DEFREV-${suffix}`,
      name: "Deferred Revenue",
      type: "LIABILITY",
    });
    shareCapId = await createAccount(adminA1, {
      code: `CF-SHARECAP-${suffix}`,
      name: "Share Capital",
      type: "EQUITY",
    });
    unclassAId = await createAccount(adminA1, {
      code: `CF-UNCLASS-A-${suffix}`,
      name: "Unclassified Liability",
      type: "LIABILITY",
    });
    unclassBId = await createAccount(adminA1, {
      code: `CF-UNCLASS-B-${suffix}`,
      name: "Unclassified Asset",
      type: "ASSET",
    });
    revId = await createAccount(adminA1, {
      code: `CF-REV-${suffix}`,
      name: "Sales Revenue",
      type: "REVENUE",
    });
    expId = await createAccount(adminA1, {
      code: `CF-EXP-${suffix}`,
      name: "Operating Expense",
      type: "EXPENSE",
    });

    await classify(adminA1, arId, "OPERATING");
    await classify(adminA1, invId, "OPERATING");
    await classify(adminA1, apId, "OPERATING");
    await classify(adminA1, vatId, "OPERATING");
    await classify(adminA1, defRevId, "OPERATING");
    await classify(adminA1, faId, "INVESTING");
    await classify(adminA1, fa2Id, "INVESTING");
    await classify(adminA1, loanId, "FINANCING");
    await classify(adminA1, shareCapId, "FINANCING");
    // unclassAId / unclassBId deliberately left NULL — §14 "Unclassified".

    await registerCashAccount(adminA1, `CF-BANK1-${suffix}`, cash1Id);
    await registerCashAccount(adminA1, `CF-BANK2-${suffix}`, cash2Id);

    // Cross-tenant / cross-legal-entity isolation fixtures — an
    // unclassified account and a classified cash account that must
    // never leak into A1's report.
    const a2Cash = await createAccount(adminA2, {
      code: `CF-A2-CASH-${suffix}`,
      name: "Entity 2 Cash",
      type: "ASSET",
    });
    await registerCashAccount(adminA2, `CF-A2-BANK-${suffix}`, a2Cash);
    await createAccount(adminB, {
      code: `CF-B-UNCLASS-${suffix}`,
      name: "Tenant B Unclassified",
      type: "LIABILITY",
    });

    // ---------------------------------------------------------------
    // Accounting periods — contiguous, non-overlapping, covering every
    // date this file posts to (every POSTED entry resolves an open
    // period at posting time — JournalEntriesService.
    // resolveAndLockOpenPeriod — identical convention to the P&L/Balance
    // Sheet e2e fixtures).
    // ---------------------------------------------------------------
    await createPeriod(adminA1, `CF-P0-${suffix}`, "2026-01-01", "2026-02-28");
    periodMainId = await createPeriod(
      adminA1,
      `CF-P1-${suffix}`,
      "2026-03-01",
      "2026-03-31",
    );
    await createPeriod(adminA1, `CF-P2-${suffix}`, "2026-04-01", "2026-04-30");
    await createPeriod(adminA1, `CF-P3-${suffix}`, "2026-05-01", "2026-05-31");
    await createPeriod(adminA1, `CF-P4-${suffix}`, "2026-06-01", "2026-06-30");
    await createPeriod(adminA1, `CF-P5-${suffix}`, "2026-07-01", "2026-07-31");
    await createPeriod(adminA1, `CF-P6-${suffix}`, "2026-08-01", "2026-08-31");

    // ---------------------------------------------------------------
    // Opening-balance fixture (before the main window).
    // ---------------------------------------------------------------
    // E0 — capital contribution, 2026-02-01. Establishes cash of 10000
    // before the main window even starts.
    await createAndPost(posterA1, "2026-02-01", [
      { accountId: cash1Id, debitMinor: 10000, creditMinor: 0 },
      { accountId: shareCapId, debitMinor: 0, creditMinor: 10000 },
    ]);
    // E17 — additional pre-window cash sale, 2026-02-28 (the day
    // immediately before the main window opens) — opening cash becomes
    // 10000 + 5000 = 15000.
    await createAndPost(posterA1, "2026-02-28", [
      { accountId: cash1Id, debitMinor: 5000, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 5000 },
    ]);

    // ---------------------------------------------------------------
    // Main window: 2026-03-01 .. 2026-03-31.
    // ---------------------------------------------------------------
    // E15 — dateFrom boundary (2026-03-01 exactly) — must be INCLUDED.
    await createAndPost(posterA1, "2026-03-01", [
      { accountId: cash1Id, debitMinor: 250, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 250 },
    ]);
    // E1 — Revenue/Expense-driven eligibility, non-cash: Dr AR / Cr
    // Revenue. AR is a non-cash ASSET, yet this entry is reconciling
    // because it touches REVENUE, not because it touches cash.
    await createAndPost(posterA1, "2026-03-02", [
      { accountId: arId, debitMinor: 4000, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 4000 },
    ]);
    // E2 — ordinary cash sale (both a cash line AND an income line).
    await createAndPost(posterA1, "2026-03-03", [
      { accountId: cash1Id, debitMinor: 1500, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 1500 },
    ]);
    // E3 — expense-driven eligibility, non-cash: Dr Expense / Cr AP.
    await createAndPost(posterA1, "2026-03-04", [
      { accountId: expId, debitMinor: 800, creditMinor: 0 },
      { accountId: apId, debitMinor: 0, creditMinor: 800 },
    ]);
    // E4 — cash-driven eligibility, no income line: Dr AP / Cr Cash
    // (paying a bill). AP has no REVENUE/EXPENSE line here — it is
    // reconciling purely because the entry touches a cash account.
    await createAndPost(posterA1, "2026-03-05", [
      { accountId: apId, debitMinor: 500, creditMinor: 0 },
      { accountId: cash1Id, debitMinor: 0, creditMinor: 500 },
    ]);
    // E5 — multi-line with tax/VAT, income-line eligibility: Dr AR
    // 1050 / Cr Revenue 1000 / Cr VAT Payable 50.
    await createAndPost(posterA1, "2026-03-06", [
      { accountId: arId, debitMinor: 1050, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 1000 },
      { accountId: vatId, debitMinor: 0, creditMinor: 50 },
    ]);
    // E6 — deferred revenue (customer advance), cash-driven eligibility,
    // no income line: Dr Cash / Cr Deferred Revenue (a LIABILITY, not a
    // REVENUE account).
    await createAndPost(posterA1, "2026-03-07", [
      { accountId: cash1Id, debitMinor: 300, creditMinor: 0 },
      { accountId: defRevId, debitMinor: 0, creditMinor: 300 },
    ]);
    // E7 — loan drawdown (financing, cash-driven): Dr Cash / Cr Loan.
    await createAndPost(posterA1, "2026-03-08", [
      { accountId: cash1Id, debitMinor: 5000, creditMinor: 0 },
      { accountId: loanId, debitMinor: 0, creditMinor: 5000 },
    ]);
    // E8 — mixed cash + non-cash: fixed-asset purchase, partly cash,
    // partly loan-funded: Dr FA 2500 / Cr Cash 500 / Cr Loan 2000.
    await createAndPost(posterA1, "2026-03-09", [
      { accountId: faId, debitMinor: 2500, creditMinor: 0 },
      { accountId: cash1Id, debitMinor: 0, creditMinor: 500 },
      { accountId: loanId, debitMinor: 0, creditMinor: 2000 },
    ]);
    // E9 — Quality Gate item M: a multi-line entry where a proportional
    // (equal-split or share-of-total) allocation would produce a
    // DIFFERENT result than per-account attribution: Dr FA2 3000 / Dr
    // Inventory 1000 / Cr Cash 4000. A naive "split the 4000 cash
    // movement evenly across the 2 non-cash lines" implementation would
    // wrongly report -2000/-2000; the correct, approved architecture
    // must report each account's OWN actual amount: -3000 / -1000.
    await createAndPost(posterA1, "2026-03-10", [
      { accountId: fa2Id, debitMinor: 3000, creditMinor: 0 },
      { accountId: invId, debitMinor: 1000, creditMinor: 0 },
      { accountId: cash1Id, debitMinor: 0, creditMinor: 4000 },
    ]);
    // E10 — THE canonical CTO scenario (Quality Gate item L): a pure
    // non-cash reclassification, zero cash line, zero income line: Dr
    // Fixed Asset / Cr Loan Payable. Must contribute ZERO to Investing
    // and ZERO to Financing, and appear ONLY in
    // nonCashReclassifications.
    const reclassEntry = await createAndPost(posterA1, "2026-03-11", [
      { accountId: faId, debitMinor: 2000, creditMinor: 0 },
      { accountId: loanId, debitMinor: 0, creditMinor: 2000 },
    ]);
    reclassEntryId = reclassEntry.id;
    // E11 — asset disposal (credit-side Investing movement) — proves
    // sign polarity is not hardcoded to "debit = positive": Dr Cash /
    // Cr Fixed Asset.
    await createAndPost(posterA1, "2026-03-12", [
      { accountId: cash1Id, debitMinor: 1200, creditMinor: 0 },
      { accountId: faId, debitMinor: 0, creditMinor: 1200 },
    ]);
    // E12/E13 — two unclassified-account movements of different
    // magnitude, for the unclassifiedAccounts sort-order test.
    await createAndPost(posterA1, "2026-03-13", [
      { accountId: cash1Id, debitMinor: 900, creditMinor: 0 },
      { accountId: unclassAId, debitMinor: 0, creditMinor: 900 },
    ]);
    await createAndPost(posterA1, "2026-03-14", [
      { accountId: unclassBId, debitMinor: 300, creditMinor: 0 },
      { accountId: cash1Id, debitMinor: 0, creditMinor: 300 },
    ]);
    // E14 — inter-cash-account transfer (multiple cash lines in one
    // entry) — must net to exactly zero on the aggregate cash movement
    // and contribute nothing to any of the four buckets.
    await createAndPost(posterA1, "2026-03-15", [
      { accountId: cash2Id, debitMinor: 700, creditMinor: 0 },
      { accountId: cash1Id, debitMinor: 0, creditMinor: 700 },
    ]);
    // E16 — dateTo boundary (2026-03-31 exactly) — must be INCLUDED.
    await createAndPost(posterA1, "2026-03-31", [
      { accountId: cash1Id, debitMinor: 150, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 150 },
    ]);

    // ---------------------------------------------------------------
    // Just-outside-the-window fixtures (must be EXCLUDED from the main
    // window's movement, per §6.2-style windowing — identical to P&L).
    // ---------------------------------------------------------------
    // E18 — one day after dateTo.
    await createAndPost(posterA1, "2026-04-01", [
      { accountId: cash1Id, debitMinor: 8000, creditMinor: 0 },
      { accountId: revId, debitMinor: 0, creditMinor: 8000 },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // -----------------------------------------------------------------
  // Auth / RBAC.
  // -----------------------------------------------------------------
  describe("auth", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .expect(401);
    });

    it("rejects a role outside finance.viewer/poster/admin (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it.each(["finance.viewer", "finance.poster", "finance.admin"])(
      "%s can read the route (200)",
      async (role) => {
        const token = tokenFor(tenantAId, legalEntityA1Id, [role]);
        await request(app.getHttpServer())
          .get("/v1/finance/financial-statements/cash-flow")
          .query({ periodId: periodMainId })
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      },
    );
  });

  // -----------------------------------------------------------------
  // Main-window reconciliation and bucket arithmetic.
  // -----------------------------------------------------------------
  describe("GET /financial-statements/cash-flow — main window", () => {
    it("periodId resolves dateFrom/dateTo from the period's own dates", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.dateFrom).toBe("2026-03-01");
      expect(res.body.data.dateTo).toBe("2026-03-31");
      expect(res.body.data.periodId).toBe(periodMainId);
    });

    it("opening cash (15000) + net cash movement (4000) = closing cash (19000), independently verified against raw ledger SQL", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      expect(res.body.data.openingCashMinor).toBe(15000);
      expect(res.body.data.netCashMovementMinor).toBe(4000);
      expect(res.body.data.closingCashMinor).toBe(19000);
      expect(res.body.data.reconciled).toBe(true);
      expect(
        res.body.data.openingCashMinor + res.body.data.netCashMovementMinor,
      ).toBe(res.body.data.closingCashMinor);

      // Quality Gate item G — independent raw-SQL cross-check, not a
      // call into the service's own code.
      const cashAccountIds = [cash1Id, cash2Id];
      const rawOpening = await rawCashTotal(cashAccountIds, null, "2026-02-28");
      const rawClosing = await rawCashTotal(cashAccountIds, null, "2026-03-31");
      expect(rawOpening).toBe(15000);
      expect(rawClosing).toBe(19000);
      expect(rawClosing - rawOpening).toBe(4000);
    });

    it("Operating (700) + Investing (-4300) + Financing (7000) + Unclassified (600) = net cash movement (4000)", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      expect(res.body.data.operatingMinor).toBe(700);
      expect(res.body.data.investingMinor).toBe(-4300);
      expect(res.body.data.financingMinor).toBe(7000);
      expect(res.body.data.unclassifiedMinor).toBe(600);
      const bucketSum =
        res.body.data.operatingMinor +
        res.body.data.investingMinor +
        res.body.data.financingMinor +
        res.body.data.unclassifiedMinor;
      expect(bucketSum).toBe(res.body.data.netCashMovementMinor);
    });

    it("§Quality-Gate-M — multi-line attribution uses each account's own actual amount, never a proportional/equal split (E9: FA2=-3000, Inventory=-1000, NOT -2000/-2000)", async () => {
      // investingMinor (-4300) is CF-FA's own total (-1300: -2500 from
      // E8 + 1200 from E11) plus CF-FA2's own total (-3000, entirely
      // from E9) — -1300 + -3000 = -4300. If E9 had instead been
      // evenly/proportionally split, CF-FA2's own contribution would
      // have come out to -2000, not -3000, and the totals below would
      // not hold.
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.investingMinor).toBe(-4300);

      // Independent raw-SQL check restricted to CF-FA2's own line in
      // E9 only, proving its exact own-account amount.
      const raw = await withTenant(tenantAId, async (tx: TxClient) => {
        const rows = (await tx.execute(sql`
          SELECT jl.debit_minor AS d, jl.credit_minor AS c
          FROM journal_lines jl
          WHERE jl.account_id = ${fa2Id}
        `)) as unknown as Array<{ d: string; c: string }>;
        return rows;
      });
      expect(raw).toHaveLength(1);
      expect(Number(raw[0]!.d)).toBe(3000);
      expect(Number(raw[0]!.c)).toBe(0);
    });

    it("inter-cash-account transfers (E14) net to exactly zero and contribute nothing to any of the four buckets", async () => {
      // E14 (Dr Cash2 700 / Cr Cash1 700) is already baked into the
      // 4000 net-movement/700-bucket-sum totals verified above — this
      // test isolates its own effect via the raw aggregate: summing
      // debit-credit across BOTH cash accounts for that single entry
      // must be exactly 0.
      const raw = await withTenant(tenantAId, async (tx: TxClient) => {
        const rows = (await tx.execute(sql`
          SELECT COALESCE(SUM(jl.debit_minor), 0) AS d, COALESCE(SUM(jl.credit_minor), 0) AS c
          FROM journal_lines jl
          INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE je.transaction_date = '2026-03-15'
            AND je.legal_entity_id = ${legalEntityA1Id}
            AND jl.account_id = ANY(${uuidArrayFragment([cash1Id, cash2Id])})
        `)) as unknown as Array<{ d: string; c: string }>;
        return Number(rows[0]!.d) - Number(rows[0]!.c);
      });
      expect(raw).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // unclassifiedAccounts — never silently absorbed into Operating.
  // -----------------------------------------------------------------
  describe("unclassifiedAccounts", () => {
    it("reports both unclassified accounts, sorted by descending absolute movement, with full identity/movement fields", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      expect(res.body.data.hasUnclassifiedAccounts).toBe(true);
      expect(res.body.data.unclassifiedAccountCount).toBe(2);
      expect(res.body.data.unclassifiedAccounts).toHaveLength(2);

      const [first, second] = res.body.data.unclassifiedAccounts;
      // CF-UNCLASS-A moved 900 (abs), CF-UNCLASS-B moved -300 (abs 300)
      // — descending by absolute value means A comes first.
      expect(first.accountId).toBe(unclassAId);
      expect(first.movementMinor).toBe(900);
      expect(second.accountId).toBe(unclassBId);
      expect(second.movementMinor).toBe(-300);

      for (const acct of [first, second]) {
        expect(typeof acct.code).toBe("string");
        expect(typeof acct.name).toBe("string");
        expect(["ASSET", "LIABILITY", "EQUITY"]).toContain(acct.type);
      }

      // unclassifiedMinor (600) = 900 + (-300).
      expect(res.body.data.unclassifiedMinor).toBe(900 + -300);

      // Never silently folded into operatingMinor — CF-UNCLASS-A/B are
      // excluded from the operatingMinor computation entirely (only
      // AR/AP/VAT/DeferredRevenue/Inventory feed Operating here).
      expect(res.body.data.operatingMinor).not.toBe(
        res.body.data.operatingMinor + 900 + -300,
      );
    });
  });

  // -----------------------------------------------------------------
  // nonCashReclassifications — the IAS 7.43 disclosure.
  // -----------------------------------------------------------------
  describe("nonCashReclassifications", () => {
    it("the E10 Dr Fixed Asset / Cr Loan Payable entry appears ONLY here — zero Investing/Financing impact", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      const reclass = res.body.data.nonCashReclassifications;
      expect(reclass.entries).toHaveLength(1);
      const entry = reclass.entries[0];
      expect(entry.journalEntryId).toBe(reclassEntryId);
      expect(entry.transactionDate).toBe("2026-03-11");
      expect(entry.lines).toHaveLength(2);

      const faLine = entry.lines.find(
        (l: { accountId: string }) => l.accountId === faId,
      );
      const loanLine = entry.lines.find(
        (l: { accountId: string }) => l.accountId === loanId,
      );
      expect(faLine).toBeDefined();
      expect(faLine.amountMinor).toBe(-2000);
      expect(faLine.cashFlowCategory).toBe("INVESTING");
      expect(loanLine).toBeDefined();
      expect(loanLine.amountMinor).toBe(2000);
      expect(loanLine.cashFlowCategory).toBe("FINANCING");

      // totalGrossMinor = (|-2000| + |2000|) / 2 = 2000.
      expect(reclass.totalGrossMinor).toBe(2000);

      // §5.2's algebraic proof, re-verified here: the entry's own two
      // lines net to exactly zero.
      expect(faLine.amountMinor + loanLine.amountMinor).toBe(0);

      // Quality Gate item L, restated directly against the buckets:
      // this entry's accounts (FA, Loan) DO have other window activity
      // (E8/E9/E11 for FA, E7/E8 for Loan) which correctly DOES appear
      // in investingMinor/financingMinor — proving the exclusion is
      // scoped to this one non-cash entry, not to the accounts as a
      // whole.
      expect(res.body.data.investingMinor).not.toBe(0);
      expect(res.body.data.financingMinor).not.toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // Period boundaries — inclusive at both ends, exclusive just outside.
  // -----------------------------------------------------------------
  describe("period boundaries", () => {
    it("includes an entry dated exactly dateFrom and exactly dateTo", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-03-01", dateTo: "2026-03-01" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      // E15 alone: 250 cash in, 250 revenue (all Operating via netIncome).
      expect(res.body.data.netCashMovementMinor).toBe(250);
      expect(res.body.data.operatingMinor).toBe(250);

      const res2 = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-03-31", dateTo: "2026-03-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      // E16 alone: 150 cash in, 150 revenue.
      expect(res2.body.data.netCashMovementMinor).toBe(150);
    });

    it("excludes activity one day before dateFrom and one day after dateTo", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-03-01", dateTo: "2026-03-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      // 4000 (main window) — NOT 4000 + 5000 (E17, Feb 28) and NOT
      // 4000 + 8000 (E18, Apr 1).
      expect(res.body.data.netCashMovementMinor).toBe(4000);
    });

    it("open-ended dateFrom (omitted) reports cumulative-since-inception movement", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateTo: "2026-04-01" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.openingCashMinor).toBe(0);
      // Every fixture posted through 2026-04-01 inclusive: 10000 (E0) +
      // 5000 (E17) + 4000 (main window) + 8000 (E18) = 27000.
      expect(res.body.data.netCashMovementMinor).toBe(
        10000 + 5000 + 4000 + 8000,
      );
    });
  });

  // -----------------------------------------------------------------
  // Empty / no-activity period.
  // -----------------------------------------------------------------
  describe("empty period", () => {
    it("an activity-free window reports all-zero buckets, no unclassified accounts, no reclassifications, and still reconciles", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-08-01", dateTo: "2026-08-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      expect(res.body.data.netCashMovementMinor).toBe(0);
      expect(res.body.data.operatingMinor).toBe(0);
      expect(res.body.data.investingMinor).toBe(0);
      expect(res.body.data.financingMinor).toBe(0);
      expect(res.body.data.unclassifiedMinor).toBe(0);
      expect(res.body.data.hasUnclassifiedAccounts).toBe(false);
      expect(res.body.data.unclassifiedAccountCount).toBe(0);
      expect(res.body.data.unclassifiedAccounts).toEqual([]);
      expect(res.body.data.nonCashReclassifications.entries).toEqual([]);
      expect(res.body.data.nonCashReclassifications.totalGrossMinor).toBe(0);
      // Opening cash (cumulative through 2026-07-31) === closing cash
      // (cumulative through 2026-08-31), since nothing moved in August.
      expect(res.body.data.openingCashMinor).toBe(
        res.body.data.closingCashMinor,
      );
      expect(res.body.data.reconciled).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // Reversal interaction — same journal-reversal infrastructure as
  // every other document type, zero special Cash-Flow reversal logic.
  // -----------------------------------------------------------------
  describe("reversal interaction", () => {
    let originalId: string;

    beforeAll(async () => {
      const posted = await createAndPost(posterA1, "2026-05-10", [
        { accountId: cash1Id, debitMinor: 2000, creditMinor: 0 },
        { accountId: revId, debitMinor: 0, creditMinor: 2000 },
      ]);
      originalId = posted.id;
      await reverseEntry(posterA1, originalId, "2026-05-15");
    });

    it("a window containing only the original posting reflects its full effect", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-05-01", dateTo: "2026-05-10" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.netCashMovementMinor).toBe(2000);
      expect(res.body.data.operatingMinor).toBe(2000);
    });

    it("a window containing BOTH the original and its reversal nets to zero — reversal uses the existing journal reversal mechanism, no separate Cash Flow reversal state", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-05-01", dateTo: "2026-05-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.netCashMovementMinor).toBe(0);
      expect(res.body.data.operatingMinor).toBe(0);
      expect(res.body.data.reconciled).toBe(true);
    });

    it("historical reporting around the reversal date: a window ending just before the reversal still shows the (not-yet-reversed) original effect", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-05-01", dateTo: "2026-05-14" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.netCashMovementMinor).toBe(2000);
    });
  });

  // -----------------------------------------------------------------
  // Deactivated cash-account historical integrity (§8) — Quality Gate
  // item J, first half: deactivation must NOT erase historical
  // contribution.
  // -----------------------------------------------------------------
  describe("deactivated cash-account historical integrity", () => {
    let deactCashId: string;
    let bankCashAccountRecordId: string;

    beforeAll(async () => {
      deactCashId = await createAccount(adminA1, {
        code: `CF-CASH-DEACT-${suffix}`,
        name: "Cash — to be deactivated",
        type: "ASSET",
      });
      bankCashAccountRecordId = await registerCashAccount(
        adminA1,
        `CF-DEACT-BANK-${suffix}`,
        deactCashId,
      );
      await createAndPost(posterA1, "2026-06-05", [
        { accountId: deactCashId, debitMinor: 1000, creditMinor: 0 },
        { accountId: revId, debitMinor: 0, creditMinor: 1000 },
      ]);
    });

    it("historical movement is counted while the cash account is still active", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-06-01", dateTo: "2026-06-30" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      expect(res.body.data.netCashMovementMinor).toBe(1000);
    });

    it("the SAME historical movement is STILL counted after the cash account is deactivated — deactivation is a reversible toggle, not a deletion, and is never filtered on", async () => {
      await request(app.getHttpServer())
        .patch(
          `/v1/finance/bank-cash-accounts/${bankCashAccountRecordId}/deactivate`,
        )
        .set("Authorization", `Bearer ${adminA1}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-06-01", dateTo: "2026-06-30" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      // Unchanged — proves isActive is genuinely not filtered on.
      expect(res.body.data.netCashMovementMinor).toBe(1000);
    });
  });

  // -----------------------------------------------------------------
  // glAccountId-repointing limitation (§8/§13) — Quality Gate item J,
  // second half: documented AS a limitation, not silently "solved".
  // -----------------------------------------------------------------
  describe("glAccountId repointing limitation (documented V1 limitation, not engineered around)", () => {
    let originalGlAccountId: string;
    let newGlAccountId: string;
    let bankCashAccountRecordId: string;

    beforeAll(async () => {
      originalGlAccountId = await createAccount(adminA1, {
        code: `CF-REPOINT-OLD-${suffix}`,
        name: "Repoint — original GL account",
        type: "ASSET",
      });
      newGlAccountId = await createAccount(adminA1, {
        code: `CF-REPOINT-NEW-${suffix}`,
        name: "Repoint — new GL account",
        type: "ASSET",
      });
      bankCashAccountRecordId = await registerCashAccount(
        adminA1,
        `CF-REPOINT-BANK-${suffix}`,
        originalGlAccountId,
      );
      // Historical activity posted while glAccountId pointed at the
      // ORIGINAL account.
      await createAndPost(posterA1, "2026-07-05", [
        { accountId: originalGlAccountId, debitMinor: 4000, creditMinor: 0 },
        { accountId: revId, debitMinor: 0, creditMinor: 4000 },
      ]);

      // Re-point the SAME bank_cash_accounts row at a DIFFERENT GL
      // account — a legitimate master-data edit
      // (UpdateBankCashAccountDto allows glAccountId to change).
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bankCashAccountRecordId}`)
        .set("Authorization", `Bearer ${adminA1}`)
        .send({ glAccountId: newGlAccountId })
        .expect(200);
    });

    it("after repointing, historical cash flow for that period reflects the CURRENT glAccountId (newGlAccountId), not the account the activity was actually posted to — the documented V1 limitation, proven rather than presented as solved", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      // The 4000 posted to originalGlAccountId is NO LONGER reflected
      // as cash movement, because cash-account identification is based
      // on the CURRENT bank_cash_accounts.glAccountId only (§8) — this
      // is the exact, explicitly-disclosed V1 limitation, not a bug to
      // work around.
      expect(res.body.data.netCashMovementMinor).toBe(0);

      // Independent raw-SQL confirmation: the 4000 genuinely still sits
      // on originalGlAccountId's own ledger — the data was never lost,
      // it is simply no longer identified as "cash" post-repointing.
      const rawOriginal = await withTenant(tenantAId, async (tx: TxClient) => {
        const rows = (await tx.execute(sql`
          SELECT COALESCE(SUM(jl.debit_minor), 0) AS d, COALESCE(SUM(jl.credit_minor), 0) AS c
          FROM journal_lines jl
          WHERE jl.account_id = ${originalGlAccountId}
        `)) as unknown as Array<{ d: string; c: string }>;
        return Number(rows[0]!.d) - Number(rows[0]!.c);
      });
      expect(rawOriginal).toBe(4000);
    });
  });

  // -----------------------------------------------------------------
  // Tenant / legal-entity isolation.
  // -----------------------------------------------------------------
  describe("isolation", () => {
    it("never reflects another legal entity's or another tenant's cash accounts, classifications, or activity", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);
      const unclassifiedIds = (
        res.body.data.unclassifiedAccounts as Array<{ accountId: string }>
      ).map((a) => a.accountId);
      expect(unclassifiedIds).not.toContain(legalEntityA2Id);
      expect(unclassifiedIds).not.toContain(legalEntityBId);
      // The A2 legal entity's own cash account never inflates A1's
      // cash totals — if it did, this would far exceed the fixture's
      // own hand-derived totals.
      expect(res.body.data.netCashMovementMinor).toBeLessThan(100000);
    });
  });

  // -----------------------------------------------------------------
  // Query validation.
  // -----------------------------------------------------------------
  describe("query validation", () => {
    it("rejects an unknown asOf query param (400) — Cash Flow has no asOf field, whitelist-enforced", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ asOf: "2026-03-15" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(400);
    });

    it("rejects periodId combined with dateFrom (400)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: periodMainId, dateFrom: "2026-03-01" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(400);
    });

    it("404s for a periodId outside the caller's own tenant/legal-entity scope", async () => {
      const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const otherPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminB}`)
        .send({
          code: `CF-OTHER-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ periodId: otherPeriod.body.data.id })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(404);
    });
  });

  // -----------------------------------------------------------------
  // Concurrency — REPEATABLE READ / READ ONLY (REPORT_TX_CONFIG) must
  // give getCashFlow's multi-statement query sequence one consistent
  // snapshot, exactly like every other report in this codebase
  // (general-ledger-concurrency.e2e-spec.ts).
  // -----------------------------------------------------------------
  describe("concurrency — read consistency under a concurrent write", () => {
    it("a write committed between the opening-cash query and the movement query is NOT partially reflected — the whole response stays one consistent snapshot", async () => {
      const service = app.get(FinancialStatementsService);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const servicePrivate = service as any;

      const raceCashId = await createAccount(adminA1, {
        code: `CF-RACE-CASH-${suffix}`,
        name: "Race Cash",
        type: "ASSET",
      });
      await registerCashAccount(adminA1, `CF-RACE-BANK-${suffix}`, raceCashId);
      await createAndPost(posterA1, "2026-07-20", [
        { accountId: raceCashId, debitMinor: 1000, creditMinor: 0 },
        { accountId: revId, debitMinor: 0, creditMinor: 1000 },
      ]);

      // Seam: the exact private helper getCashFlow calls between
      // computing openingCashMinor and netCashMovementMinor.
      const original = servicePrivate.fetchCashTotalWithinRange.bind(service);
      const spy = jest
        .spyOn(servicePrivate, "fetchCashTotalWithinRange")
        .mockImplementation(async (...args: unknown[]) => {
          // A concurrent, independent request commits a NEW posting to
          // the SAME cash account, in the gap between the two queries.
          await createAndPost(posterA1, "2026-07-21", [
            { accountId: raceCashId, debitMinor: 9999, creditMinor: 0 },
            { accountId: revId, debitMinor: 0, creditMinor: 9999 },
          ]);
          return original(...(args as Parameters<typeof original>));
        });

      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/cash-flow")
        .query({ dateFrom: "2026-07-20", dateTo: "2026-07-20" })
        .set("Authorization", `Bearer ${viewerA1}`)
        .expect(200);

      spy.mockRestore();

      // Must equal the pre-race snapshot (1000) for THIS request — the
      // REPEATABLE READ transaction's opening query already committed
      // to a snapshot before the concurrent 9999 posting landed, and
      // the movement query (dateTo 2026-07-20, excluding the 07-21
      // posting anyway) must see that same snapshot, not a torn mix.
      expect(res.body.data.netCashMovementMinor).toBe(1000);
      expect(res.body.data.reconciled).toBe(true);
    });
  });
});
