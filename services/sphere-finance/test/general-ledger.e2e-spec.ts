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
  chartOfAccounts,
  accountingPeriods,
  journalEntries,
  journalLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * 2d — General Ledger read layer: Account Ledger, Account Balance,
 * Trial Balance. docs/finance-2d-general-ledger-read-layer-proposal.md
 * §12.
 *
 * All journal entries used here are created and posted through the real
 * HTTP API (2c-1/2c-2), not inserted directly — every seeded POSTED
 * entry therefore satisfies 2b's balance trigger, gets a real
 * `journalNumber`, and resolves a real period, exactly like production
 * data. Direct DB access (`getFinanceDb()`) is used only for read-side
 * verification (row counts for the no-mutation-side-effects tests),
 * always wrapped in `withTenant()` — a raw, unwrapped `getFinanceDb()`
 * call throws under RLS (see journal-entries.e2e-spec.ts's own note on
 * this).
 */
describe("General Ledger (e2e) — 2d", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let cashA1Id: string;
  let revenueA1Id: string;
  let liabilityA1Id: string;
  let archivableA1Id: string;
  let zeroActivityA1Id: string;
  let accountA2Id: string;
  let accountBId: string;

  let openPeriodA1Id: string;
  let closablePeriodA1Id: string;

  // Journal numbers of the five main cashA1/revenueA1 postings, in
  // posting order — used by the ordering/determinism and pagination
  // tests to reason about expected order without re-deriving it.
  let mainEntryIds: string[] = [];

  function tokenFor(
    tenantId: string | null,
    legalEntityId: string | null,
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

  async function createAndPost(
    token: string,
    transactionDate: string,
    lines: Array<{
      accountId: string;
      debitMinor: number;
      creditMinor: number;
    }>,
    memo?: string,
  ): Promise<{ id: string; journalNumber: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate, memo, lines })
      .expect(201);
    const id = created.body.data.id;
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return { id, journalNumber: posted.body.data.journalNumber };
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
      .values({ slug: `gl-e2e-a-${suffix}`, name: "GL E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `gl-e2e-b-${suffix}`, name: "GL E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "GL Tenant A — Entity 1",
        code: "GLA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "GL Tenant A — Entity 2",
        code: "GLA2",
        countryCode: "AE",
        currencyCode: "USD",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "GL Tenant B — Entity 1",
        code: "GLB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [cashA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "GL-CASH-1",
        name: "Cash",
        type: "ASSET",
      })
      .returning();
    const [revenueA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "GL-REV-1",
        name: "Sales",
        type: "REVENUE",
      })
      .returning();
    const [liabilityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "GL-LIAB-1",
        name: "Accrued Liability",
        type: "LIABILITY",
      })
      .returning();
    const [archivableA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "GL-ARCHIVABLE-1",
        name: "Archived With History",
        type: "ASSET",
      })
      .returning();
    const [zeroActivityA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "GL-ZERO-1",
        name: "Never Posted",
        type: "ASSET",
      })
      .returning();
    const [accA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: "GL-A2-1",
        name: "Entity 2 Cash",
        type: "ASSET",
      })
      .returning();
    const [accB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantBId,
        legalEntityId: legalEntityBId,
        code: "GL-B-1",
        name: "Tenant B Cash",
        type: "ASSET",
      })
      .returning();
    cashA1Id = cashA1!.id;
    revenueA1Id = revenueA1!.id;
    liabilityA1Id = liabilityA1!.id;
    archivableA1Id = archivableA1!.id;
    zeroActivityA1Id = zeroActivityA1!.id;
    accountA2Id = accA2!.id;
    accountBId = accB!.id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
      "finance.poster",
    ]);

    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `GL-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closable = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `GL-CLOSABLE-${suffix}`,
        startDate: "2025-06-01",
        endDate: "2025-06-30",
      })
      .expect(201);
    closablePeriodA1Id = closable.body.data.id;

    // §2.1.5 opening-balance seed: dated before the main window below.
    await createAndPost(
      posterToken,
      "2026-01-01",
      [
        { accountId: cashA1Id, debitMinor: 500, creditMinor: 0 },
        { accountId: revenueA1Id, debitMinor: 0, creditMinor: 500 },
      ],
      "Opening seed",
    );

    // Five main postings, cashA1 debit / revenueA1 credit, ascending
    // dates and amounts — the backbone for running-balance, pagination,
    // and ordering tests.
    const amounts = [1000, 2000, 3000, 4000, 5000];
    const dates = [
      "2026-01-05",
      "2026-01-10",
      "2026-01-15",
      "2026-01-20",
      "2026-01-25",
    ];
    mainEntryIds = [];
    for (let i = 0; i < amounts.length; i++) {
      const { id } = await createAndPost(
        posterToken,
        dates[i]!,
        [
          { accountId: cashA1Id, debitMinor: amounts[i]!, creditMinor: 0 },
          { accountId: revenueA1Id, debitMinor: 0, creditMinor: amounts[i]! },
        ],
        `Main entry ${i + 1}`,
      );
      mainEntryIds.push(id);
    }

    // Two entries sharing the SAME transactionDate, posted in a known
    // order — §2.1.4's journalNumber tiebreaker test.
    await createAndPost(posterToken, "2026-02-01", [
      { accountId: cashA1Id, debitMinor: 100, creditMinor: 0 },
      { accountId: revenueA1Id, debitMinor: 0, creditMinor: 100 },
    ]);
    await createAndPost(posterToken, "2026-02-01", [
      { accountId: cashA1Id, debitMinor: 200, creditMinor: 0 },
      { accountId: revenueA1Id, debitMinor: 0, creditMinor: 200 },
    ]);

    // Abnormal-balance liability: debit liabilityA1 / credit cashA1 —
    // §4.3's core "placed by sign, not by type" test fixture.
    await createAndPost(posterToken, "2026-03-01", [
      { accountId: liabilityA1Id, debitMinor: 200, creditMinor: 0 },
      { accountId: cashA1Id, debitMinor: 0, creditMinor: 200 },
    ]);

    // Archived-with-history: post, then archive the account.
    await createAndPost(posterToken, "2026-03-05", [
      { accountId: archivableA1Id, debitMinor: 100, creditMinor: 0 },
      { accountId: revenueA1Id, debitMinor: 0, creditMinor: 100 },
    ]);
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounts/${archivableA1Id}/archive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // A DRAFT entry that must never appear in any 2d output.
    await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        transactionDate: "2026-01-12",
        lines: [
          { accountId: cashA1Id, debitMinor: 9999, creditMinor: 0 },
          { accountId: revenueA1Id, debitMinor: 0, creditMinor: 9999 },
        ],
      })
      .expect(201);

    // One entry inside the closable period, posted while it's still
    // OPEN, then the period is closed — §5.1.2's periodId->endDate and
    // closed-period-readability tests.
    await createAndPost(posterToken, "2025-06-15", [
      { accountId: cashA1Id, debitMinor: 300, creditMinor: 0 },
      { accountId: revenueA1Id, debitMinor: 0, creditMinor: 300 },
    ]);
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closablePeriodA1Id}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // -------------------------------------------------------------------
  // Auth / RBAC
  // -------------------------------------------------------------------
  describe("auth", () => {
    it("rejects a request with no token (401) on every 2d route", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .expect(401);
      await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .expect(401);
    });

    it("rejects a role outside finance.viewer/poster/admin (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it("finance.viewer (read-only role) can read all three routes (200)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("a token missing tenantId/legalEntityId is rejected (403)", async () => {
      const token = tokenFor(null, null, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------
  // Account Ledger
  // -------------------------------------------------------------------
  describe("Account Ledger — GET /accounts/:id/ledger", () => {
    const viewer = () =>
      tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

    it("404s for a nonexistent account id", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${randomUUID()}/ledger`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });

    it("404s for an account in a different legal entity within the same tenant", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountA2Id}/ledger`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });

    it("404s for an account belonging to a different tenant entirely", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${accountBId}/ledger`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });

    it("computes a correct opening balance and excludes DRAFT entries", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ dateFrom: "2026-01-03", dateTo: "2026-01-16", pageSize: 50 })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      // Opening seed (500, dated 2026-01-01) plus the closable-period
      // entry (300, dated 2025-06-15 — before dateFrom too, from a
      // different, already-CLOSED period) are both before dateFrom —
      // reflected in openingBalanceMinor, not as page rows: 500+300=800.
      expect(res.body.meta.openingBalanceMinor).toBe(800);
      // Only main entries 1-3 (1000, 2000, 3000) fall in
      // [2026-01-03, 2026-01-16] — the 9999 DRAFT entry (2026-01-12) is
      // excluded entirely, proving §2.1.3's unconditional POSTED filter.
      expect(res.body.data).toHaveLength(3);
      const amounts = res.body.data.map(
        (l: { debitMinor: number }) => l.debitMinor,
      );
      expect(amounts).toEqual([1000, 2000, 3000]);
      // Running balance accumulates from the opening balance.
      const running = res.body.data.map(
        (l: { runningBalanceMinor: number }) => l.runningBalanceMinor,
      );
      expect(running).toEqual([1800, 3800, 6800]);
      expect(res.body.meta.accountCode).toBe("GL-CASH-1");
      expect(res.body.meta.normalBalance).toBe("DEBIT");
    });

    it("computes correct signed running balance for a CREDIT-normal account", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${revenueA1Id}/ledger`)
        .query({ dateFrom: "2026-01-03", dateTo: "2026-01-16" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.meta.normalBalance).toBe("CREDIT");
      expect(res.body.meta.openingBalanceMinor).toBe(800);
      const running = res.body.data.map(
        (l: { runningBalanceMinor: number }) => l.runningBalanceMinor,
      );
      expect(running).toEqual([1800, 3800, 6800]);
    });

    it("deterministically orders two entries sharing the same transactionDate by journalNumber", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ dateFrom: "2026-02-01", dateTo: "2026-02-01" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].debitMinor).toBe(100);
      expect(res.body.data[1].debitMinor).toBe(200);
      expect(
        res.body.data[0].journalNumber < res.body.data[1].journalNumber,
      ).toBe(true);
    });

    it("paginates correctly and page 2's running balance is correct without ever fetching page 1", async () => {
      const page1 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          pageSize: 2,
          page: 1,
        })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      // 6 qualifying lines in January (opening seed 500 + 5 mains) —
      // dateFrom=2026-01-01 includes the opening seed as a row, not as
      // opening balance; the closable-period entry (300, dated
      // 2025-06-15) is before dateFrom and contributes to
      // openingBalanceMinor instead: 500, 1000, 2000, 3000, 4000, 5000
      // = 6 rows, totalPages = 3, openingBalanceMinor = 300.
      expect(page1.body.meta.totalItems).toBe(6);
      expect(page1.body.meta.totalPages).toBe(3);
      expect(page1.body.meta.openingBalanceMinor).toBe(300);
      expect(page1.body.data).toHaveLength(2);
      expect(
        page1.body.data.map((l: { debitMinor: number }) => l.debitMinor),
      ).toEqual([500, 1000]);
      expect(
        page1.body.data.map(
          (l: { runningBalanceMinor: number }) => l.runningBalanceMinor,
        ),
      ).toEqual([800, 1800]);

      const page2 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          pageSize: 2,
          page: 2,
        })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(
        page2.body.data.map((l: { debitMinor: number }) => l.debitMinor),
      ).toEqual([2000, 3000]);
      // Correct standalone, without page 1 ever having been fetched in
      // this request's own history — proves §2.1.6 step 3's per-page
      // starting-balance query is genuinely correct, not merely
      // consistent with sequential fetching.
      expect(
        page2.body.data.map(
          (l: { runningBalanceMinor: number }) => l.runningBalanceMinor,
        ),
      ).toEqual([3800, 6800]);
    });

    it("returns an empty page with zero opening balance for an account with no activity at all", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${zeroActivityA1Id}/ledger`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.openingBalanceMinor).toBe(0);
      expect(res.body.meta.totalItems).toBe(0);
    });

    it("remains readable for an archived account, and reflects its historical activity", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${archivableA1Id}/ledger`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].debitMinor).toBe(100);
    });

    it("rejects pageSize outside [1, 200] (400)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ pageSize: 0 })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ pageSize: 201 })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("rejects periodId combined with an explicit dateFrom (400)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ periodId: openPeriodA1Id, dateFrom: "2026-01-01" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("resolves periodId to that period's own [startDate, endDate] range", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ periodId: closablePeriodA1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.meta.effectiveDateFrom).toBe("2025-06-01");
      expect(res.body.meta.effectiveDateTo).toBe("2025-06-30");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].debitMinor).toBe(300);
    });
  });

  // -------------------------------------------------------------------
  // Account Balance
  // -------------------------------------------------------------------
  describe("Account Balance — GET /accounts/:id/balance", () => {
    const viewer = () =>
      tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

    it("asOf mode: opening is 0, movement/closing equal the full life-to-date balance", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .query({ asOf: "2026-01-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      // 500 + 1000+2000+3000+4000+5000 + 100+200 = 15800
      expect(res.body.data.openingBalanceMinor).toBe(0);
      expect(res.body.data.periodMovementMinor).toBe(15800);
      expect(res.body.data.closingBalanceMinor).toBe(15800);
      expect(res.body.data.totalDebitMinor).toBe(15800);
      expect(res.body.data.totalCreditMinor).toBe(0);
    });

    it("range mode: opening/movement/closing all meaningful, verified for both DEBIT- and CREDIT-normal accounts", async () => {
      const cash = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .query({ dateFrom: "2026-01-03", dateTo: "2026-01-16" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(cash.body.data.openingBalanceMinor).toBe(800);
      expect(cash.body.data.periodMovementMinor).toBe(6000); // 1000+2000+3000
      expect(cash.body.data.closingBalanceMinor).toBe(6800);

      const revenue = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${revenueA1Id}/balance`)
        .query({ dateFrom: "2026-01-03", dateTo: "2026-01-16" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(revenue.body.data.openingBalanceMinor).toBe(800);
      expect(revenue.body.data.periodMovementMinor).toBe(6000);
      expect(revenue.body.data.closingBalanceMinor).toBe(6800);
    });

    it("zero activity is not an error — all-zero movement with a correct (possibly nonzero) opening", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${zeroActivityA1Id}/balance`)
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data.openingBalanceMinor).toBe(0);
      expect(res.body.data.periodMovementMinor).toBe(0);
      expect(res.body.data.closingBalanceMinor).toBe(0);
    });

    it("rejects asOf combined with dateFrom (400)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .query({ asOf: "2026-01-31", dateFrom: "2026-01-01" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("defaults asOf to today, deterministically independent of the server process's local TZ (§4.8)", async () => {
      const expectedToday = new Date().toISOString().slice(0, 10);
      const originalTz = process.env.TZ;
      try {
        process.env.TZ = "Pacific/Kiritimati"; // UTC+14 — as far ahead of UTC as IANA goes
        const ahead = await request(app.getHttpServer())
          .get(`/v1/finance/accounts/${zeroActivityA1Id}/balance`)
          .set("Authorization", `Bearer ${viewer()}`)
          .expect(200);
        expect(ahead.body.data.effectiveDateTo).toBe(expectedToday);

        process.env.TZ = "Etc/GMT+12"; // UTC-12 — as far behind UTC as IANA goes
        const behind = await request(app.getHttpServer())
          .get(`/v1/finance/accounts/${zeroActivityA1Id}/balance`)
          .set("Authorization", `Bearer ${viewer()}`)
          .expect(200);
        expect(behind.body.data.effectiveDateTo).toBe(expectedToday);
      } finally {
        process.env.TZ = originalTz;
      }
    });
  });

  // -------------------------------------------------------------------
  // Trial Balance
  // -------------------------------------------------------------------
  describe("Trial Balance — GET /trial-balance", () => {
    const viewer = () =>
      tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

    it("Σdebit === Σcredit, asserted directly, for a realistic mix of account types", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.meta.totalDebitMinor).toBe(
        res.body.meta.totalCreditMinor,
      );
      const sumDebit = res.body.data.reduce(
        (s: number, r: { debitMinor: number }) => s + r.debitMinor,
        0,
      );
      const sumCredit = res.body.data.reduce(
        (s: number, r: { creditMinor: number }) => s + r.creditMinor,
        0,
      );
      expect(sumDebit).toBe(sumCredit);
      expect(sumDebit).toBe(res.body.meta.totalDebitMinor);
    });

    it("places an abnormal-balance liability account in the debit column as a positive number, never credit as negative", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const liabRow = res.body.data.find(
        (r: { accountId: string }) => r.accountId === liabilityA1Id,
      );
      expect(liabRow).toBeDefined();
      expect(liabRow.normalBalance).toBe("CREDIT");
      expect(liabRow.debitMinor).toBe(200);
      expect(liabRow.creditMinor).toBe(0);
    });

    it("always includes an archived account with nonzero activity, even with includeZeroBalance=false", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31", includeZeroBalance: false })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const row = res.body.data.find(
        (r: { accountId: string }) => r.accountId === archivableA1Id,
      );
      expect(row).toBeDefined();
      expect(row.isActive).toBe(false);
      expect(row.debitMinor).toBe(100);
    });

    it("excludes a zero-balance account by default, includes it with includeZeroBalance=true", async () => {
      const excluded = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(
        excluded.body.data.some(
          (r: { accountId: string }) => r.accountId === zeroActivityA1Id,
        ),
      ).toBe(false);

      const included = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const zeroRow = included.body.data.find(
        (r: { accountId: string }) => r.accountId === zeroActivityA1Id,
      );
      expect(zeroRow).toBeDefined();
      expect(zeroRow.debitMinor).toBe(0);
      expect(zeroRow.creditMinor).toBe(0);
    });

    it("never includes an account from a different legal entity or a different tenant", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const ids = res.body.data.map((r: { accountId: string }) => r.accountId);
      expect(ids).not.toContain(accountA2Id);
      expect(ids).not.toContain(accountBId);
    });

    it("orders rows by account code ascending", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ asOf: "2026-12-31", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const codes = res.body.data.map(
        (r: { accountCode: string }) => r.accountCode,
      );
      const sorted = [...codes].sort();
      expect(codes).toEqual(sorted);
    });

    it("periodId resolves to that period's endDate, remains readable once the period is CLOSED, and returns only activity up to it", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ periodId: closablePeriodA1Id, includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.meta.asOf).toBe("2025-06-30");
      expect(res.body.meta.periodId).toBe(closablePeriodA1Id);
      // Only the 2025-06-15 entry (300/300) has happened by this asOf —
      // every 2026 posting is excluded.
      const cashRow = res.body.data.find(
        (r: { accountId: string }) => r.accountId === cashA1Id,
      );
      expect(cashRow.debitMinor).toBe(300);
      const revenueRow = res.body.data.find(
        (r: { accountId: string }) => r.accountId === revenueA1Id,
      );
      expect(revenueRow.creditMinor).toBe(300);
    });

    it("404s for a periodId outside the caller's own tenant/legal-entity scope", async () => {
      const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const otherPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminB}`)
        .send({
          code: `GL-OTHER-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);
      await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ periodId: otherPeriod.body.data.id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });

    it("rejects periodId combined with an explicit asOf (400)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ periodId: closablePeriodA1Id, asOf: "2026-01-01" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("defaults asOf to today when neither asOf nor periodId is given", async () => {
      const expectedToday = new Date().toISOString().slice(0, 10);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.meta.asOf).toBe(expectedToday);
      expect(res.body.meta.periodId).toBeNull();
    });

    it("a legal entity with zero accounts returns an empty, trivially-reconciling report", async () => {
      const [emptyEntity] = await getPlatformDb()
        .insert(legalEntities)
        .values({
          tenantId: tenantAId,
          name: "GL Tenant A — Entity 3 (empty)",
          code: "GLA3",
          countryCode: "AE",
          currencyCode: "AED",
          isDefault: false,
        })
        .returning();
      const emptyViewer = tokenFor(tenantAId, emptyEntity!.id, [
        "finance.viewer",
      ]);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .set("Authorization", `Bearer ${emptyViewer}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.totalDebitMinor).toBe(0);
      expect(res.body.meta.totalCreditMinor).toBe(0);
      expect(res.body.meta.accountCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Reversals in GL views (§4.4)
  // -------------------------------------------------------------------
  describe("Reversals in GL views", () => {
    it("original and reversal both appear as independent ordinary lines; net effect on closing balance is zero", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const { id } = await createAndPost(poster, "2026-06-01", [
        { accountId: cashA1Id, debitMinor: 777, creditMinor: 0 },
        { accountId: revenueA1Id, debitMinor: 0, creditMinor: 777 },
      ]);

      // Baseline: the account's balance the day BEFORE the original
      // 777 entry existed at all.
      const beforeOriginal = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .query({ asOf: "2026-05-31" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/reverse`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ transactionDate: "2026-06-02" })
        .expect(201);

      const afterReversal = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .query({ asOf: "2026-06-02" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      // The reversal (credit 777, 2026-06-02) exactly offsets the
      // original (debit 777, 2026-06-01) — closing balance after both
      // have occurred equals closing balance before either existed.
      expect(afterReversal.body.data.closingBalanceMinor).toBe(
        beforeOriginal.body.data.closingBalanceMinor,
      );

      const ledger = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .query({ dateFrom: "2026-06-01", dateTo: "2026-06-02" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(ledger.body.data).toHaveLength(2);
      expect(ledger.body.data[0].debitMinor).toBe(777);
      expect(ledger.body.data[0].reversedByJournalEntryId).not.toBeNull();
      expect(ledger.body.data[1].creditMinor).toBe(777);
      expect(ledger.body.data[1].reversalOfJournalEntryId).toBe(id);
    });
  });

  // -------------------------------------------------------------------
  // No mutation side effects (§12)
  // -------------------------------------------------------------------
  describe("no mutation side effects", () => {
    it("calling every 2d endpoint produces zero writes to any Finance table or audit_logs", async () => {
      const viewer = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

      const countsBefore = await withTenant(tenantAId, async (tx) => ({
        entries: (await tx.select().from(journalEntries)).length,
        lines: (await tx.select().from(journalLines)).length,
        accounts: (await tx.select().from(chartOfAccounts)).length,
        periods: (await tx.select().from(accountingPeriods)).length,
      }));
      const platformDb = getPlatformDb();
      const auditBefore = await platformDb
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.tenantId, tenantAId), eq(auditLogs.action, "READ")),
        );

      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/ledger`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${cashA1Id}/balance`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);

      const countsAfter = await withTenant(tenantAId, async (tx) => ({
        entries: (await tx.select().from(journalEntries)).length,
        lines: (await tx.select().from(journalLines)).length,
        accounts: (await tx.select().from(chartOfAccounts)).length,
        periods: (await tx.select().from(accountingPeriods)).length,
      }));
      const auditAfter = await platformDb
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.tenantId, tenantAId), eq(auditLogs.action, "READ")),
        );

      expect(countsAfter).toEqual(countsBefore);
      expect(auditAfter.length).toBe(auditBefore.length);
    });
  });
});
