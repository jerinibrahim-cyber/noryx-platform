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
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Financial Statements — Balance Sheet.
 * docs/finance-work-item-financial-statements-proposal.md §7/§8/§9/§15.
 *
 * Every account and journal entry used here is created and posted
 * through the real HTTP API, never inserted directly — including
 * hierarchy `parentId` relationships.
 */
describe("Financial Statements — Balance Sheet (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityBId: string;

  let cashId: string;
  let assetGrandparentId: string;
  let assetParentId: string;
  let assetLeafId: string;
  let liabilitySimpleId: string;
  let assetMismatchedId: string;
  let assetZeroId: string;
  let equityCapitalId: string;
  let equityReserveId: string;
  let revenueId: string;
  let expenseId: string;
  let periodP0Id: string; // closable — 2025-06-01..2025-06-30
  let periodP2Id: string; // 2025-09-01..2025-09-30

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
    body: { code: string; name: string; type: string; parentId?: string },
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
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
  ): Promise<void> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate, lines })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
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
      .values({ slug: `fs-bs-e2e-a-${suffix}`, name: "FS BS E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `fs-bs-e2e-b-${suffix}`, name: "FS BS E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "FS BS Tenant A — Entity 1",
        code: "FSBSA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "FS BS Tenant B — Entity 1",
        code: "FSBSB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityBId = entityB!.id;

    const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    cashId = await createAccount(adminA1, {
      code: "BS-CASH",
      name: "Cash",
      type: "ASSET",
    });
    // §11's hierarchy test fixture: Grandparent -> Parent -> Leaf, all
    // ASSET, Parent given its own direct postings.
    assetGrandparentId = await createAccount(adminA1, {
      code: "BS-ASSET-GP",
      name: "Fixed Assets (Grandparent)",
      type: "ASSET",
    });
    assetParentId = await createAccount(adminA1, {
      code: "BS-ASSET-P",
      name: "Equipment (Parent)",
      type: "ASSET",
      parentId: assetGrandparentId,
    });
    assetLeafId = await createAccount(adminA1, {
      code: "BS-ASSET-LEAF",
      name: "Office Equipment (Leaf)",
      type: "ASSET",
      parentId: assetParentId,
    });
    liabilitySimpleId = await createAccount(adminA1, {
      code: "BS-LIAB",
      name: "Loan Payable",
      type: "LIABILITY",
    });
    // Type-mismatch fixture: an ASSET account whose parentId points at a
    // LIABILITY account — §7.2/§18's explicitly CTO-approved promotion
    // rule.
    assetMismatchedId = await createAccount(adminA1, {
      code: "BS-ASSET-MISMATCH",
      name: "Asset (Mismatched Parent)",
      type: "ASSET",
      parentId: liabilitySimpleId,
    });
    assetZeroId = await createAccount(adminA1, {
      code: "BS-ASSET-ZERO",
      name: "Asset (Never Posted)",
      type: "ASSET",
    });
    equityCapitalId = await createAccount(adminA1, {
      code: "BS-EQUITY-CAP",
      name: "Share Capital",
      type: "EQUITY",
    });
    // §6/§18 — a real EQUITY account nested under another EQUITY
    // account: proves recorded Equity accounts remain actual CoA
    // accounts and remain in the hierarchy, distinct from the computed
    // accumulated-earnings presentation line.
    equityReserveId = await createAccount(adminA1, {
      code: "BS-EQUITY-RESERVE",
      name: "Statutory Reserve",
      type: "EQUITY",
      parentId: equityCapitalId,
    });
    revenueId = await createAccount(adminA1, {
      code: "BS-REV",
      name: "Revenue",
      type: "REVENUE",
    });
    expenseId = await createAccount(adminA1, {
      code: "BS-EXP",
      name: "Expense",
      type: "EXPENSE",
    });

    // Cross-tenant isolation fixture.
    await createAccount(adminB, {
      code: "BS-B-ASSET",
      name: "Tenant B Asset",
      type: "ASSET",
    });

    const p0 = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `BS-P0-${suffix}`,
        startDate: "2025-06-01",
        endDate: "2025-06-30",
      })
      .expect(201);
    periodP0Id = p0.body.data.id;

    // Every POSTED entry resolves an accounting period covering its
    // transaction date at posting time (JournalEntriesService.
    // resolveAndLockOpenPeriod) — these two extra periods exist only so
    // every date used below lands inside SOME period, contiguous with
    // periodP0/periodP2 and never overlapping. Neither id is referenced
    // by any assertion.
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `BS-PEARLY-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2025-05-31",
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `BS-P1-${suffix}`,
        startDate: "2025-07-01",
        endDate: "2025-08-31",
      })
      .expect(201);

    const p2 = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `BS-P2-${suffix}`,
        startDate: "2025-09-01",
        endDate: "2025-09-30",
      })
      .expect(201);
    periodP2Id = p2.body.data.id;

    // §9 — the full fixture, dated to exercise the identity (§9.2),
    // the prior/current earnings split (§9.3), and period-closure
    // invariance (§9.4/§2.7) all from one consistent set of postings.
    await createAndPost(posterA1, "2025-01-01", [
      { accountId: cashId, debitMinor: 100000, creditMinor: 0 },
      { accountId: equityCapitalId, debitMinor: 0, creditMinor: 100000 },
    ]);
    // Inside periodP0 (2025-06-01..2025-06-30).
    await createAndPost(posterA1, "2025-06-15", [
      { accountId: assetLeafId, debitMinor: 500, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 500 },
    ]);
    // Parent's own direct postings (§2.5/§11).
    await createAndPost(posterA1, "2025-07-01", [
      { accountId: assetParentId, debitMinor: 1000, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 1000 },
    ]);
    await createAndPost(posterA1, "2025-07-05", [
      { accountId: cashId, debitMinor: 2000, creditMinor: 0 },
      { accountId: liabilitySimpleId, debitMinor: 0, creditMinor: 2000 },
    ]);
    await createAndPost(posterA1, "2025-07-10", [
      { accountId: assetMismatchedId, debitMinor: 300, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 300 },
    ]);
    // Prior-period revenue/expense (before periodP2).
    await createAndPost(posterA1, "2025-08-01", [
      { accountId: cashId, debitMinor: 5000, creditMinor: 0 },
      { accountId: revenueId, debitMinor: 0, creditMinor: 5000 },
    ]);
    await createAndPost(posterA1, "2025-08-05", [
      { accountId: expenseId, debitMinor: 1500, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 1500 },
    ]);
    // Current-period revenue/expense (inside periodP2).
    await createAndPost(posterA1, "2025-09-10", [
      { accountId: cashId, debitMinor: 800, creditMinor: 0 },
      { accountId: revenueId, debitMinor: 0, creditMinor: 800 },
    ]);
    await createAndPost(posterA1, "2025-09-15", [
      { accountId: expenseId, debitMinor: 200, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 200 },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // -------------------------------------------------------------------
  // Auth / RBAC — CTO decision 9.
  // -------------------------------------------------------------------
  describe("auth", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .expect(401);
    });

    it("rejects a role outside finance.viewer/poster/admin (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it.each(["finance.viewer", "finance.poster", "finance.admin"])(
      "%s can read the route (200)",
      async (role) => {
        const token = tokenFor(tenantAId, legalEntityA1Id, [role]);
        await request(app.getHttpServer())
          .get("/v1/finance/financial-statements/balance-sheet")
          .query({ asOf: "2025-09-30" })
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      },
    );
  });

  describe("GET /financial-statements/balance-sheet", () => {
    const viewer = () =>
      tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

    it("§11 hierarchy: Parent ownBalance preserved, Leaf ownBalance preserved, subtotal rolls up correctly, root total equals the flat total", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      const roots = res.body.data.assets.roots as Array<{
        accountId: string;
        ownBalanceMinor: number;
        subtotalMinor: number;
        children: Array<{
          accountId: string;
          ownBalanceMinor: number;
          subtotalMinor: number;
          children: Array<{
            accountId: string;
            ownBalanceMinor: number;
            subtotalMinor: number;
          }>;
        }>;
      }>;
      const grandparent = roots.find((r) => r.accountId === assetGrandparentId);
      expect(grandparent).toBeDefined();
      expect(grandparent!.ownBalanceMinor).toBe(0);

      const parent = grandparent!.children.find(
        (c) => c.accountId === assetParentId,
      );
      expect(parent).toBeDefined();
      expect(parent!.ownBalanceMinor).toBe(1000);

      const leaf = parent!.children.find((c) => c.accountId === assetLeafId);
      expect(leaf).toBeDefined();
      expect(leaf!.ownBalanceMinor).toBe(500);

      expect(parent!.subtotalMinor).toBe(1500); // 1000 + 500
      expect(grandparent!.subtotalMinor).toBe(1500); // 0 + 1500

      const rootTotal = roots.reduce(
        (sum: number, r: { subtotalMinor: number }) => sum + r.subtotalMinor,
        0,
      );
      expect(rootTotal).toBe(res.body.data.assets.totalMinor);
    });

    it("§7.2/§18 type-mismatch: an ASSET account whose parentId points at a LIABILITY account is promoted to its own ASSET root", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      const assetRoots = res.body.data.assets.roots as Array<{
        accountId: string;
        ownBalanceMinor: number;
        subtotalMinor: number;
      }>;
      const mismatched = assetRoots.find(
        (r) => r.accountId === assetMismatchedId,
      );
      expect(mismatched).toBeDefined();
      expect(mismatched!.ownBalanceMinor).toBe(300);

      const liabilityRoots = res.body.data.liabilities.roots as Array<{
        accountId: string;
        children: Array<{ accountId: string }>;
      }>;
      const liability = liabilityRoots.find(
        (r) => r.accountId === liabilitySimpleId,
      );
      expect(liability).toBeDefined();
      expect(
        liability!.children.some((c) => c.accountId === assetMismatchedId),
      ).toBe(false);

      expect(
        assetRoots.filter((r) => r.accountId === assetMismatchedId).length,
      ).toBe(1);
    });

    it("§9.2 accounting identity: Assets = Liabilities + Recorded Equity + Cumulative Net Income", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      expect(res.body.data.assets.totalMinor).toBe(106100);
      expect(res.body.data.liabilities.totalMinor).toBe(2000);
      expect(res.body.data.equity.recordedEquityMinor).toBe(100000);
      expect(res.body.data.equity.accumulatedEarnings.cumulativeMinor).toBe(
        4100,
      );
      expect(res.body.data.equity.totalEquityMinor).toBe(104100);

      expect(res.body.data.identity.assetsMinor).toBe(106100);
      expect(res.body.data.identity.liabilitiesPlusEquityMinor).toBe(106100);
      expect(res.body.data.identity.differenceMinor).toBe(0);
      expect(res.body.data.identity.reconciled).toBe(true);
    });

    it("§8.4 accumulated earnings is a computed presentation line only — no accountId, distinct from recorded EQUITY accounts, which remain real CoA rows in the hierarchy", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      expect(res.body.data.equity.accumulatedEarnings).not.toHaveProperty(
        "accountId",
      );

      const equityRoots = res.body.data.equity.roots as Array<{
        accountId: string;
        children: Array<{ accountId: string }>;
      }>;
      const capital = equityRoots.find((r) => r.accountId === equityCapitalId);
      expect(capital).toBeDefined();
      expect(
        capital!.children.some((c) => c.accountId === equityReserveId),
      ).toBe(true);
    });

    it("§9.3 periodId prior/current split additively reconstructs the cumulative figure", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ periodId: periodP2Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      expect(res.body.data.asOf).toBe("2025-09-30");
      expect(res.body.data.equity.accumulatedEarnings.priorPeriodsMinor).toBe(
        3500,
      );
      expect(res.body.data.equity.accumulatedEarnings.currentPeriodMinor).toBe(
        600,
      );
      expect(res.body.data.equity.accumulatedEarnings.cumulativeMinor).toBe(
        4100,
      );
      expect(
        res.body.data.equity.accumulatedEarnings.priorPeriodsMinor +
          res.body.data.equity.accumulatedEarnings.currentPeriodMinor,
      ).toBe(res.body.data.equity.accumulatedEarnings.cumulativeMinor);
    });

    it("asOf-only mode reports cumulative earnings with prior/current left null (§9.3)", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data.equity.accumulatedEarnings.priorPeriodsMinor).toBe(
        null,
      );
      expect(res.body.data.equity.accumulatedEarnings.currentPeriodMinor).toBe(
        null,
      );
      expect(res.body.data.equity.accumulatedEarnings.cumulativeMinor).toBe(
        4100,
      );
    });

    it("§9.4/§2.7 closing an accounting period does not change historical report results", async () => {
      const before = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-06-20" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      // Sanity: this asOf sits inside periodP0's own date range and
      // reflects exactly the capital contribution + the one within-P0
      // posting, nothing later.
      expect(before.body.data.assets.totalMinor).toBe(100000);
      expect(before.body.data.liabilities.totalMinor).toBe(0);
      expect(before.body.data.identity.reconciled).toBe(true);

      const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodP0Id}/close`)
        .set("Authorization", `Bearer ${adminA1}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-06-20" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      expect(after.body.data).toEqual(before.body.data);
    });

    it("periodId remains readable once CLOSED, resolving asOf from the period's own endDate", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ periodId: periodP0Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data.asOf).toBe("2025-06-30");
      expect(res.body.data.periodId).toBe(periodP0Id);
    });

    it("excludes a zero-balance account by default, includes it with includeZeroBalance=true", async () => {
      const excluded = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const flatten = (
        roots: Array<{ accountId: string; children: unknown[] }>,
      ): string[] =>
        roots.flatMap((r) => [
          r.accountId,
          ...flatten(r.children as typeof roots),
        ]);
      expect(flatten(excluded.body.data.assets.roots)).not.toContain(
        assetZeroId,
      );

      const included = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(flatten(included.body.data.assets.roots)).toContain(assetZeroId);
    });

    it("never includes an account from a different tenant", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30", includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const flatten = (
        roots: Array<{ accountId: string; children: unknown[] }>,
      ): string[] =>
        roots.flatMap((r) => [
          r.accountId,
          ...flatten(r.children as typeof roots),
        ]);
      const codes = flatten(res.body.data.assets.roots);
      expect(codes).not.toContain("BS-B-ASSET");
    });

    it("rejects unknown dateFrom/dateTo query params (400) — Balance Sheet has no range fields, whitelist-enforced at the HTTP layer", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ dateFrom: "2025-01-01", dateTo: "2025-12-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("rejects asOf combined with periodId (400)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ asOf: "2025-09-30", periodId: periodP2Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("404s for a periodId outside the caller's own tenant/legal-entity scope", async () => {
      const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const otherPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminB}`)
        .send({
          code: `BS-OTHER-${suffix}`,
          startDate: "2025-01-01",
          endDate: "2025-12-31",
        })
        .expect(201);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .query({ periodId: otherPeriod.body.data.id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });

    it("a legal entity with zero accounts returns an empty, trivially-reconciling Balance Sheet", async () => {
      const [emptyEntity] = await getPlatformDb()
        .insert(legalEntities)
        .values({
          tenantId: tenantAId,
          name: "FS BS Tenant A — Entity 2 (empty)",
          code: "FSBSA2",
          countryCode: "AE",
          currencyCode: "AED",
          isDefault: false,
        })
        .returning();
      const emptyViewer = tokenFor(tenantAId, emptyEntity!.id, [
        "finance.viewer",
      ]);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/balance-sheet")
        .set("Authorization", `Bearer ${emptyViewer}`)
        .expect(200);
      expect(res.body.data.assets.roots).toEqual([]);
      expect(res.body.data.assets.totalMinor).toBe(0);
      expect(res.body.data.liabilities.totalMinor).toBe(0);
      expect(res.body.data.equity.totalEquityMinor).toBe(0);
      expect(res.body.data.identity.reconciled).toBe(true);
    });
  });
});
