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
 * Financial Statements — Profit & Loss.
 * docs/finance-work-item-financial-statements-proposal.md §6/§7/§15.
 *
 * Every account and journal entry used here is created and posted
 * through the real HTTP API, never inserted directly — including
 * hierarchy `parentId` relationships, so `AccountsService.create()`'s
 * actual (permissive — no type-consistency check, §2.2 of the proposal)
 * validation is what's exercised, exactly like production traffic.
 */
describe("Financial Statements — Profit & Loss (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let cashId: string;
  let revGrandparentId: string;
  let revParentId: string;
  let revLeafId: string;
  let expenseSimpleId: string;
  let revMismatchedId: string;
  let revZeroId: string;
  let periodP1Id: string;

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
      .values({ slug: `fs-pnl-e2e-a-${suffix}`, name: "FS P&L E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `fs-pnl-e2e-b-${suffix}`, name: "FS P&L E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "FS P&L Tenant A — Entity 1",
        code: "FSPNLA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "FS P&L Tenant A — Entity 2",
        code: "FSPNLA2",
        countryCode: "AE",
        currencyCode: "USD",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "FS P&L Tenant B — Entity 1",
        code: "FSPNLB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    const adminA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
    const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);

    cashId = await createAccount(adminA1, {
      code: "PNL-CASH",
      name: "Cash",
      type: "ASSET",
    });
    // §11's hierarchy test fixture: Grandparent -> Parent -> Leaf, all
    // REVENUE, Parent given its own direct postings.
    revGrandparentId = await createAccount(adminA1, {
      code: "PNL-REV-GP",
      name: "Revenue (Grandparent)",
      type: "REVENUE",
    });
    revParentId = await createAccount(adminA1, {
      code: "PNL-REV-P",
      name: "Revenue (Parent)",
      type: "REVENUE",
      parentId: revGrandparentId,
    });
    revLeafId = await createAccount(adminA1, {
      code: "PNL-REV-LEAF",
      name: "Revenue (Leaf)",
      type: "REVENUE",
      parentId: revParentId,
    });
    expenseSimpleId = await createAccount(adminA1, {
      code: "PNL-EXP",
      name: "Simple Expense",
      type: "EXPENSE",
    });
    // Type-mismatch fixture: a REVENUE account whose parentId points at
    // an EXPENSE account — §7.2/§18's explicitly CTO-approved promotion
    // rule. Must surface as its own REVENUE root, never under
    // expenseSimpleId, never dropped, never double-counted.
    revMismatchedId = await createAccount(adminA1, {
      code: "PNL-REV-MISMATCH",
      name: "Revenue (Mismatched Parent)",
      type: "REVENUE",
      parentId: expenseSimpleId,
    });
    revZeroId = await createAccount(adminA1, {
      code: "PNL-REV-ZERO",
      name: "Revenue (Never Posted)",
      type: "REVENUE",
    });

    // Cross-legal-entity / cross-tenant isolation fixtures.
    await createAccount(adminA2, {
      code: "PNL-A2-REV",
      name: "Entity 2 Revenue",
      type: "REVENUE",
    });
    await createAccount(adminB, {
      code: "PNL-B-REV",
      name: "Tenant B Revenue",
      type: "REVENUE",
    });

    // Every POSTED entry resolves an accounting period covering its
    // transaction date at posting time (JournalEntriesService.
    // resolveAndLockOpenPeriod) — the before/after periods exist only so
    // the out-of-window fixture postings (2025-12-15, 2026-02-05) land
    // inside SOME period, contiguous with periodP1 and never
    // overlapping. Neither id is referenced by any assertion.
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `PNL-PBEFORE-${suffix}`,
        startDate: "2025-12-01",
        endDate: "2025-12-31",
      })
      .expect(201);
    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `PNL-P1-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      })
      .expect(201);
    periodP1Id = period.body.data.id;
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `PNL-PAFTER-${suffix}`,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
      })
      .expect(201);

    // §6.2's movement-window fixture: activity before, within, and after
    // the [2026-01-01, 2026-01-31] window, so a wrongly-cumulative
    // implementation (Trial-Balance-style) is distinguishable from a
    // correctly-windowed one.
    await createAndPost(posterA1, "2025-12-15", [
      { accountId: cashId, debitMinor: 1000, creditMinor: 0 },
      { accountId: revLeafId, debitMinor: 0, creditMinor: 1000 },
    ]);
    await createAndPost(posterA1, "2026-01-05", [
      { accountId: cashId, debitMinor: 2000, creditMinor: 0 },
      { accountId: revLeafId, debitMinor: 0, creditMinor: 2000 },
    ]);
    // Parent's own direct postings (§2.5/§11 — a parent account can
    // itself receive journal lines).
    await createAndPost(posterA1, "2026-01-10", [
      { accountId: cashId, debitMinor: 500, creditMinor: 0 },
      { accountId: revParentId, debitMinor: 0, creditMinor: 500 },
    ]);
    await createAndPost(posterA1, "2026-01-12", [
      { accountId: cashId, debitMinor: 700, creditMinor: 0 },
      { accountId: revMismatchedId, debitMinor: 0, creditMinor: 700 },
    ]);
    await createAndPost(posterA1, "2026-01-20", [
      { accountId: expenseSimpleId, debitMinor: 300, creditMinor: 0 },
      { accountId: cashId, debitMinor: 0, creditMinor: 300 },
    ]);
    await createAndPost(posterA1, "2026-02-05", [
      { accountId: cashId, debitMinor: 9000, creditMinor: 0 },
      { accountId: revLeafId, debitMinor: 0, creditMinor: 9000 },
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
        .get("/v1/finance/financial-statements/profit-and-loss")
        .expect(401);
    });

    it("rejects a role outside finance.viewer/poster/admin (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["some.other.role"]);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    });

    it.each(["finance.viewer", "finance.poster", "finance.admin"])(
      "%s can read the route (200)",
      async (role) => {
        const token = tokenFor(tenantAId, legalEntityA1Id, [role]);
        await request(app.getHttpServer())
          .get("/v1/finance/financial-statements/profit-and-loss")
          .query({ periodId: periodP1Id })
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      },
    );
  });

  describe("GET /financial-statements/profit-and-loss", () => {
    const viewer = () =>
      tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

    it("§11 hierarchy: Parent ownBalance preserved, Leaf ownBalance preserved, subtotal rolls up correctly, root total equals the flat total", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      const roots = res.body.data.revenue.roots as Array<{
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
            children: unknown[];
          }>;
        }>;
      }>;
      const grandparent = roots.find((r) => r.accountId === revGrandparentId);
      expect(grandparent).toBeDefined();
      expect(grandparent!.ownBalanceMinor).toBe(0);

      const parent = grandparent!.children.find(
        (c) => c.accountId === revParentId,
      );
      expect(parent).toBeDefined();
      // Parent's own direct posting (500), NOT including the leaf.
      expect(parent!.ownBalanceMinor).toBe(500);

      const leaf = parent!.children.find((c) => c.accountId === revLeafId);
      expect(leaf).toBeDefined();
      // Only the within-window (2026-01-05) sale, 2000 — the
      // out-of-window 1000 (Dec) and 9000 (Feb) postings are excluded
      // (§6.2 — movement window, not cumulative).
      expect(leaf!.ownBalanceMinor).toBe(2000);

      // Parent subtotal = Parent own (500) + Leaf (2000) = 2500.
      expect(parent!.subtotalMinor).toBe(2500);
      // Grandparent subtotal = Grandparent own (0) + Parent subtotal (2500).
      expect(grandparent!.subtotalMinor).toBe(2500);

      // Root total (§7.4) equals the flat total the API reports.
      const rootTotal = roots.reduce(
        (sum: number, r: { subtotalMinor: number }) => sum + r.subtotalMinor,
        0,
      );
      expect(rootTotal).toBe(res.body.data.revenue.totalMinor);
    });

    it("§7.2/§18 type-mismatch: a REVENUE account whose parentId points at an EXPENSE account is promoted to its own REVENUE root — never dropped, never attached under the mismatched parent, never double-counted", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);

      const revenueRoots = res.body.data.revenue.roots as Array<{
        accountId: string;
        ownBalanceMinor: number;
        subtotalMinor: number;
      }>;
      const mismatched = revenueRoots.find(
        (r) => r.accountId === revMismatchedId,
      );
      expect(mismatched).toBeDefined();
      expect(mismatched!.ownBalanceMinor).toBe(700);
      expect(mismatched!.subtotalMinor).toBe(700);

      // Never nested under expenseSimpleId anywhere in the expense tree.
      const expenseRoots = res.body.data.expense.roots as Array<{
        accountId: string;
        children: Array<{ accountId: string }>;
      }>;
      const expenseParent = expenseRoots.find(
        (r) => r.accountId === expenseSimpleId,
      );
      expect(expenseParent).toBeDefined();
      expect(
        expenseParent!.children.some((c) => c.accountId === revMismatchedId),
      ).toBe(false);

      // Counted exactly once in the grand total.
      const occurrences = revenueRoots.filter(
        (r) => r.accountId === revMismatchedId,
      ).length;
      expect(occurrences).toBe(1);
    });

    it("§6.2 movement window: only in-window activity counts — a wrongly-cumulative implementation would report 12000, not 2000", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ dateFrom: "2026-01-01", dateTo: "2026-01-31" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const leaf = (
        res.body.data.revenue.roots as Array<{
          accountId: string;
          children: Array<{
            accountId: string;
            children: Array<{ accountId: string; ownBalanceMinor: number }>;
          }>;
        }>
      )
        .find((r) => r.accountId === revGrandparentId)!
        .children.find((c) => c.accountId === revParentId)!
        .children.find((c) => c.accountId === revLeafId)!;
      expect(leaf.ownBalanceMinor).toBe(2000);
    });

    it("open-ended dateFrom (omitted) reports cumulative-since-inception activity — 1000 + 2000 + 9000 = 12000", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ dateTo: "2026-02-28" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const leaf = (
        res.body.data.revenue.roots as Array<{
          accountId: string;
          children: Array<{
            accountId: string;
            children: Array<{ accountId: string; ownBalanceMinor: number }>;
          }>;
        }>
      )
        .find((r) => r.accountId === revGrandparentId)!
        .children.find((c) => c.accountId === revParentId)!
        .children.find((c) => c.accountId === revLeafId)!;
      expect(leaf.ownBalanceMinor).toBe(12000);
    });

    it("§6.3 sign convention: normal revenue/expense activity presents as a positive number", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data.revenue.totalMinor).toBeGreaterThan(0);
      expect(res.body.data.expense.totalMinor).toBeGreaterThan(0);
    });

    it("§6.4 net income = revenue - expense", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      // Revenue total: 2000 (leaf) + 500 (parent) + 700 (mismatched) = 3200.
      expect(res.body.data.revenue.totalMinor).toBe(3200);
      expect(res.body.data.expense.totalMinor).toBe(300);
      expect(res.body.data.netIncomeMinor).toBe(2900);
    });

    it("periodId resolves dateFrom/dateTo from the period's own start/end dates", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(res.body.data.dateFrom).toBe("2026-01-01");
      expect(res.body.data.dateTo).toBe("2026-01-31");
      expect(res.body.data.periodId).toBe(periodP1Id);
    });

    it("excludes a zero-activity account by default, includes it with includeZeroBalance=true", async () => {
      const excluded = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const flatten = (
        roots: Array<{ accountId: string; children: unknown[] }>,
      ): string[] =>
        roots.flatMap((r) => [
          r.accountId,
          ...flatten(r.children as typeof roots),
        ]);
      expect(flatten(excluded.body.data.revenue.roots)).not.toContain(
        revZeroId,
      );

      const included = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id, includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      expect(flatten(included.body.data.revenue.roots)).toContain(revZeroId);
    });

    it("never includes an account from a different legal entity or a different tenant", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id, includeZeroBalance: true })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(200);
      const flatten = (
        roots: Array<{ accountId: string; children: unknown[] }>,
      ): string[] =>
        roots.flatMap((r) => [
          r.accountId,
          ...flatten(r.children as typeof roots),
        ]);
      const ids = flatten(res.body.data.revenue.roots);
      expect(ids.every((id) => id !== "")).toBe(true);
      // The A2/tenant-B revenue accounts are never visible from A1's token.
      expect(ids).not.toEqual(
        expect.arrayContaining([legalEntityA2Id, legalEntityBId]),
      );
    });

    it("rejects an unknown asOf query param (400) — P&L has no asOf field, whitelist-enforced at the HTTP layer", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ asOf: "2026-01-15" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("rejects periodId combined with dateFrom (400)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: periodP1Id, dateFrom: "2026-01-01" })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(400);
    });

    it("404s for a periodId outside the caller's own tenant/legal-entity scope", async () => {
      const adminB = tokenFor(tenantBId, legalEntityBId, ["finance.admin"]);
      const otherPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminB}`)
        .send({
          code: `PNL-OTHER-${suffix}`,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        })
        .expect(201);
      await request(app.getHttpServer())
        .get("/v1/finance/financial-statements/profit-and-loss")
        .query({ periodId: otherPeriod.body.data.id })
        .set("Authorization", `Bearer ${viewer()}`)
        .expect(404);
    });
  });
});
