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
  getDb as getFinanceDb,
  withTenant,
} from "../src/db/db";
import { chartOfAccounts, deferralRecognitions } from "../src/db/schema";
import { eq } from "@noryx/db-core";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Generic Deferral Recognition Engine — Phase 2 Implementation Contract
 * (docs/work-items/deferral-recognition-engine/CONTRACT.md §6), the
 * REQUIRED concurrency test (DEFER-024), direct structural mirror of
 * scheduled-reversals-concurrency.e2e-spec.ts's own "50 repetitions"
 * suite.
 *
 * The race here is simpler than ScheduledReversalsService's: there is
 * no separate "manual" path to race against a "scheduled" one — a
 * deferral occurrence is only ever executed by `process-due`. The
 * meaningful concurrent race is therefore two simultaneous
 * `POST /deferral-schedules/process-due` calls both landing on the
 * SAME due occurrence — the real-world shape of two overlapping
 * scheduler/cron invocations, or two operators triggering it by hand at
 * the same moment. `FOR UPDATE SKIP LOCKED` (CONTRACT.md §6) is the
 * mechanism under test: exactly one of the two transactions should ever
 * claim and execute a given occurrence row; the other must cleanly skip
 * it, never block on it, and never produce a second journal entry.
 */
describe("Deferral recognition — concurrent process-due() claims (real PostgreSQL)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let prepaidAssetAccountId: string;
  let expenseAccountId: string;
  let openPeriodId: string;
  let suffix: number;

  function tokenFor(roles: string[], userId?: string) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
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
        slug: `defer-conc-e2e-${suffix}`,
        name: "Deferral Recognition Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Deferral Recognition Concurrency E2E Entity",
        code: "DEFCONC1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [prepaid] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `DEFCONC-PREPAID-${suffix}`,
        name: "Prepaid Insurance",
        type: "ASSET",
      })
      .returning();
    const [expense] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `DEFCONC-EXPENSE-${suffix}`,
        name: "Insurance Expense",
        type: "EXPENSE",
      })
      .returning();
    prepaidAssetAccountId = prepaid!.id;
    expenseAccountId = expense!.id;

    const adminToken = tokenFor(["finance.admin"]);
    const open = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `DEFCONC-OPEN-${suffix}`,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      })
      .expect(201);
    openPeriodId = open.body.data.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  it("50 repetitions of two concurrent process-due() calls racing for the SAME single due occurrence (real PostgreSQL, two simultaneous HTTP requests via Promise.all per repetition): never a deadlock (no 500 from either call, ever), always exactly one EXECUTED occurrence, always exactly one journal entry", async () => {
    const REPETITIONS = 50;
    const token = tokenFor(["finance.poster"]);

    for (let i = 0; i < REPETITIONS; i++) {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/deferral-schedules")
        .set("Authorization", `Bearer ${token}`)
        .send({
          memo: `Concurrency race ${i}`,
          deferralType: "EXPENSE_RECOGNITION",
          deferredAccountId: prepaidAssetAccountId,
          recognitionAccountId: expenseAccountId,
          totalAmountMinor: 100,
          occurrences: [{ targetDate: "2026-01-01", amountMinor: 100 }],
        })
        .expect(201);
      const scheduleId = created.body.data.id;

      // The actual race: fired together, real HTTP, real concurrent
      // PostgreSQL transactions — not a simulated/sequential stand-in.
      const [firstRes, secondRes] = await Promise.all([
        request(app.getHttpServer())
          .post("/v1/finance/deferral-schedules/process-due")
          .set("Authorization", `Bearer ${token}`),
        request(app.getHttpServer())
          .post("/v1/finance/deferral-schedules/process-due")
          .set("Authorization", `Bearer ${token}`),
      ]);

      // No deadlock, ever: `FOR UPDATE SKIP LOCKED` guarantees the
      // losing transaction never blocks on the row the winner holds —
      // it simply doesn't see it as a candidate to claim. Both HTTP
      // calls always complete normally; a real deadlock would instead
      // surface as a 500 from one of them.
      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/deferral-schedules/${scheduleId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.status).toBe("COMPLETED");
      expect(after.body.data.recognitions).toHaveLength(1);
      expect(after.body.data.recognitions[0].status).toBe("EXECUTED");
      expect(
        after.body.data.recognitions[0].resultingJournalEntryId,
      ).not.toBeNull();

      // Exactly one of the two process-due() calls actually claimed and
      // executed this schedule's single occurrence — never both.
      const totalExecuted =
        firstRes.body.data.executed + secondRes.body.data.executed;
      expect(totalExecuted).toBe(1);

      // Exactly one journal entry was ever created for this occurrence
      // — never a duplicate from the losing transaction.
      const recognitionRow = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(deferralRecognitions)
          .where(eq(deferralRecognitions.scheduleId, scheduleId)),
      );
      expect(recognitionRow).toHaveLength(1);
      expect(recognitionRow[0]!.status).toBe("EXECUTED");
      expect(recognitionRow[0]!.resultingJournalEntryId).not.toBeNull();
    }
  }, 120000);
});
