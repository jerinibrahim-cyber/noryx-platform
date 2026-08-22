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
import {
  closeDb as closeFinanceDb,
  withTenant,
  type TxClient,
} from "../src/db/db";
import { chartOfAccounts } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import {
  GeneralLedgerService,
  REPORT_TX_CONFIG,
} from "../src/general-ledger/general-ledger.service";

/**
 * Follow-up to the 2d review (docs/finance-2d-general-ledger-read-layer-proposal.md):
 * a real, live-reproduced read-consistency gap in the three General
 * Ledger report methods, and the fix — REPEATABLE READ + READ ONLY
 * instead of the codebase's default READ COMMITTED for these
 * specifically, via an optional passthrough on `withTenantScoped`/
 * `withTenant` (packages/db-core/src/generic-client.ts,
 * services/sphere-finance/src/db/db.ts) that every other Finance
 * consumer (Accounts, AccountingPeriods, JournalEntries) never opts
 * into and is therefore unaffected by.
 *
 * Why this matters: each report method issues several separate SQL
 * statements inside one transaction (resolve account/period, opening
 * balance, page fetch, page-boundary predecessor, movement, ...).
 * Under Postgres's default READ COMMITTED, each statement gets its own
 * MVCC snapshot — so a journal entry posted and committed by a *different*
 * request, in the gap between two of a report's own statements, can be
 * reflected in one of that report's statements but not another,
 * producing a response whose parts don't reconcile with each other or
 * with any single point in time the ledger was ever actually in.
 * REPEATABLE READ gives the whole transaction one snapshot, taken at
 * its first statement — every statement in the report sees the same
 * data, with no row locks, no `FOR UPDATE`, and no accounting-model
 * change.
 *
 * Every scenario below is a genuine adversarial race: a second,
 * independent write is posted and committed (via the real HTTP API,
 * exactly like any other concurrent user) *while* the report's own
 * transaction is deterministically paused between two of its
 * statements, not a static assertion against a fixed dataset. The pause
 * point is pinned by directly reusing the service's own private
 * per-statement helpers (never duplicated SQL) for the mechanism-level
 * "old vs new" comparisons, and by `jest.spyOn`-ing the exact seam a
 * concurrent write would land at for the end-to-end tests against the
 * real, shipped `getLedger`/`getBalance`/`getTrialBalance`.
 */
describe("General Ledger — read consistency under concurrent writes (2d follow-up)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let service: GeneralLedgerService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let servicePrivate: any;
  let suffix: number;
  let tenantId: string;
  let legalEntityId: string;
  let posterToken: string;
  let widePeriodId: string;

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

  async function createAndPost(
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
      .set("Authorization", `Bearer ${posterToken}`)
      .send({ transactionDate, memo, lines })
      .expect(201);
    const id = created.body.data.id;
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return { id, journalNumber: posted.body.data.journalNumber };
  }

  /** A fresh (ASSET, REVENUE) account pair for one race — every race
   * gets its own accounts so an earlier race's concurrent write can
   * never contaminate a later race's "before" baseline. */
  // Deliberately wrapped in withTenant() rather than a bare getFinanceDb()
  // insert: a bare insert only satisfies chart_of_accounts' RLS policy
  // while app.current_tenant_id genuinely reads as SQL NULL on whatever
  // pooled connection services it, which is true only until the first
  // withTenant()-wrapped transaction runs on that same connection — after
  // a SET LOCAL commits, Postgres's placeholder GUC reverts to '' (a set,
  // non-NULL value), not back to NULL, so the "unset ⇒ RLS bypass" trick
  // silently stops working once any connection in the pool has ever been
  // used for a tenant-scoped request (verified directly against a live
  // transaction). withTenant() sets the real session var explicitly, so
  // it isn't sensitive to that pooled-connection history.
  async function freshAccountPair(label: string) {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [asset] = await tx
        .insert(chartOfAccounts)
        .values({
          tenantId,
          legalEntityId,
          code: `CX-A-${label}`,
          name: `Concurrency Asset ${label}`,
          type: "ASSET",
        })
        .returning();
      const [revenue] = await tx
        .insert(chartOfAccounts)
        .values({
          tenantId,
          legalEntityId,
          code: `CX-R-${label}`,
          name: `Concurrency Revenue ${label}`,
          type: "REVENUE",
        })
        .returning();
      return { assetId: asset!.id, revenueId: revenue!.id };
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

    service = app.get(GeneralLedgerService);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    servicePrivate = service as any;

    jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

    const platformDb = getPlatformDb();
    suffix = Date.now();
    const [tenant] = await platformDb
      .insert(tenants)
      .values({ slug: `gl-cx-${suffix}`, name: "GL Concurrency E2E Tenant" })
      .returning();
    tenantId = tenant!.id;
    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "GL Concurrency Entity",
        code: "GLCX",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    posterToken = tokenFor(["finance.poster"]);

    // A single wide-open period covering every date this file posts to
    // (2025-01-01 through 2026-12-31) — posting requires an OPEN period
    // covering the transaction date (JournalEntriesService.resolveAndLockOpenPeriod).
    // Reused (not duplicated) by the Trial Balance periodId test below —
    // periods for the same legal entity may not overlap.
    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${tokenFor(["finance.admin"])}`)
      .send({
        code: `CX-PERIOD-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    widePeriodId = period.body.data.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("mechanism: reusing the service's own statements, with the isolation level as the only variable", () => {
    it("Ledger's page-2 predecessor query — READ COMMITTED (pre-fix default) is torn", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `L1-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-02", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-03", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);

      // Ground truth: page 1 (pageSize 2) as actually served right now,
      // before any concurrent write exists.
      const page1 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${assetId}/ledger`)
        .query({ page: 1, pageSize: 2 })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      const page1Ending =
        page1.body.data[page1.body.data.length - 1].runningBalanceMinor;

      // Reproduce getLedger(page=2)'s own two statements directly — same
      // private helpers the shipped service calls — but WITHOUT
      // REPORT_TX_CONFIG, i.e. exactly pre-fix behavior.
      const torn = await withTenant(tenantId, async (tx: TxClient) => {
        const rows = await servicePrivate.fetchLedgerPage(
          tx,
          tenantId,
          legalEntityId,
          assetId,
          null,
          "2026-12-31",
          2,
          2,
        );
        const first = rows[0];

        // A genuinely concurrent write: a different request posts and
        // commits a new entry that belongs BEFORE page 2's first row —
        // i.e. it would have appeared on the page 1 already served above.
        await createAndPost("2026-01-01", [
          { accountId: assetId, debitMinor: 9999, creditMinor: 0 },
          { accountId: revenueId, debitMinor: 0, creditMinor: 9999 },
        ]);

        const predecessor = await servicePrivate.rawTotalsBeforeTuple(
          tx,
          tenantId,
          legalEntityId,
          assetId,
          null,
          "2026-12-31",
          first,
        );
        return predecessor.rawDebit - predecessor.rawCredit;
      });

      // Torn: the page-2 predecessor total picked up the concurrent
      // write, so it no longer reconciles with what page 1 actually
      // showed — the exact failure mode the review described.
      expect(torn).not.toBe(page1Ending);
    });

    it("Ledger's page-2 predecessor query — REPEATABLE READ (shipped fix) stays consistent", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `L2-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-02", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-03", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);

      const page1 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${assetId}/ledger`)
        .query({ page: 1, pageSize: 2 })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      const page1Ending =
        page1.body.data[page1.body.data.length - 1].runningBalanceMinor;

      const consistent = await withTenant(
        tenantId,
        async (tx: TxClient) => {
          const rows = await servicePrivate.fetchLedgerPage(
            tx,
            tenantId,
            legalEntityId,
            assetId,
            null,
            "2026-12-31",
            2,
            2,
          );
          const first = rows[0];

          await createAndPost("2026-01-01", [
            { accountId: assetId, debitMinor: 9999, creditMinor: 0 },
            { accountId: revenueId, debitMinor: 0, creditMinor: 9999 },
          ]);

          const predecessor = await servicePrivate.rawTotalsBeforeTuple(
            tx,
            tenantId,
            legalEntityId,
            assetId,
            null,
            "2026-12-31",
            first,
          );
          return predecessor.rawDebit - predecessor.rawCredit;
        },
        undefined,
        REPORT_TX_CONFIG,
      );

      // Consistent: the same race, but with the shipped isolation level
      // — the predecessor total is unaffected by the concurrent write
      // and matches exactly what page 1 already showed the user.
      expect(consistent).toBe(page1Ending);
    });

    it("Account Balance's opening/movement split — READ COMMITTED can return a value that never existed at any point in time", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `B1-${randomUUID().slice(0, 8)}`,
      );
      // original entry, dated before dateFrom
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 1000, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 1000 },
      ]);
      const dateFrom = "2026-06-01";
      const dateTo = "2026-06-30";
      const closingBefore = 1000; // truth before either concurrent write
      const closingAfter = 800; // truth after both: -500 (before dateFrom) + 300 (within range)

      const closing = await withTenant(tenantId, async (tx: TxClient) => {
        const opening = await servicePrivate.rawTotalsBefore(
          tx,
          tenantId,
          legalEntityId,
          assetId,
          dateFrom,
        );

        // Two independent concurrent writes straddle both statements —
        // e.g. one operator reverses an old miscoded entry (dated
        // before dateFrom) while another posts an unrelated correction
        // (dated within range) — an entirely realistic interleaving.
        await createAndPost("2026-05-15", [
          { accountId: revenueId, debitMinor: 500, creditMinor: 0 },
          { accountId: assetId, debitMinor: 0, creditMinor: 500 },
        ]);
        // ^ credits the asset account by 500 (reduces its debit-normal balance)
        await createAndPost("2026-06-15", [
          { accountId: assetId, debitMinor: 300, creditMinor: 0 },
          { accountId: revenueId, debitMinor: 0, creditMinor: 300 },
        ]);

        const movement = await servicePrivate.rawTotalsWithinRange(
          tx,
          tenantId,
          legalEntityId,
          assetId,
          dateFrom,
          dateTo,
        );
        return opening.netDelta + movement.netDelta;
      });

      // The torn result must not equal EITHER valid single-snapshot
      // truth — it's a value the ledger was never actually in.
      expect(closing).not.toBe(closingBefore);
      expect(closing).not.toBe(closingAfter);
    });

    it("Account Balance's opening/movement split — REPEATABLE READ (shipped fix) always returns a valid single-snapshot answer", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `B2-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 1000, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 1000 },
      ]);
      const dateFrom = "2026-06-01";
      const dateTo = "2026-06-30";
      const closingBefore = 1000;
      const closingAfter = 800;

      const closing = await withTenant(
        tenantId,
        async (tx: TxClient) => {
          const opening = await servicePrivate.rawTotalsBefore(
            tx,
            tenantId,
            legalEntityId,
            assetId,
            dateFrom,
          );

          await createAndPost("2026-05-15", [
            { accountId: revenueId, debitMinor: 500, creditMinor: 0 },
            { accountId: assetId, debitMinor: 0, creditMinor: 500 },
          ]);
          await createAndPost("2026-06-15", [
            { accountId: assetId, debitMinor: 300, creditMinor: 0 },
            { accountId: revenueId, debitMinor: 0, creditMinor: 300 },
          ]);

          const movement = await servicePrivate.rawTotalsWithinRange(
            tx,
            tenantId,
            legalEntityId,
            assetId,
            dateFrom,
            dateTo,
          );
          return opening.netDelta + movement.netDelta;
        },
        undefined,
        REPORT_TX_CONFIG,
      );

      // REPEATABLE READ's snapshot is fixed at the transaction's first
      // statement, before either concurrent write commits — so both
      // concurrent writes are uniformly invisible, and the result is
      // exactly the "before" state: a real point in time the ledger
      // genuinely was in, not a mix of two.
      expect(closing).toBe(closingBefore);
      expect(closing).not.toBe(closingAfter);
    });
  });

  describe("end-to-end: the real, shipped getLedger/getBalance/getTrialBalance under a genuine concurrent race", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("GET .../ledger stays consistent when a concurrent entry is posted mid-request", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `E1-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-02", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);
      await createAndPost("2026-01-03", [
        { accountId: assetId, debitMinor: 100, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 100 },
      ]);

      const page1 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${assetId}/ledger`)
        .query({ page: 1, pageSize: 2 })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      const page1Ending =
        page1.body.data[page1.body.data.length - 1].runningBalanceMinor;

      // Inject the concurrent write at the exact seam a real race would
      // land at inside the REAL getLedger call — right after it fetches
      // page 2's rows, right before it computes the page's predecessor
      // balance — then let the original implementation run.
      const original = servicePrivate.rawTotalsBeforeTuple.bind(service);
      jest
        .spyOn(servicePrivate, "rawTotalsBeforeTuple")
        .mockImplementation(async (...args: unknown[]) => {
          await createAndPost("2026-01-01", [
            { accountId: assetId, debitMinor: 9999, creditMinor: 0 },
            { accountId: revenueId, debitMinor: 0, creditMinor: 9999 },
          ]);
          return original(...args);
        });

      const page2 = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${assetId}/ledger`)
        .query({ page: 2, pageSize: 2 })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      const page2First = page2.body.data[0];
      const page2StartingBalance =
        page2First.runningBalanceMinor -
        (page2First.debitMinor - page2First.creditMinor);

      expect(page2StartingBalance).toBe(page1Ending);
    });

    it("GET .../balance stays a valid single-snapshot answer when two concurrent entries straddle opening and movement", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `E2-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2026-01-01", [
        { accountId: assetId, debitMinor: 1000, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 1000 },
      ]);

      const original = servicePrivate.rawTotalsWithinRange.bind(service);
      jest
        .spyOn(servicePrivate, "rawTotalsWithinRange")
        .mockImplementation(async (...args: unknown[]) => {
          await createAndPost("2026-05-15", [
            { accountId: revenueId, debitMinor: 500, creditMinor: 0 },
            { accountId: assetId, debitMinor: 0, creditMinor: 500 },
          ]);
          await createAndPost("2026-06-15", [
            { accountId: assetId, debitMinor: 300, creditMinor: 0 },
            { accountId: revenueId, debitMinor: 0, creditMinor: 300 },
          ]);
          return original(...args);
        });

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${assetId}/balance`)
        .query({ dateFrom: "2026-06-01", dateTo: "2026-06-30" })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      // Must equal the "before" snapshot (1000) — never the torn 1300
      // the mechanism-level test above proved READ COMMITTED can return,
      // and never a mid-flight partial mix.
      expect(res.body.data.closingBalanceMinor).toBe(1000);
      expect(res.body.data.closingBalanceMinor).not.toBe(1300);
    });

    it("GET /trial-balance reconciles (Σdebit=Σcredit) and never partially reflects a concurrent posting mid-request", async () => {
      const { assetId, revenueId } = await freshAccountPair(
        `E3-${randomUUID().slice(0, 8)}`,
      );
      await createAndPost("2025-01-01", [
        { accountId: assetId, debitMinor: 700, creditMinor: 0 },
        { accountId: revenueId, debitMinor: 0, creditMinor: 700 },
      ]);

      // Reuse the wide-open period from beforeAll rather than creating a
      // new one — periods for the same legal entity may not overlap.
      // Its endDate (2026-12-31) is still >= every date this test posts
      // to, so it resolves the same asOf role a dedicated period would.
      const periodId = widePeriodId;

      // Inject a concurrent post between period resolution and the
      // trial-balance aggregate itself — the only two statements
      // getTrialBalance's periodId path runs.
      const original = servicePrivate.resolvePeriodInScope.bind(service);
      jest
        .spyOn(servicePrivate, "resolvePeriodInScope")
        .mockImplementation(async (...args: unknown[]) => {
          await createAndPost("2025-06-01", [
            { accountId: assetId, debitMinor: 250, creditMinor: 0 },
            { accountId: revenueId, debitMinor: 0, creditMinor: 250 },
          ]);
          return original(...args);
        });

      const res = await request(app.getHttpServer())
        .get("/v1/finance/trial-balance")
        .query({ periodId })
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      // The service's own internal defensive assertion (§5.1.6) already
      // guarantees Σdebit=Σcredit or the request would have failed with
      // a 500 — asserting it explicitly here too documents that it held.
      expect(res.body.meta.totalDebitMinor).toBe(
        res.body.meta.totalCreditMinor,
      );

      // Deterministic, not "either value is fine": withTenant's own
      // SET LOCAL app.current_tenant_id (packages/db-core/src/generic-client.ts)
      // is unconditionally this transaction's first real statement, run
      // before getTrialBalance's own body — including resolvePeriodInScope
      // — even starts. Under REPEATABLE READ that pins the snapshot
      // before resolvePeriodInScope runs, so the concurrent write
      // injected inside it (committed strictly after) is invisible to
      // the later aggregate query too — verified independently against
      // a live transaction with this exact statement shape. The full
      // pre-race amount is therefore the only correct outcome; 950
      // would mean the isolation-level passthrough regressed.
      const row = res.body.data.find(
        (r: { accountId: string }) => r.accountId === assetId,
      );
      expect(row.debitMinor).toBe(700);
    });
  });
});
