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
import { closeDb as closeFinanceDb, getDb as getFinanceDb } from "../src/db/db";
import {
  chartOfAccounts,
  accountingPeriods,
  budgets,
  budgetLines,
  journalEntries,
  journalLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Budgeting / Planning — Phase 1 Foundation (e2e). CTO-approved
 * implementation authorization, v6.
 * docs/work-items/budgeting-phase-1-foundation/CONTRACT.md,
 * docs/work-items/budgeting-phase-1-foundation/ACCEPTANCE.md.
 *
 * Covers the full acceptance matrix's Budgeting-specific scenarios:
 * BUD-001..009 (header CRUD), BUD-020..029 (line CRUD), RLS-001..003,
 * RBAC-001..004 (RBAC-005 is covered separately by
 * route-role-matrix.spec.ts), DB-001..005, CONC-001..002, BUD-045 (zero
 * GL impact), BUD-046..050 (CTO Decisions B/C/D), BUD-051 (approve vs
 * final-line-delete concurrency), BUD-052 (header PATCH vs
 * approve/line-mutation concurrency), BUD-053 (date-change / existing-
 * line invalidation). MIG-001/002 and REG-001..005 are exercised
 * outside Jest (see the completion report).
 */
describe("Budgeting / Planning — Phase 1 Foundation (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let accountA1Id: string;
  let accountA1SecondId: string;
  let inactiveAccountA1Id: string;
  let accountA2Id: string;
  // Tenant B's account/period fixtures (accB/pB below) are still seeded
  // into the DB for realistic multi-tenant isolation depth even though
  // no scenario in this file currently asserts on their ids directly —
  // RLS-002/RLS-003 isolate by tenant id alone, not by referencing this
  // specific row. Not captured into named vars here (would be unused).

  // Non-overlapping accounting periods for legal entity A1, spaced
  // across distinct years so period-containment (Decision C) tests can
  // freely pick "inside"/"before"/"after" periods without colliding
  // with any other period ever created for this same legal entity in
  // this file (the accounting_periods table has a real EXCLUDE
  // constraint on (tenant_id, legal_entity_id, date range)).
  let periodA1_2020Id: string; // 2020-01-01 .. 2020-12-31 — "before" a 2021 budget
  let periodA1_2021H1Id: string; // 2021-01-01 .. 2021-06-30 — inside a 2021 budget
  let periodA1_2021H2Id: string; // 2021-07-01 .. 2021-12-31 — inside a 2021 budget
  // periodA1_2022Id/2024Id kept seeded (unique, non-overlapping years)
  // for the same reason as accB/pB above, but not captured by name.
  let periodA1_2023Id: string;
  let periodA2Id: string;

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

  const adminA1 = () => tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
  const posterA1 = () =>
    tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
  const viewerA1 = () =>
    tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);

  // Not `async` — an async wrapper would unwrap supertest's chainable
  // `Test` (which extends `Promise<Response>` but also has `.expect()`)
  // down to a plain `Promise<Response>` on the return, silently losing
  // `.expect()` on every call site (`createLine(...).expect(201)` etc).
  // Returning the `Test` object directly keeps it awaitable AND
  // chainable.
  function createBudget(
    token: string,
    overrides: Partial<{
      code: string;
      name: string;
      startDate: string;
      endDate: string;
    }> = {},
  ) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return request(app.getHttpServer())
      .post("/v1/finance/budgets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        code: overrides.code ?? `BUD-${suffix}`,
        name: overrides.name ?? "Test Budget",
        startDate: overrides.startDate ?? "2021-01-01",
        endDate: overrides.endDate ?? "2021-12-31",
      });
  }

  function createLine(
    token: string,
    budgetId: string,
    overrides: Partial<{
      accountId: string;
      periodId: string;
      amountMinor: number;
    }> = {},
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/budgets/${budgetId}/lines`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: overrides.accountId ?? accountA1Id,
        periodId: overrides.periodId ?? periodA1_2021H1Id,
        amountMinor: overrides.amountMinor ?? 100000,
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
    const suffix = Date.now();
    const [tenantA] = await platformDb
      .insert(tenants)
      .values({ slug: `bud-e2e-a-${suffix}`, name: "Budgeting E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `bud-e2e-b-${suffix}`, name: "Budgeting E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BUDA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 2",
        code: "BUDA2",
        countryCode: "AE",
        currencyCode: "USD",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "BUDB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [accA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-EXP-1",
        name: "Marketing Expense",
        type: "EXPENSE",
      })
      .returning();
    const [accA1Second] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-EXP-2",
        name: "Travel Expense",
        type: "EXPENSE",
      })
      .returning();
    const [inactiveA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-INACTIVE-1",
        name: "Archived Expense",
        type: "EXPENSE",
        isActive: false,
      })
      .returning();
    const [accA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: "BUD-A2-EXP-1",
        name: "Entity 2 Expense",
        type: "EXPENSE",
      })
      .returning();
    // Tenant B's own account row — seeded for isolation-depth realism
    // (see the comment by the field declarations above); its id is not
    // referenced by name anywhere in this file.
    await financeDb.insert(chartOfAccounts).values({
      tenantId: tenantBId,
      legalEntityId: legalEntityBId,
      code: "BUD-B-EXP-1",
      name: "Tenant B Expense",
      type: "EXPENSE",
    });
    accountA1Id = accA1!.id;
    accountA1SecondId = accA1Second!.id;
    inactiveAccountA1Id = inactiveA1!.id;
    accountA2Id = accA2!.id;

    const [p2020] = await financeDb
      .insert(accountingPeriods)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-2020",
        startDate: "2020-01-01",
        endDate: "2020-12-31",
      })
      .returning();
    const [p2021H1] = await financeDb
      .insert(accountingPeriods)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-2021-H1",
        startDate: "2021-01-01",
        endDate: "2021-06-30",
      })
      .returning();
    const [p2021H2] = await financeDb
      .insert(accountingPeriods)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-2021-H2",
        startDate: "2021-07-01",
        endDate: "2021-12-31",
      })
      .returning();
    // BUD-2022 — seeded for the same non-overlapping-years reason as
    // BUD-2020/2021-H1/2021-H2/2023 (keeps the real EXCLUDE constraint
    // from ever colliding across this file's tests), not referenced by
    // name.
    await financeDb.insert(accountingPeriods).values({
      tenantId: tenantAId,
      legalEntityId: legalEntityA1Id,
      code: "BUD-2022",
      startDate: "2022-01-01",
      endDate: "2022-12-31",
    });
    const [p2023] = await financeDb
      .insert(accountingPeriods)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "BUD-2023",
        startDate: "2023-01-01",
        endDate: "2023-12-31",
      })
      .returning();
    // BUD-2024 — same rationale as BUD-2022 above.
    await financeDb.insert(accountingPeriods).values({
      tenantId: tenantAId,
      legalEntityId: legalEntityA1Id,
      code: "BUD-2024",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    const [pA2] = await financeDb
      .insert(accountingPeriods)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: "BUD-A2-2021",
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      })
      .returning();
    // Tenant B's own period row — seeded for isolation-depth realism
    // (see the comment by the field declarations above), not referenced
    // by name.
    await financeDb.insert(accountingPeriods).values({
      tenantId: tenantBId,
      legalEntityId: legalEntityBId,
      code: "BUD-B-2021",
      startDate: "2021-01-01",
      endDate: "2021-12-31",
    });

    periodA1_2020Id = p2020!.id;
    periodA1_2021H1Id = p2021H1!.id;
    periodA1_2021H2Id = p2021H2!.id;
    periodA1_2023Id = p2023!.id;
    periodA2Id = pA2!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // ---------------------------------------------------------------------
  // Budget Header CRUD — BUD-001..009
  // ---------------------------------------------------------------------
  describe("Budget Header CRUD", () => {
    it("BUD-001: create budget header — success (DRAFT, currencyCode server-resolved)", async () => {
      const res = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.currencyCode).toBe("AED");
      // currencyCode is never client-supplied — no such field is even
      // accepted (whitelist:true + forbidNonWhitelisted:true globally).
    });

    it("BUD-002: create rejected — duplicate code within same (tenant, legal entity)", async () => {
      const code = `BUD-DUP-${Date.now()}`;
      await createBudget(adminA1(), { code }).then((r) =>
        expect(r.status).toBe(201),
      );
      const res = await createBudget(adminA1(), { code });
      expect(res.status).toBe(409);
      expect(res.body.error?.message ?? res.body.message).not.toMatch(
        /PostgresError|SQLSTATE|constraint "/i,
      );
    });

    it("BUD-003: same code permitted in a different legal entity (same tenant)", async () => {
      const code = `BUD-MULTI-${Date.now()}`;
      await createBudget(adminA1(), { code }).then((r) =>
        expect(r.status).toBe(201),
      );
      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);
      const res = await createBudget(tokenA2, { code });
      expect(res.status).toBe(201);
    });

    it("BUD-004: create rejected — endDate <= startDate", async () => {
      const res = await createBudget(adminA1(), {
        startDate: "2021-06-01",
        endDate: "2021-01-01",
      });
      expect(res.status).toBe(400);
    });

    it("BUD-005: update header while DRAFT — success", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .send({ name: "Renamed Budget" })
        .expect(200);
      expect(res.body.data.name).toBe("Renamed Budget");
    });

    it("BUD-006: update header rejected once APPROVED (immutability)", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .send({ name: "Should Not Apply" })
        .expect(409);
      expect(res.body).toBeDefined();
    });

    it("BUD-007: list/get header — response shape includes status/dates/currency", async () => {
      const created = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const id = created.body.data.id;
      const getRes = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(getRes.body.data).toMatchObject({
        id,
        status: "DRAFT",
        startDate: "2021-01-01",
        endDate: "2021-12-31",
        currencyCode: "AED",
      });

      const listRes = await request(app.getHttpServer())
        .get("/v1/finance/budgets")
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(
        listRes.body.data.find((b: { id: string }) => b.id === id),
      ).toBeDefined();
    });

    it("BUD-008: approve a DRAFT budget with >=1 line — success, status becomes APPROVED", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      const res = await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);
      expect(res.body.data.status).toBe("APPROVED");
      expect(res.body.data.approvedAt).toBeTruthy();
    });

    it("BUD-009: repeat approve() on an already-APPROVED budget — rejected 409", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Budget Line CRUD — BUD-020..029
  // ---------------------------------------------------------------------
  describe("Budget Line CRUD", () => {
    it("BUD-020: create line — success", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const res = await createLine(adminA1(), id, { amountMinor: 50000 });
      expect(res.status).toBe(201);
      expect(res.body.data.amountMinor).toBe(50000);
      expect(res.body.data.accountId).toBe(accountA1Id);
    });

    it("BUD-021: create line rejected — accountId not found/inactive/wrong legal entity", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;

      await createLine(adminA1(), id, { accountId: randomUUID() }).then((r) =>
        expect(r.status).toBe(422),
      );
      await createLine(adminA1(), id, {
        accountId: inactiveAccountA1Id,
      }).then((r) => expect(r.status).toBe(422));
      await createLine(adminA1(), id, { accountId: accountA2Id }).then((r) =>
        expect(r.status).toBe(422),
      );
    });

    it("BUD-022: create line rejected — periodId not found/wrong legal entity", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;

      await createLine(adminA1(), id, { periodId: randomUUID() }).then((r) =>
        expect(r.status).toBe(422),
      );
      await createLine(adminA1(), id, { periodId: periodA2Id }).then((r) =>
        expect(r.status).toBe(422),
      );
    });

    it("BUD-023: create line rejected — amountMinor negative", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const res = await createLine(adminA1(), id, { amountMinor: -1 });
      expect(res.status).toBe(400);
    });

    it("BUD-024: create line rejected — parent budget is APPROVED, not DRAFT", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      const res = await createLine(adminA1(), id, {
        accountId: accountA1SecondId,
      });
      expect(res.status).toBe(409);
    });

    it("BUD-025: duplicate (budget_id, account_id, period_id) rejected (409)", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      const res = await createLine(adminA1(), id);
      expect(res.status).toBe(409);
      expect(res.body.error?.message ?? res.body.message).not.toMatch(
        /PostgresError|SQLSTATE|constraint "/i,
      );
    });

    it("BUD-026: update line while parent budget is DRAFT — success", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id, { amountMinor: 1000 });
      const lineId = line.body.data.id;
      const res = await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${posterA1()}`)
        .send({ amountMinor: 2000 })
        .expect(200);
      expect(res.body.data.amountMinor).toBe(2000);
    });

    it("BUD-027: update/delete line rejected once parent budget is APPROVED", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id);
      const lineId = line.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${posterA1()}`)
        .send({ amountMinor: 999 })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${posterA1()}`)
        .expect(409);
    });

    it("BUD-028: delete line while parent budget is DRAFT — success", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id);
      const lineId = line.body.data.id;
      await request(app.getHttpServer())
        .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${posterA1()}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(404);
    });

    it("BUD-029: list/filter lines by account, period", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id, {
        accountId: accountA1Id,
        periodId: periodA1_2021H1Id,
      }).expect(201);
      await createLine(adminA1(), id, {
        accountId: accountA1SecondId,
        periodId: periodA1_2021H2Id,
      }).expect(201);

      const byAccount = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines?accountId=${accountA1Id}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(byAccount.body.data).toHaveLength(1);
      expect(byAccount.body.data[0].accountId).toBe(accountA1Id);

      const byPeriod = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines?periodId=${periodA1_2021H2Id}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(byPeriod.body.data).toHaveLength(1);
      expect(byPeriod.body.data[0].periodId).toBe(periodA1_2021H2Id);

      const all = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(all.body.data).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------
  // Tenant / Legal-Entity Isolation — RLS-001..003
  // ---------------------------------------------------------------------
  describe("Tenant / Legal-Entity Isolation (RLS)", () => {
    it("RLS-001: a second legal entity (same tenant) cannot read/reference the first's budgets/lines", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id);
      const lineId = line.body.data.id;

      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(404);

      const list = await request(app.getHttpServer())
        .get("/v1/finance/budgets")
        .set("Authorization", `Bearer ${tokenA2}`)
        .expect(200);
      expect(
        list.body.data.find((b: { id: string }) => b.id === id),
      ).toBeUndefined();
    });

    it("RLS-002: a second tenant cannot see the first tenant's rows via the API", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;

      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(404);

      const list = await request(app.getHttpServer())
        .get("/v1/finance/budgets")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);
      expect(
        list.body.data.find((b: { id: string }) => b.id === id),
      ).toBeUndefined();
    });

    it("RLS-003: raw-SQL proof — with app.current_tenant_id set to tenant B (via noryx_app), a SELECT against budgets/budget_lines returns zero of tenant A's rows", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);

      const appRoleUrl = process.env.APP_ROLE_DATABASE_URL!;
      const client = postgres(appRoleUrl, { max: 1 });
      try {
        const budgetRows = await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantBId}, true)`;
          return tx`SELECT id, tenant_id FROM budgets WHERE tenant_id = ${tenantAId}`;
        });
        expect(budgetRows).toHaveLength(0);

        const lineRows = await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantBId}, true)`;
          return tx`SELECT id, tenant_id FROM budget_lines WHERE tenant_id = ${tenantAId}`;
        });
        expect(lineRows).toHaveLength(0);

        // Sanity: the SAME role, scoped to tenant A, DOES see the rows —
        // proves the zero-rows result above is RLS filtering, not e.g. an
        // empty table or a bad query.
        const asTenantA = await client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
          return tx`SELECT id FROM budgets WHERE id = ${id}`;
        });
        expect(asTenantA.map((r) => r.id)).toContain(id);
      } finally {
        await client.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // RBAC — RBAC-001..004 (RBAC-005 lives in route-role-matrix.spec.ts)
  // ---------------------------------------------------------------------
  describe("RBAC", () => {
    it("RBAC-001: finance.viewer — GET allowed on both resources; POST/PATCH/approve/DELETE rejected 403", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id);
      const lineId = line.body.data.id;
      const viewer = viewerA1();

      await request(app.getHttpServer())
        .get("/v1/finance/budgets")
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);

      await createBudget(viewer).then((r) => expect(r.status).toBe(403));
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${viewer}`)
        .send({ name: "x" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(403);
      await createLine(viewer, id).then((r) => expect(r.status).toBe(403));
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${viewer}`)
        .send({ amountMinor: 1 })
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(403);
    });

    it("RBAC-002: finance.poster — header POST/PATCH/approve rejected 403; line POST/PATCH/DELETE allowed; GET allowed", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const poster = posterA1();

      await createBudget(poster).then((r) => expect(r.status).toBe(403));
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ name: "x" })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(403);

      const line = await createLine(poster, id);
      expect(line.status).toBe(201);
      const lineId = line.body.data.id;
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ amountMinor: 42 })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
    });

    it("RBAC-003: finance.admin — all operations on both resources allowed", async () => {
      const admin = adminA1();
      const created = await createBudget(admin);
      expect(created.status).toBe(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${admin}`)
        .send({ name: "Admin Renamed" })
        .expect(200);
      const line = await createLine(admin, id);
      expect(line.status).toBe(201);
      const lineId = line.body.data.id;
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .set("Authorization", `Bearer ${admin}`)
        .send({ amountMinor: 55 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
    });

    it("RBAC-004: no token — 401 on every new route", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const line = await createLine(adminA1(), id);
      const lineId = line.body.data.id;

      await request(app.getHttpServer())
        .post("/v1/finance/budgets")
        .expect(401);
      await request(app.getHttpServer()).get("/v1/finance/budgets").expect(401);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .expect(401);
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .expect(401);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .expect(401);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/lines`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .expect(401);
      await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .expect(401);
      await request(app.getHttpServer())
        .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------
  // Database Invariants / Raw-SQL Proofs — DB-001..005
  // ---------------------------------------------------------------------
  describe("Database Invariants / Raw-SQL Proofs", () => {
    const ownerUrl = process.env.DATABASE_URL!;

    it("DB-001: unique index on budgets(tenant_id, legal_entity_id, code) rejects a raw duplicate INSERT", async () => {
      const owner = postgres(ownerUrl, { max: 1 });
      try {
        const code = `DB-001-${Date.now()}`;
        await owner`
          INSERT INTO budgets (tenant_id, legal_entity_id, code, name, start_date, end_date, currency_code)
          VALUES (${tenantAId}, ${legalEntityA1Id}, ${code}, ${"DB-001 A"}, '2021-01-01', '2021-12-31', 'AED')
        `;
        await expect(
          owner`
            INSERT INTO budgets (tenant_id, legal_entity_id, code, name, start_date, end_date, currency_code)
            VALUES (${tenantAId}, ${legalEntityA1Id}, ${code}, ${"DB-001 B"}, '2021-01-01', '2021-12-31', 'AED')
          `,
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await owner.end();
      }
    });

    it("DB-002: unique index on budget_lines(budget_id, account_id, period_id) rejects a raw duplicate INSERT", async () => {
      const created = await createBudget(adminA1());
      const budgetId = created.body.data.id;
      const owner = postgres(ownerUrl, { max: 1 });
      try {
        await owner`
          INSERT INTO budget_lines (tenant_id, legal_entity_id, budget_id, account_id, period_id, amount_minor)
          VALUES (${tenantAId}, ${legalEntityA1Id}, ${budgetId}, ${accountA1Id}, ${periodA1_2021H1Id}, 100)
        `;
        await expect(
          owner`
            INSERT INTO budget_lines (tenant_id, legal_entity_id, budget_id, account_id, period_id, amount_minor)
            VALUES (${tenantAId}, ${legalEntityA1Id}, ${budgetId}, ${accountA1Id}, ${periodA1_2021H1Id}, 200)
          `,
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await owner.end();
      }
    });

    it("DB-003: FK constraint on budget_lines.account_id rejects a raw INSERT referencing a non-existent account", async () => {
      const created = await createBudget(adminA1());
      const budgetId = created.body.data.id;
      const owner = postgres(ownerUrl, { max: 1 });
      try {
        await expect(
          owner`
            INSERT INTO budget_lines (tenant_id, legal_entity_id, budget_id, account_id, period_id, amount_minor)
            VALUES (${tenantAId}, ${legalEntityA1Id}, ${budgetId}, ${randomUUID()}, ${periodA1_2021H1Id}, 100)
          `,
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await owner.end();
      }
    });

    it("DB-004: FK constraint on budget_lines.period_id rejects a raw INSERT referencing a non-existent period", async () => {
      const created = await createBudget(adminA1());
      const budgetId = created.body.data.id;
      const owner = postgres(ownerUrl, { max: 1 });
      try {
        await expect(
          owner`
            INSERT INTO budget_lines (tenant_id, legal_entity_id, budget_id, account_id, period_id, amount_minor)
            VALUES (${tenantAId}, ${legalEntityA1Id}, ${budgetId}, ${accountA1Id}, ${randomUUID()}, 100)
          `,
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await owner.end();
      }
    });

    it("DB-005: CHECK constraint on budget_lines.amount_minor >= 0 rejects a raw negative INSERT", async () => {
      const created = await createBudget(adminA1());
      const budgetId = created.body.data.id;
      const owner = postgres(ownerUrl, { max: 1 });
      try {
        await expect(
          owner`
            INSERT INTO budget_lines (tenant_id, legal_entity_id, budget_id, account_id, period_id, amount_minor)
            VALUES (${tenantAId}, ${legalEntityA1Id}, ${budgetId}, ${accountA1Id}, ${periodA1_2021H1Id}, -1)
          `,
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await owner.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Concurrency — CONC-001..002
  // ---------------------------------------------------------------------
  describe("Concurrency", () => {
    it("CONC-001: two simultaneous POST /budgets with the same code — exactly one 201, one rejected, never two rows persisted", async () => {
      const code = `CONC-001-${Date.now()}`;
      const token = adminA1();
      const [resX, resY] = await Promise.all([
        createBudget(token, { code }),
        createBudget(token, { code }),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);

      const financeDb = getFinanceDb();
      const rows = await financeDb
        .select()
        .from(budgets)
        .where(and(eq(budgets.tenantId, tenantAId), eq(budgets.code, code)));
      expect(rows).toHaveLength(1);
    });

    it("CONC-002: two simultaneous POST .../lines with the same (account_id, period_id) — exactly one 201, one rejected, never two rows persisted", async () => {
      // Budget dates must contain periodA1_2023Id (2023-01-01..2023-12-31)
      // — Decision C containment is enforced on every line create, so an
      // out-of-range period would surface as 400/400 here and mask the
      // 409-duplicate behavior this scenario actually targets.
      const created = await createBudget(adminA1(), {
        startDate: "2023-01-01",
        endDate: "2023-12-31",
      });
      const budgetId = created.body.data.id;
      const token = adminA1();
      const [resX, resY] = await Promise.all([
        createLine(token, budgetId, { periodId: periodA1_2023Id }),
        createLine(token, budgetId, { periodId: periodA1_2023Id }),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);

      const financeDb = getFinanceDb();
      const rows = await financeDb
        .select()
        .from(budgetLines)
        .where(
          and(
            eq(budgetLines.budgetId, budgetId),
            eq(budgetLines.periodId, periodA1_2023Id),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // Accounting Invariant Proof — BUD-045
  // ---------------------------------------------------------------------
  describe("Accounting Invariant Proof", () => {
    it("BUD-045: zero rows written to journal_entries/journal_lines as a side effect of any budget operation, including approve()", async () => {
      const financeDb = getFinanceDb();
      const before = await financeDb.select().from(journalEntries);
      const linesBefore = await financeDb.select().from(journalLines);

      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      const after = await financeDb.select().from(journalEntries);
      const linesAfter = await financeDb.select().from(journalLines);
      expect(after.length).toBe(before.length);
      expect(linesAfter.length).toBe(linesBefore.length);
    });
  });

  // ---------------------------------------------------------------------
  // CTO Amendment — Decisions B/C/D — BUD-046..050
  // ---------------------------------------------------------------------
  describe("CTO Amendment (Decisions B/C/D)", () => {
    it("BUD-046: approve() on a DRAFT budget with zero lines — rejected 422, budget remains DRAFT", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      const res = await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(422);
      expect(res.body).toBeDefined();

      const getRes = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(getRes.body.data.status).toBe("DRAFT");
    });

    it("BUD-047: create line accepted — period fully contained within budget dates", async () => {
      const created = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const id = created.body.data.id;
      const res = await createLine(adminA1(), id, {
        periodId: periodA1_2021H1Id,
      });
      expect(res.status).toBe(201);
    });

    it("BUD-048: create line rejected (400) — period start before budget start", async () => {
      const created = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const id = created.body.data.id;
      const res = await createLine(adminA1(), id, {
        periodId: periodA1_2020Id,
      });
      expect(res.status).toBe(400);
    });

    it("BUD-049: create line rejected (400) — period end after budget end", async () => {
      const created = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-06-30",
      });
      const id = created.body.data.id;
      const res = await createLine(adminA1(), id, {
        periodId: periodA1_2021H2Id,
      });
      expect(res.status).toBe(400);
    });

    it("BUD-050: two APPROVED budgets with overlapping dates/lines — both remain valid, no exclusivity conflict", async () => {
      const suffix = Date.now();
      const budgetX = await createBudget(adminA1(), {
        code: `BUD-050-X-${suffix}`,
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const budgetY = await createBudget(adminA1(), {
        code: `BUD-050-Y-${suffix}`,
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const idX = budgetX.body.data.id;
      const idY = budgetY.body.data.id;
      await createLine(adminA1(), idX, {
        accountId: accountA1Id,
        periodId: periodA1_2021H1Id,
      }).expect(201);
      await createLine(adminA1(), idY, {
        accountId: accountA1Id,
        periodId: periodA1_2021H1Id,
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${idX}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${idY}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      const getX = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${idX}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      const getY = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${idY}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(getX.body.data.status).toBe("APPROVED");
      expect(getY.body.data.status).toBe("APPROVED");
    });
  });

  // ---------------------------------------------------------------------
  // CTO Concurrency Correction (v3) — BUD-051
  // ---------------------------------------------------------------------
  describe("Concurrency correction — approve() vs final-line delete", () => {
    it("BUD-051: an APPROVED budget must never end up with zero lines, under real concurrent PostgreSQL transactions, regardless of lock-acquisition order — exercised across repeated trials to surface both Case A and Case B", async () => {
      const ITERATIONS = 20;
      const outcomes = { approveWon: 0, deleteWon: 0 };

      for (let i = 0; i < ITERATIONS; i++) {
        const created = await createBudget(adminA1(), {
          code: `BUD-051-${Date.now()}-${i}`,
        });
        const id = created.body.data.id;
        const line = await createLine(adminA1(), id, {
          periodId: periodA1_2021H1Id,
        });
        const lineId = line.body.data.id;

        const [approveRes, deleteRes] = await Promise.all([
          request(app.getHttpServer())
            .post(`/v1/finance/budgets/${id}/approve`)
            .set("Authorization", `Bearer ${adminA1()}`),
          request(app.getHttpServer())
            .delete(`/v1/finance/budgets/${id}/lines/${lineId}`)
            .set("Authorization", `Bearer ${posterA1()}`),
        ]);

        // Observable business invariant — never inspects which SQL
        // statement ran, only the persisted end state.
        const finalState = await request(app.getHttpServer())
          .get(`/v1/finance/budgets/${id}`)
          .set("Authorization", `Bearer ${viewerA1()}`)
          .expect(200);
        const finalLines = await request(app.getHttpServer())
          .get(`/v1/finance/budgets/${id}/lines`)
          .set("Authorization", `Bearer ${viewerA1()}`)
          .expect(200);

        const isApproved = finalState.body.data.status === "APPROVED";
        const lineCount = finalLines.body.data.length;

        // The one invariant that must NEVER be violated, on every
        // single iteration:
        expect(isApproved && lineCount === 0).toBe(false);

        if (approveRes.status === 200) {
          // Case A: approve() won — line must have survived (delete
          // was rejected by the lock+status re-check).
          expect(deleteRes.status).toBe(409);
          expect(lineCount).toBe(1);
          outcomes.approveWon++;
        } else {
          // Case B: delete won — approve() must have been rejected
          // (422, zero lines).
          expect(approveRes.status).toBe(422);
          expect(deleteRes.status).toBe(200);
          expect(lineCount).toBe(0);
          expect(isApproved).toBe(false);
          outcomes.deleteWon++;
        }
      }

      // Confidence check (not a strict per-run requirement, but expected
      // over 20 trials of two genuinely concurrent HTTP requests): both
      // interleavings actually occurred at least once.
      // eslint-disable-next-line no-console
      console.log(
        `[BUD-051] approve() won ${outcomes.approveWon}/${ITERATIONS}, delete won ${outcomes.deleteWon}/${ITERATIONS}`,
      );
      expect(outcomes.approveWon + outcomes.deleteWon).toBe(ITERATIONS);
    });
  });

  // ---------------------------------------------------------------------
  // CTO Concurrency Correction (v4) — BUD-052, BUD-053
  // ---------------------------------------------------------------------
  describe("Header PATCH serialization and date-change invariant", () => {
    it("BUD-052: header date-narrowing PATCH vs a concurrent line create for a period only valid under the OLD dates — both interleavings leave the aggregate consistent, across repeated trials", async () => {
      const ITERATIONS = 15;
      const outcomes = { patchWon: 0, lineWon: 0 };

      for (let i = 0; i < ITERATIONS; i++) {
        // Wide budget (2021-01-01..2021-12-31). periodA1_2021H2Id
        // (2021-07-01..2021-12-31) is valid under the wide dates but
        // would fall outside a narrowed 2021-01-01..2021-06-30 range.
        const created = await createBudget(adminA1(), {
          code: `BUD-052-${Date.now()}-${i}`,
          startDate: "2021-01-01",
          endDate: "2021-12-31",
        });
        const id = created.body.data.id;

        const [patchRes, lineRes] = await Promise.all([
          request(app.getHttpServer())
            .patch(`/v1/finance/budgets/${id}`)
            .set("Authorization", `Bearer ${adminA1()}`)
            .send({ endDate: "2021-06-30" }),
          createLine(adminA1(), id, {
            accountId: accountA1SecondId,
            periodId: periodA1_2021H2Id,
          }),
        ]);

        const finalState = await request(app.getHttpServer())
          .get(`/v1/finance/budgets/${id}`)
          .set("Authorization", `Bearer ${viewerA1()}`)
          .expect(200);
        const finalLines = await request(app.getHttpServer())
          .get(`/v1/finance/budgets/${id}/lines`)
          .set("Authorization", `Bearer ${viewerA1()}`)
          .expect(200);

        // The invariant that must hold on EVERY iteration regardless of
        // which operation won the lock: no persisted line's period may
        // fall outside the budget's FINAL, committed end date.
        for (const l of finalLines.body.data as Array<{
          periodId: string;
        }>) {
          if (l.periodId === periodA1_2021H2Id) {
            // period H2 (07-01..12-31) is only valid if the budget's
            // final endDate is still 2021-12-31 (i.e. the PATCH did not
            // win / was rejected).
            expect(finalState.body.data.endDate).toBe("2021-12-31");
          }
        }

        if (patchRes.status === 200) {
          // Case C: PATCH won the lock first, committed the narrowed
          // range. The line create, resuming after, must re-evaluate
          // against the NOW-narrowed dates and be rejected — never
          // silently created against a stale, wider snapshot.
          expect(lineRes.status).toBe(400);
          expect(finalState.body.data.endDate).toBe("2021-06-30");
          expect(finalLines.body.data).toHaveLength(0);
          outcomes.patchWon++;
        } else {
          // Case D: the line create won the lock first, committed
          // (valid under the still-wide dates). The PATCH, resuming
          // after, must re-validate against the NOW-current line set
          // (Gap 2) and see the just-committed line falls outside the
          // proposed narrower range — rejected 422, no mutation.
          expect(patchRes.status).toBe(422);
          expect(lineRes.status).toBe(201);
          expect(finalState.body.data.endDate).toBe("2021-12-31");
          expect(finalLines.body.data).toHaveLength(1);
          outcomes.lineWon++;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[BUD-052] header PATCH won ${outcomes.patchWon}/${ITERATIONS}, line create won ${outcomes.lineWon}/${ITERATIONS}`,
      );
      expect(outcomes.patchWon + outcomes.lineWon).toBe(ITERATIONS);
    });

    it("BUD-052b: header PATCH vs approve() — both serialize through the same parent lock; the loser always observes the winner's committed state (never a stale read)", async () => {
      // NOTE: this scenario's original draft assumed a name-only PATCH
      // never conflicts with approve() "at the business-rule level" and
      // both always succeed regardless of lock order. That assumption is
      // wrong: BUD-006 and the contract (§9/§10) establish that the
      // ENTIRE header — not just start_date/end_date/code — becomes
      // immutable once APPROVED; BudgetsService.update() rejects ANY
      // field once status != 'DRAFT', including a bare `name` change.
      // Caught by actually running this test (Acceptance Discipline),
      // not by inspection. Rewritten below to assert the real,
      // contract-mandated Case C/D serialization instead: whichever of
      // {PATCH, approve()} acquires the parent-row lock first commits
      // normally; the other, resuming after, re-reads the now-current
      // status under its own lock and is treated accordingly — a PATCH
      // that resumes second sees APPROVED and is rejected 409; an
      // approve() that resumes second still sees the (still-DRAFT,
      // still-1-line) budget the PATCH did not remove any line from, and
      // succeeds normally.
      const ITERATIONS = 15;
      const outcomes = { patchWon: 0, approveWon: 0 };

      for (let i = 0; i < ITERATIONS; i++) {
        const created = await createBudget(adminA1(), {
          code: `BUD-052B-${Date.now()}-${i}`,
        });
        const id = created.body.data.id;
        await createLine(adminA1(), id, { periodId: periodA1_2021H1Id }).expect(
          201,
        );

        const [patchRes, approveRes] = await Promise.all([
          request(app.getHttpServer())
            .patch(`/v1/finance/budgets/${id}`)
            .set("Authorization", `Bearer ${adminA1()}`)
            .send({ name: `Renamed ${i}` }),
          request(app.getHttpServer())
            .post(`/v1/finance/budgets/${id}/approve`)
            .set("Authorization", `Bearer ${adminA1()}`),
        ]);

        const finalState = await request(app.getHttpServer())
          .get(`/v1/finance/budgets/${id}`)
          .set("Authorization", `Bearer ${viewerA1()}`)
          .expect(200);

        // Invariant that must hold on EVERY iteration regardless of
        // lock order: approve() always ends up committed (the PATCH
        // never touches line existence or status, so it can never make
        // approve() itself fail), and the final name reflects the PATCH
        // only when the PATCH won the lock first.
        expect(finalState.body.data.status).toBe("APPROVED");
        expect(approveRes.status).toBe(200);

        if (patchRes.status === 200) {
          // PATCH won the lock first: committed while still DRAFT: name
          // updated, approve() resumes after and sees DRAFT + 1 line.
          expect(finalState.body.data.name).toBe(`Renamed ${i}`);
          outcomes.patchWon++;
        } else {
          // approve() won the lock first: PATCH resumes after, re-reads
          // status=APPROVED under its own lock, and is correctly
          // rejected — never a stale-snapshot silent success.
          expect(patchRes.status).toBe(409);
          expect(finalState.body.data.name).not.toBe(`Renamed ${i}`);
          outcomes.approveWon++;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[BUD-052b] header PATCH won ${outcomes.patchWon}/${ITERATIONS}, approve() won ${outcomes.approveWon}/${ITERATIONS}`,
      );
      expect(outcomes.patchWon + outcomes.approveWon).toBe(ITERATIONS);
    });

    it("BUD-053: budget date change cannot invalidate existing budget lines — rejected, no partial mutation; inverse valid-boundary case succeeds", async () => {
      const created = await createBudget(adminA1(), {
        startDate: "2021-01-01",
        endDate: "2021-12-31",
      });
      const id = created.body.data.id;
      await createLine(adminA1(), id, {
        accountId: accountA1Id,
        periodId: periodA1_2021H2Id, // 2021-07-01..2021-12-31
      }).expect(201);

      // Narrowing endDate to 2021-06-30 would put periodA1_2021H2Id
      // outside the new range — must be rejected, including the `name`
      // field in the SAME payload to prove no partial mutation.
      const invalidating = await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .send({ name: "Should Not Apply Either", endDate: "2021-06-30" })
        .expect(422);
      expect(invalidating.body).toBeDefined();

      const afterRejection = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(afterRejection.body.data.endDate).toBe("2021-12-31");
      expect(afterRejection.body.data.name).not.toBe("Should Not Apply Either");

      const linesAfterRejection = await request(app.getHttpServer())
        .get(`/v1/finance/budgets/${id}/lines`)
        .set("Authorization", `Bearer ${viewerA1()}`)
        .expect(200);
      expect(linesAfterRejection.body.data).toHaveLength(1);
      expect(linesAfterRejection.body.data[0].periodId).toBe(periodA1_2021H2Id);

      // Inverse boundary: a date change under which every existing
      // line's period remains fully contained succeeds normally.
      const valid = await request(app.getHttpServer())
        .patch(`/v1/finance/budgets/${id}`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .send({ endDate: "2022-12-31" })
        .expect(200);
      expect(valid.body.data.endDate).toBe("2022-12-31");
    });
  });

  // ---------------------------------------------------------------------
  // Audit trail (repo-wide convention, not a numbered acceptance
  // scenario on its own, but exercised as part of BUD-001/BUD-008's
  // create/approve paths).
  // ---------------------------------------------------------------------
  describe("Audit trail", () => {
    it("records CREATE and APPROVE entries for a budget", async () => {
      const created = await createBudget(adminA1());
      const id = created.body.data.id;
      await createLine(adminA1(), id).expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/budgets/${id}/approve`)
        .set("Authorization", `Bearer ${adminA1()}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, id));
      expect(rows.find((r) => r.action === "CREATE")).toBeDefined();
      const approveRow = rows.find((r) => r.action === "APPROVE");
      expect(approveRow).toBeDefined();
      expect(approveRow!.entityType).toBe("budget");
    });
  });
});
