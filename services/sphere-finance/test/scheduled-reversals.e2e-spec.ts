import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import postgres from "postgres";
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
import { chartOfAccounts, journalEntries } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Scheduled Reversal for Accruals and Other Timing Adjustments — Final
 * Implementation Specification (Revision 2), §17. General lifecycle,
 * accounting-correctness, audit, and security coverage. The dedicated
 * manual-reverse-vs-process-due concurrency race is a SEPARATE file
 * (scheduled-reversals-concurrency.e2e-spec.ts) — not claimed as
 * covered here.
 */
describe("Scheduled reversals (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityAId: string;
  let legalEntityBId: string;
  let assetAccountId: string;
  let revenueAccountId: string;
  // Wide OPEN period covering both "past-and-due" and "future-and-not-
  // yet-due" target dates used across this file's tests.
  let openPeriodId: string;
  // Narrow CLOSED period — a due target date landing inside it must
  // FAIL at process-due time (not silently succeed against some other
  // period).
  let closedPeriodId: string;
  let suffix: number;

  function tokenFor(
    tenantId: string,
    legalEntityId: string,
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

  function balancedLines(accountId1: string, accountId2: string) {
    return [
      { accountId: accountId1, debitMinor: 1000, creditMinor: 0 },
      { accountId: accountId2, debitMinor: 0, creditMinor: 1000 },
    ];
  }

  async function postBalancedEntry(
    token: string,
    transactionDate: string,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({
        transactionDate,
        lines: balancedLines(assetAccountId, revenueAccountId),
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return id;
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
      .values({ slug: `sr-e2e-a-${suffix}`, name: "SR E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `sr-e2e-b-${suffix}`, name: "SR E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "SR Tenant A — Entity 1",
        code: "SRA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "SR Tenant B — Entity 1",
        code: "SRB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityAId = entityA!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [assetA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: "SR-ASSET-1",
        name: "Cash",
        type: "ASSET",
      })
      .returning();
    const [revenueA] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: "SR-REV-1",
        name: "Sales",
        type: "REVENUE",
      })
      .returning();
    assetAccountId = assetA!.id;
    revenueAccountId = revenueA!.id;

    const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
    const open = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `SR-OPEN-${suffix}`,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      })
      .expect(201);
    openPeriodId = open.body.data.id;

    const closed = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `SR-CLOSED-${suffix}`,
        startDate: "2019-01-01",
        endDate: "2019-01-31",
      })
      .expect(201);
    closedPeriodId = closed.body.data.id;
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closedPeriodId}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/cancel/process-due (403)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityAId, [
        "finance.poster",
      ]);
      const originalId = await postBalancedEntry(posterToken, "2026-06-01");

      const viewerToken = tokenFor(tenantAId, legalEntityAId, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-07-01" })
        .expect(403);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("finance.admin cannot create a scheduled reversal (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const posterToken = tokenFor(tenantAId, legalEntityAId, [
        "finance.poster",
      ]);
      const originalId = await postBalancedEntry(posterToken, "2026-06-02");
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-07-02" })
        .expect(403);
    });
  });

  describe("create", () => {
    it("creates a schedule for a posted entry against a covering OPEN period (201, SCHEDULED)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-03");

      const res = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);

      expect(res.body.data.status).toBe("SCHEDULED");
      expect(res.body.data.originalJournalEntryId).toBe(originalId);
      expect(res.body.data.targetDate).toBe("2026-08-01");
      expect(res.body.data.resultingReversalJournalEntryId).toBeNull();
      expect(res.body.data.failureReason).toBeNull();
      expect(res.body.data.executedAt).toBeNull();

      const db = getPlatformDb();
      const createRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, res.body.data.id),
            eq(auditLogs.action, "CREATE"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(createRows).toHaveLength(1);
    });

    it("succeeds even when no accounting period yet covers the target date (NOT_FOUND is not rejected at creation)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-04");
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2012-01-01" })
        .expect(201);
    });

    it("rejects a target date that falls in an already-CLOSED period (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-05");
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2019-01-15" })
        .expect(422);
    });

    it("rejects a nonexistent / cross-tenant original journal entry (404)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({
          originalJournalEntryId: randomUUID(),
          targetDate: "2026-08-01",
        })
        .expect(404);
    });

    it("rejects a DRAFT (not yet posted) original journal entry (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-06-06" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({
          originalJournalEntryId: draft.body.data.id,
          targetDate: "2026-08-01",
        })
        .expect(422);
    });

    it("rejects a second active schedule for the same original journal entry (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-07");
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-09-01" })
        .expect(409);
    });

    it("allows a new schedule for the same original once the prior schedule for it is CANCELLED (partial unique index is status-scoped)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-08");
      const first = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${first.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-09-01" })
        .expect(201);
    });
  });

  describe("cancel", () => {
    it("cancels a SCHEDULED row (200), writes a CANCEL audit row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-09");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);

      const cancelled = await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "No longer needed" })
        .expect(200);
      expect(cancelled.body.data.status).toBe("CANCELLED");

      const db = getPlatformDb();
      const cancelRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "CANCEL"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(cancelRows).toHaveLength(1);
    });

    it("rejects cancelling an already-CANCELLED row (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-10");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("rejects cancelling a nonexistent / cross-tenant schedule (404)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${randomUUID()}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("list / findOne — tenant isolation", () => {
    it("tenant B never sees tenant A's scheduled reversals via list or findOne", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(tokenA, "2026-06-11");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      const listB = await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);
      expect(
        (listB.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(false);

      await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(404);
    });

    it("filters list by status", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-12");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);

      const scheduled = await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals?status=SCHEDULED")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        (scheduled.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(true);

      const executed = await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals?status=EXECUTED")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        (executed.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(false);
    });

    it("rejects an invalid status filter (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .get("/v1/finance/scheduled-reversals?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });
  });

  describe("process-due — POST /scheduled-reversals/process-due", () => {
    it("executes a due schedule whose target date falls in an OPEN period: creates the reversal, links the original, transitions the schedule to EXECUTED, writes an EXECUTE audit row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-13");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        // In the past relative to "today" (env: 2026-09-01), so it is
        // due on the very next process-due call. Still inside the wide
        // OPEN period (2020-01-01..2030-12-31).
        .send({ originalJournalEntryId: originalId, targetDate: "2026-06-20" })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("EXECUTED");
      expect(after.body.data.resultingReversalJournalEntryId).not.toBeNull();
      expect(after.body.data.executedAt).not.toBeNull();
      expect(after.body.data.failureReason).toBeNull();

      const originalAfter = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(originalAfter.body.data.reversedByJournalEntryId).toBe(
        after.body.data.resultingReversalJournalEntryId,
      );

      const reversal = await request(app.getHttpServer())
        .get(
          `/v1/finance/journal-entries/${after.body.data.resultingReversalJournalEntryId}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(reversal.body.data.status).toBe("POSTED");
      expect(reversal.body.data.reversalOfJournalEntryId).toBe(originalId);
      expect(reversal.body.data.memo).toContain("Scheduled reversal of");

      const db = getPlatformDb();
      const executeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "EXECUTE"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(executeRows).toHaveLength(1);

      // Cancelling an already-EXECUTED row is rejected (409) —
      // terminal, per the immutability trigger + friendly pre-check.
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("leaves a not-yet-due schedule (target date in the future) SCHEDULED and untouched", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-14");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2029-12-25" })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("SCHEDULED");
    });

    it("a due schedule with no covering accounting period yet stays SCHEDULED (retried on a future run, not a failure)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-15");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2012-03-01" })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("SCHEDULED");
    });

    it("a due schedule whose target date falls in a CLOSED period transitions to FAILED with a failureReason, never touches the original", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      // Posted into the wide OPEN period; the schedule's own target
      // date is what lands in a period that is OPEN at creation time
      // (so create() does not reject it) but gets closed afterward —
      // exercising the execution-time CLOSED path specifically, distinct
      // from create()'s own already-tested CLOSED-at-creation rejection.
      const originalId = await postBalancedEntry(token, "2026-06-16");
      const dedicatedPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          code: `SR-CLOSE-LATER-${suffix}`,
          startDate: "2018-01-01",
          endDate: "2018-01-31",
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2018-01-20" })
        .expect(201);
      await request(app.getHttpServer())
        .patch(
          `/v1/finance/accounting-periods/${dedicatedPeriod.body.data.id}/close`,
        )
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("FAILED");
      expect(after.body.data.failureReason).toContain("closed");
      expect(after.body.data.resultingReversalJournalEntryId).toBeNull();

      const originalAfter = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(originalAfter.body.data.reversedByJournalEntryId).toBeNull();

      const db = getPlatformDb();
      const failRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "FAIL"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(failRows).toHaveLength(1);
    });

    it("a due schedule whose original was already manually reversed becomes CANCELLED, not FAILED — no duplicate reversal is ever created", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-17");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-06-25" })
        .expect(201);

      const manualReversal = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("CANCELLED");
      expect(after.body.data.resultingReversalJournalEntryId).toBeNull();

      const db = getPlatformDb();
      const cancelRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "CANCEL"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(cancelRows).toHaveLength(1);

      // Exactly one reversal of the original exists anywhere — the
      // manual one. The scheduled path never created a second.
      const reversalsOfOriginal = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.reversalOfJournalEntryId, originalId)),
      );
      expect(reversalsOfOriginal).toHaveLength(1);
      expect(reversalsOfOriginal[0]!.id).toBe(manualReversal.body.data.id);
    });

    it("running process-due twice is a no-op the second time for already-terminal rows (no re-execution, no duplicate audit rows)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-18");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-06-19" })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const firstRun = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(firstRun.body.data.status).toBe("EXECUTED");

      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const secondRun = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(secondRun.body.data).toEqual(firstRun.body.data);

      const db = getPlatformDb();
      const executeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "EXECUTE"),
            eq(auditLogs.entityType, "scheduled_reversal"),
          ),
        );
      expect(executeRows).toHaveLength(1);
    });

    it("process-due is scoped to the caller's own tenant/legal entity — tenant B's call never touches tenant A's due schedules", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(tokenA, "2026-06-21");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-06-22" })
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals/process-due")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/scheduled-reversals/${created.body.data.id}`)
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);
      expect(after.body.data.status).toBe("SCHEDULED");
    });
  });

  describe("database-level enforcement — direct psql, no service code", () => {
    it("the terminal-immutability trigger rejects a raw UPDATE on an already-CANCELLED row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-23");
      const created = await request(app.getHttpServer())
        .post("/v1/finance/scheduled-reversals")
        .set("Authorization", `Bearer ${token}`)
        .send({ originalJournalEntryId: originalId, targetDate: "2026-08-01" })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/scheduled-reversals/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          sql`UPDATE scheduled_reversals SET failure_reason = 'tampered' WHERE id = ${created.body.data.id}`,
        ).rejects.toThrow(/immutable/i);
        await expect(
          sql`DELETE FROM scheduled_reversals WHERE id = ${created.body.data.id}`,
        ).rejects.toThrow(/immutable/i);
      } finally {
        await sql.end();
      }
    });

    it("the terminal-fields-consistent CHECK constraint rejects an EXECUTED row with no resulting reversal id", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-06-24");

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO scheduled_reversals
              (tenant_id, legal_entity_id, original_journal_entry_id, target_date, status, executed_at)
            VALUES
              (${tenantAId}, ${legalEntityAId}, ${originalId}, '2026-01-01', 'EXECUTED', now())
          `,
        ).rejects.toThrow(/constraint|check/i);
      } finally {
        await sql.end();
      }
    });
  });
});
