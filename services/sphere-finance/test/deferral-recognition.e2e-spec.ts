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
 * Generic Deferral Recognition Engine — Phase 2 Implementation Contract
 * (docs/work-items/deferral-recognition-engine/CONTRACT.md), Phase 3/4
 * acceptance coverage against
 * docs/work-items/deferral-recognition-engine/ACCEPTANCE.md's
 * DEFER-001..033 matrix. The dedicated concurrent-claim race is a
 * SEPARATE file (deferral-recognition-concurrency.e2e-spec.ts) — not
 * claimed as covered here.
 *
 * DEFER-NNN references appear inline against the test(s) that cover
 * each item; several items are proven jointly by one test.
 */
describe("Deferral recognition (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityAId: string;
  let legalEntityBId: string;
  let prepaidAssetAccountId: string;
  let expenseAccountId: string;
  let unearnedRevenueAccountId: string;
  let revenueAccountId: string;
  let inactiveAccountId: string;
  // Wide OPEN period covering both "past-and-due" and "future-and-not-
  // yet-due" target dates used across this file's tests.
  let openPeriodId: string;
  // Narrow CLOSED period — a due occurrence landing inside it must FAIL
  // at process-due time (not silently succeed against some other
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

  function expenseSchedulePayload(overrides: Record<string, unknown> = {}) {
    return {
      memo: "Prepaid insurance FY26",
      deferralType: "EXPENSE_RECOGNITION",
      deferredAccountId: prepaidAssetAccountId,
      recognitionAccountId: expenseAccountId,
      totalAmountMinor: 1200,
      occurrences: [
        { targetDate: "2026-01-01", amountMinor: 400 },
        { targetDate: "2026-02-01", amountMinor: 400 },
        { targetDate: "2026-03-01", amountMinor: 400 },
      ],
      ...overrides,
    };
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
      .values({ slug: `defer-e2e-a-${suffix}`, name: "Deferral E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `defer-e2e-b-${suffix}`, name: "Deferral E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Deferral Tenant A — Entity 1",
        code: "DEFA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Deferral Tenant B — Entity 1",
        code: "DEFB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityAId = entityA!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [prepaid] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: `DEFER-PREPAID-${suffix}`,
        name: "Prepaid Insurance",
        type: "ASSET",
      })
      .returning();
    const [expense] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: `DEFER-EXPENSE-${suffix}`,
        name: "Insurance Expense",
        type: "EXPENSE",
      })
      .returning();
    const [unearned] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: `DEFER-UNEARNED-${suffix}`,
        name: "Unearned Revenue",
        type: "LIABILITY",
      })
      .returning();
    const [revenue] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: `DEFER-REVENUE-${suffix}`,
        name: "Subscription Revenue",
        type: "REVENUE",
      })
      .returning();
    const [inactive] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityAId,
        code: `DEFER-INACTIVE-${suffix}`,
        name: "Inactive Account",
        type: "EXPENSE",
        isActive: false,
      })
      .returning();
    prepaidAssetAccountId = prepaid!.id;
    expenseAccountId = expense!.id;
    unearnedRevenueAccountId = unearned!.id;
    revenueAccountId = revenue!.id;
    inactiveAccountId = inactive!.id;

    const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
    const open = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `DEFER-OPEN-${suffix}`,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      })
      .expect(201);
    openPeriodId = open.body.data.id;

    const closed = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `DEFER-CLOSED-${suffix}`,
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
        .get("/v1/finance/deferral-schedules")
        .expect(401);
    });

    // DEFER-026
    it("finance.viewer can list/get (200) but cannot create/cancel/process-due (403)", async () => {
      const viewerToken = tokenFor(tenantAId, legalEntityAId, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .get("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send(expenseSchedulePayload())
        .expect(403);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    // DEFER-026
    it("finance.admin cannot create a deferral schedule (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(403);
    });

    // DEFER-026
    it("finance.poster can create, cancel, and process-due", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            occurrences: [{ targetDate: "2050-01-01", amountMinor: 1200 }],
          }),
        )
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });
  });

  describe("create", () => {
    // DEFER-001, DEFER-007
    it("creates a valid schedule (201): header ACTIVE, N occurrence rows SCHEDULED, amounts sum to total", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);

      expect(res.body.data.status).toBe("ACTIVE");
      expect(res.body.data.totalAmountMinor).toBe(1200);
      expect(res.body.data.currencyCode).toBe("AED");
      expect(res.body.data.recognitions).toHaveLength(3);
      const sum = res.body.data.recognitions.reduce(
        (s: number, r: { amountMinor: number }) => s + r.amountMinor,
        0,
      );
      expect(sum).toBe(1200);
      res.body.data.recognitions.forEach(
        (r: { status: string; sequenceNumber: number }, idx: number) => {
          expect(r.status).toBe("SCHEDULED");
          expect(r.sequenceNumber).toBe(idx + 1);
        },
      );

      const db = getPlatformDb();
      const createRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, res.body.data.id),
            eq(auditLogs.action, "CREATE"),
            eq(auditLogs.entityType, "deferral_schedule"),
          ),
        );
      expect(createRows).toHaveLength(1);
    });

    // DEFER-002
    it("rejects creation when occurrence amounts don't sum to the total (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload({ totalAmountMinor: 9999 }))
        .expect(422);
    });

    // DEFER-003
    it("rejects creation when deferredAccountId === recognitionAccountId (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            recognitionAccountId: prepaidAssetAccountId,
          }),
        )
        .expect(422);
    });

    // DEFER-004
    it("rejects creation with an inactive account (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({ recognitionAccountId: inactiveAccountId }),
        )
        .expect(422);
    });

    // DEFER-004
    it("rejects creation with a nonexistent account (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload({ deferredAccountId: randomUUID() }))
        .expect(422);
    });

    // DEFER-004
    it("rejects creation with a cross-tenant account (422)", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const financeDb = getFinanceDb();
      const [tenantBAccount] = await financeDb
        .insert(chartOfAccounts)
        .values({
          tenantId: tenantBId,
          legalEntityId: legalEntityBId,
          code: `DEFER-CROSS-${suffix}`,
          name: "Tenant B Account",
          type: "EXPENSE",
        })
        .returning();
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${tokenA}`)
        .send(
          expenseSchedulePayload({
            recognitionAccountId: tenantBAccount!.id,
          }),
        )
        .expect(422);
    });

    it("rejects a request with no occurrences (400, DTO validation)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload({ occurrences: [] }))
        .expect(400);
    });

    it("rejects two occurrences sharing the same targetDate (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 800,
            occurrences: [
              { targetDate: "2026-04-01", amountMinor: 400 },
              { targetDate: "2026-04-01", amountMinor: 400 },
            ],
          }),
        )
        .expect(422);
    });

    // DEFER-005
    it("tenant B never sees tenant A's deferral schedules via list or findOne", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${tokenA}`)
        .send(expenseSchedulePayload())
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      const listB = await request(app.getHttpServer())
        .get("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);
      expect(
        (listB.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(false);

      await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${created.body.data.id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(404);
    });

    // DEFER-006
    it("a second legal entity within tenant A never sees tenant A entity 1's deferral schedules", async () => {
      const platformDb = getPlatformDb();
      const [entityA2] = await platformDb
        .insert(legalEntities)
        .values({
          tenantId: tenantAId,
          name: "Deferral Tenant A — Entity 2",
          code: "DEFA2",
          countryCode: "AE",
          currencyCode: "AED",
        })
        .returning();

      const tokenA1 = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send(expenseSchedulePayload())
        .expect(201);

      const tokenA2 = tokenFor(tenantAId, entityA2!.id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${created.body.data.id}`)
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(404);
    });

    it("filters list by status", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);

      const active = await request(app.getHttpServer())
        .get("/v1/finance/deferral-schedules?status=ACTIVE")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        (active.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(true);

      const cancelled = await request(app.getHttpServer())
        .get("/v1/finance/deferral-schedules?status=CANCELLED")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(
        (cancelled.body.data as Array<{ id: string }>).some(
          (r) => r.id === created.body.data.id,
        ),
      ).toBe(false);
    });

    it("rejects an invalid status filter (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .get("/v1/finance/deferral-schedules?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });
  });

  describe("process-due — expense recognition", () => {
    // DEFER-008, DEFER-009, DEFER-010, DEFER-012, DEFER-013, DEFER-014,
    // DEFER-015, DEFER-016, DEFER-017, DEFER-018
    it("executes only due occurrences, posts a balanced, canonically-numbered journal entry through postSystemGeneratedEntry(), leaves the future occurrence untouched", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 800,
            occurrences: [
              // Due (in the past relative to "today").
              { targetDate: "2026-01-05", amountMinor: 400 },
              // Not yet due.
              { targetDate: "2029-12-25", amountMinor: 400 },
            ],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("ACTIVE"); // one occurrence still SCHEDULED
      const [dueRecognition, futureRecognition] = after.body.data
        .recognitions as Array<{
        id: string;
        status: string;
        resultingJournalEntryId: string | null;
        amountMinor: number;
      }>;
      expect(dueRecognition!.status).toBe("EXECUTED");
      expect(dueRecognition!.resultingJournalEntryId).not.toBeNull();
      expect(futureRecognition!.status).toBe("SCHEDULED");
      expect(after.body.data.remainingBalanceMinor).toBe(400);

      const journalEntryId = dueRecognition!.resultingJournalEntryId!;
      const journal = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${journalEntryId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(journal.body.data.status).toBe("POSTED");
      expect(journal.body.data.journalNumber).toMatch(/^JE-\d{6}$/);
      expect(journal.body.data.lines).toHaveLength(2);
      const totalDebit = journal.body.data.lines.reduce(
        (s: number, l: { debitMinor: number }) => s + l.debitMinor,
        0,
      );
      const totalCredit = journal.body.data.lines.reduce(
        (s: number, l: { creditMinor: number }) => s + l.creditMinor,
        0,
      );
      expect(totalDebit).toBe(400);
      expect(totalCredit).toBe(400);
      // EXPENSE_RECOGNITION: debit recognition (expense), credit
      // deferred (prepaid asset).
      const debitLine = journal.body.data.lines.find(
        (l: { debitMinor: number }) => l.debitMinor > 0,
      );
      const creditLine = journal.body.data.lines.find(
        (l: { creditMinor: number }) => l.creditMinor > 0,
      );
      expect(debitLine.accountId).toBe(expenseAccountId);
      expect(creditLine.accountId).toBe(prepaidAssetAccountId);

      const db = getPlatformDb();
      const executeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, dueRecognition!.id),
            eq(auditLogs.action, "EXECUTE"),
            eq(auditLogs.entityType, "deferral_recognition"),
          ),
        );
      expect(executeRows).toHaveLength(1);
      const journalCreateRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, journalEntryId),
            eq(auditLogs.action, "CREATE"),
            eq(auditLogs.entityType, "journal_entry"),
          ),
        );
      const journalPostRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, journalEntryId),
            eq(auditLogs.action, "POST"),
            eq(auditLogs.entityType, "journal_entry"),
          ),
        );
      expect(journalCreateRows).toHaveLength(1);
      expect(journalPostRows).toHaveLength(1);

      // DEFER-018/DEFER-027 — reverse drill-down.
      const reverse = await request(app.getHttpServer())
        .get(
          `/v1/finance/deferral-schedules/recognitions/by-journal-entry/${journalEntryId}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(reverse.body.data.scheduleId).toBe(scheduleId);
    });

    // DEFER-016 — revenue-direction schedule proves the two-direction
    // lines are actually different, not a hardcoded expense-only shape.
    it("REVENUE_RECOGNITION schedule debits the deferred (liability) account and credits the recognition (revenue) account", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send({
          memo: "Unearned subscription revenue",
          deferralType: "REVENUE_RECOGNITION",
          deferredAccountId: unearnedRevenueAccountId,
          recognitionAccountId: revenueAccountId,
          totalAmountMinor: 600,
          occurrences: [{ targetDate: "2026-01-10", amountMinor: 600 }],
        })
        .expect(201);

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("COMPLETED"); // DEFER — completion
      const [recognition] = after.body.data.recognitions;
      const journal = await request(app.getHttpServer())
        .get(
          `/v1/finance/journal-entries/${recognition.resultingJournalEntryId}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const debitLine = journal.body.data.lines.find(
        (l: { debitMinor: number }) => l.debitMinor > 0,
      );
      const creditLine = journal.body.data.lines.find(
        (l: { creditMinor: number }) => l.creditMinor > 0,
      );
      expect(debitLine.accountId).toBe(unearnedRevenueAccountId);
      expect(creditLine.accountId).toBe(revenueAccountId);
    });

    // DEFER-011 — multiple occurrences across multiple process-due calls.
    it("a 4-occurrence schedule processed over multiple process-due calls reaches COMPLETED with 4 distinct journal entries", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [
              { targetDate: "2026-02-10", amountMinor: 100 },
              { targetDate: "2026-02-11", amountMinor: 100 },
              { targetDate: "2026-02-12", amountMinor: 100 },
              { targetDate: "2026-02-13", amountMinor: 100 },
            ],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      // All four are due relative to "today" (env: 2026-09-01) — but
      // process multiple times anyway to prove idempotent repeated
      // calls converge, not just a single pass.
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("COMPLETED");
      expect(after.body.data.remainingBalanceMinor).toBe(0);
      const journalEntryIds = new Set(
        after.body.data.recognitions.map(
          (r: { resultingJournalEntryId: string }) => r.resultingJournalEntryId,
        ),
      );
      expect(journalEntryIds.size).toBe(4);
      after.body.data.recognitions.forEach((r: { status: string }) =>
        expect(r.status).toBe("EXECUTED"),
      );
    });

    // DEFER-023 — running process-due twice is a no-op the second time.
    it("running process-due twice is a no-op for already-terminal occurrences (no re-execution, no duplicate audit rows, no duplicate journal entries)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2026-03-15", amountMinor: 400 }],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const firstRun = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const secondRun = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(secondRun.body.data).toEqual(firstRun.body.data);

      const db = getPlatformDb();
      const recognitionId = firstRun.body.data.recognitions[0].id;
      const executeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, recognitionId),
            eq(auditLogs.action, "EXECUTE"),
            eq(auditLogs.entityType, "deferral_recognition"),
          ),
        );
      expect(executeRows).toHaveLength(1);
    });

    // DEFER-021 — closed target period fails without touching other
    // occurrences.
    it("an occurrence due in a CLOSED period transitions to FAILED with a reason; other SCHEDULED occurrences of the same schedule are untouched", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const dedicatedPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          code: `DEFER-CLOSE-LATER-${suffix}`,
          startDate: "2017-01-01",
          endDate: "2017-01-31",
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 800,
            occurrences: [
              { targetDate: "2017-01-20", amountMinor: 400 },
              { targetDate: "2028-03-20", amountMinor: 400 },
            ],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;
      await request(app.getHttpServer())
        .patch(
          `/v1/finance/accounting-periods/${dedicatedPeriod.body.data.id}/close`,
        )
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("ACTIVE");
      const [closedOccurrence, futureOccurrence] = after.body.data
        .recognitions as Array<{ status: string; failureReason: string }>;
      expect(closedOccurrence!.status).toBe("FAILED");
      expect(closedOccurrence!.failureReason).toContain("closed");
      expect(futureOccurrence!.status).toBe("SCHEDULED");

      const db = getPlatformDb();
      const failRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(
              auditLogs.entityId,
              (closedOccurrence as unknown as { id: string }).id,
            ),
            eq(auditLogs.action, "FAIL"),
            eq(auditLogs.entityType, "deferral_recognition"),
          ),
        );
      expect(failRows).toHaveLength(1);
    });

    // DEFER-009 (isolated) + a mixed EXECUTED/FAILED completion.
    it("a schedule whose occurrences resolve to a mix of EXECUTED and FAILED still reaches COMPLETED (not stuck ACTIVE)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const adminToken = tokenFor(tenantAId, legalEntityAId, ["finance.admin"]);
      const dedicatedPeriod = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          code: `DEFER-MIXED-${suffix}`,
          startDate: "2016-01-01",
          endDate: "2016-01-31",
        })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 800,
            occurrences: [
              { targetDate: "2016-01-15", amountMinor: 400 },
              { targetDate: "2026-04-01", amountMinor: 400 },
            ],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;
      await request(app.getHttpServer())
        .patch(
          `/v1/finance/accounting-periods/${dedicatedPeriod.body.data.id}/close`,
        )
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("COMPLETED");
      const statuses = (
        after.body.data.recognitions as Array<{ status: string }>
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual(["EXECUTED", "FAILED"]);
    });

    // DEFER-009
    it("a due schedule with no covering accounting period yet stays SCHEDULED (retried on a future run, not a failure)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2011-01-01", amountMinor: 400 }],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.recognitions[0].status).toBe("SCHEDULED");
    });

    it("process-due is scoped to the caller's own tenant/legal entity — tenant B's call never touches tenant A's due occurrences", async () => {
      const tokenA = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${tokenA}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2026-05-01", amountMinor: 400 }],
          }),
        )
        .expect(201);

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${created.body.data.id}`)
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);
      expect(after.body.data.recognitions[0].status).toBe("SCHEDULED");
    });
  });

  describe("cancel", () => {
    // DEFER-019
    it("cancels a schedule with no executed occurrences (200): every occurrence CANCELLED, writes a CANCEL audit row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);

      const cancelled = await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "No longer needed" })
        .expect(200);
      expect(cancelled.body.data.status).toBe("CANCELLED");
      cancelled.body.data.recognitions.forEach((r: { status: string }) =>
        expect(r.status).toBe("CANCELLED"),
      );

      const db = getPlatformDb();
      const cancelRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "CANCEL"),
            eq(auditLogs.entityType, "deferral_schedule"),
          ),
        );
      expect(cancelRows).toHaveLength(1);
    });

    // DEFER-019
    it("cancels a partially-executed schedule: only remaining SCHEDULED occurrences become CANCELLED, executed ones are untouched", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 800,
            occurrences: [
              { targetDate: "2026-06-01", amountMinor: 400 },
              { targetDate: "2027-06-01", amountMinor: 400 },
            ],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const cancelled = await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${scheduleId}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(cancelled.body.data.status).toBe("CANCELLED");
      const [executedOne, cancelledOne] = cancelled.body.data.recognitions;
      expect(executedOne.status).toBe("EXECUTED");
      expect(cancelledOne.status).toBe("CANCELLED");
    });

    it("rejects cancelling an already-CANCELLED schedule (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("rejects cancelling a COMPLETED schedule (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2026-07-01", amountMinor: 400 }],
          }),
        )
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules/process-due")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("rejects cancelling a nonexistent / cross-tenant schedule (404)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${randomUUID()}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    // DEFER-020 — Model B: amendment is cancel + create, composed by
    // the caller. No "amend" endpoint exists to test directly; this
    // demonstrates the composition works end to end.
    it("amendment is demonstrated as cancel + create (no dedicated amend endpoint exists)", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const original = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${original.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "Amending: replaced by a corrected schedule" })
        .expect(200);
      const amended = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 1500,
            occurrences: [
              { targetDate: "2026-01-01", amountMinor: 500 },
              { targetDate: "2026-02-01", amountMinor: 500 },
              { targetDate: "2026-03-01", amountMinor: 500 },
            ],
          }),
        )
        .expect(201);
      expect(amended.body.data.id).not.toBe(original.body.data.id);
      expect(amended.body.data.totalAmountMinor).toBe(1500);
    });
  });

  describe("reporting / drill-down", () => {
    // DEFER-027
    it("lists a schedule's own occurrences via the dedicated recognitions route", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);
      const recognitions = await request(app.getHttpServer())
        .get(
          `/v1/finance/deferral-schedules/${created.body.data.id}/recognitions`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(recognitions.body.data).toHaveLength(3);
    });

    it("404s the recognitions route for a nonexistent / cross-tenant schedule", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${randomUUID()}/recognitions`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("404s the by-journal-entry reverse lookup for a journal entry with no deferral recognition", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const draft = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-01-01" })
        .expect(201);
      await request(app.getHttpServer())
        .get(
          `/v1/finance/deferral-schedules/recognitions/by-journal-entry/${draft.body.data.id}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("database-level enforcement — direct psql, no service code", () => {
    // DEFER-025
    it("the deferral_schedules terminal-immutability trigger rejects a raw UPDATE/DELETE on an already-CANCELLED row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          sql`UPDATE deferral_schedules SET memo = 'tampered' WHERE id = ${created.body.data.id}`,
        ).rejects.toThrow(/immutable/i);
        await expect(
          sql`DELETE FROM deferral_schedules WHERE id = ${created.body.data.id}`,
        ).rejects.toThrow(/immutable/i);
      } finally {
        await sql.end();
      }
    });

    // DEFER-025
    it("the deferral_recognitions terminal-immutability trigger rejects a raw UPDATE/DELETE on an already-CANCELLED row", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2026-08-01", amountMinor: 400 }],
          }),
        )
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/deferral-schedules/${created.body.data.id}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const recognitionId = created.body.data.recognitions[0].id;

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          sql`UPDATE deferral_recognitions SET failure_reason = 'tampered' WHERE id = ${recognitionId}`,
        ).rejects.toThrow(/immutable/i);
        await expect(
          sql`DELETE FROM deferral_recognitions WHERE id = ${recognitionId}`,
        ).rejects.toThrow(/immutable/i);
      } finally {
        await sql.end();
      }
    });

    // DEFER-025
    it("the terminal-fields-consistent CHECK constraint rejects an EXECUTED occurrence row with no resulting journal entry id", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(expenseSchedulePayload())
        .expect(201);
      const scheduleId = created.body.data.id;

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          sql`
            INSERT INTO deferral_recognitions
              (schedule_id, tenant_id, legal_entity_id, sequence_number, target_date, amount_minor, status, executed_at)
            VALUES
              (${scheduleId}, ${tenantAId}, ${legalEntityAId}, 99, '2099-01-01', 1, 'EXECUTED', now())
          `,
        ).rejects.toThrow(/constraint|check/i);
      } finally {
        await sql.end();
      }
    });

    // DEFER-033
    it("the deferred aggregate-reconciliation trigger rejects a raw INSERT that breaks Σ(amount_minor) = total_amount_minor at commit time", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send(
          expenseSchedulePayload({
            totalAmountMinor: 400,
            occurrences: [{ targetDate: "2026-09-10", amountMinor: 400 }],
          }),
        )
        .expect(201);
      const scheduleId = created.body.data.id;

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        // A second occurrence row that pushes the sum (800) past
        // total_amount_minor (400) — rejected at COMMIT, not at the
        // INSERT statement itself (the trigger is DEFERRABLE INITIALLY
        // DEFERRED), proving it is a true deferred aggregate check.
        await expect(
          sql.begin(async (tx) => {
            await tx`
              INSERT INTO deferral_recognitions
                (schedule_id, tenant_id, legal_entity_id, sequence_number, target_date, amount_minor, status)
              VALUES
                (${scheduleId}, ${tenantAId}, ${legalEntityAId}, 2, '2026-09-11', 400, 'SCHEDULED')
            `;
          }),
        ).rejects.toThrow(/not reconciled/i);

        // The rejected transaction rolled back entirely — still exactly
        // one occurrence row for this schedule.
        const rows = await sql`
          SELECT count(*)::int AS n FROM deferral_recognitions WHERE schedule_id = ${scheduleId}
        `;
        expect(rows[0]!.n).toBe(1);
      } finally {
        await sql.end();
      }
    });
  });

  // DEFER-028 — regression: Journal Engine unaffected by this work item.
  describe("regression — Journal Engine", () => {
    it("manual journal-entry create/post continues to work unmodified alongside the new postSystemGeneratedEntry() path", async () => {
      const token = tokenFor(tenantAId, legalEntityAId, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-01-15",
          lines: [
            { accountId: expenseAccountId, debitMinor: 500, creditMinor: 0 },
            {
              accountId: prepaidAssetAccountId,
              debitMinor: 0,
              creditMinor: 500,
            },
          ],
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.journalNumber).toMatch(/^JE-\d{6}$/);
    });
  });
});
