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
  eq,
  and,
} from "@noryx/db-core";
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Tax/VAT Phase 6 — Manual Journal Tax Coverage.
 * docs/finance-work-item-tax-vat-phase-6-manual-journal-tax-coverage-proposal.md,
 * CTO-approved implementation authorization.
 *
 * API-layer and VAT-report-layer coverage — the JTX acceptance matrix's
 * DTO-validation cases live in create-journal-line.dto.spec.ts (unit),
 * and its DB-constraint/immutability cases live in
 * journal-engine-db-constraints.e2e-spec.ts (raw SQL). This file proves
 * end-to-end behavior through the real HTTP API: create/post/reverse
 * with tax classification, post-time re-validation, VAT Position Report
 * headline integration (CTO authorization §8.7), tenant/legal-entity
 * isolation, RBAC, and reversal-nets-to-zero.
 *
 * Every account, tax code/rate, and journal entry used here is created
 * and posted through the real HTTP API, never inserted directly — same
 * discipline every other Finance e2e suite in this codebase follows.
 */
describe("Tax/VAT Phase 6 — Manual Journal Tax Coverage (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let assetAccountA1Id: string;
  let revenueAccountA1Id: string;
  let expenseAccountA1Id: string;
  let taxOutputAccountA1Id: string;
  let taxInputAccountA1Id: string;
  let openPeriodA1Id: string;

  let taxCodeStandardId: string;
  let taxCodeSecondId: string;
  let inactiveTaxCodeId: string;
  let taxCodeA2Id: string; // scoped to legal entity A2, not A1

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

  async function createTaxCode(
    token: string,
    code: string,
    treatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" = "STANDARD",
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/tax-codes")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, name: code, treatment })
      .expect(201);
    return res.body.data.id as string;
  }

  function createJournalEntry(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  function postJournalEntry(token: string, id: string) {
    return request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/post`)
      .set("Authorization", `Bearer ${token}`);
  }

  function reverseJournalEntry(
    token: string,
    id: string,
    body: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/reverse`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  async function createAndPostManualJournal(
    token: string,
    transactionDate: string,
    lines: Array<{
      accountId: string;
      debitMinor: number;
      creditMinor: number;
      taxCodeId?: string;
      taxDirection?: "INPUT" | "OUTPUT";
    }>,
  ): Promise<string> {
    const created = await createJournalEntry(token, {
      transactionDate,
      lines,
    }).expect(201);
    await postJournalEntry(token, created.body.data.id).expect(200);
    return created.body.data.id;
  }

  function vatPosition(token: string, query: Record<string, string>) {
    return request(app.getHttpServer())
      .get("/v1/finance/tax-reports/vat-position")
      .set("Authorization", `Bearer ${token}`)
      .query(query);
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
      .values({ slug: `jtx6-e2e-a-${suffix}`, name: "JTX6 E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `jtx6-e2e-b-${suffix}`, name: "JTX6 E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "JTX6 Tenant A — Entity 1",
        code: "JTX6A1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "JTX6 Tenant A — Entity 2",
        code: "JTX6A2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "JTX6 Tenant B — Entity 1",
        code: "JTX6B1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const adminA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.admin"]);

    assetAccountA1Id = await createAccount(adminA1, {
      code: "JTX6-ASSET",
      name: "Cash",
      type: "ASSET",
    });
    revenueAccountA1Id = await createAccount(adminA1, {
      code: "JTX6-REV",
      name: "Revenue",
      type: "REVENUE",
    });
    expenseAccountA1Id = await createAccount(adminA1, {
      code: "JTX6-EXP",
      name: "Expense",
      type: "EXPENSE",
    });
    taxOutputAccountA1Id = await createAccount(adminA1, {
      code: "JTX6-TAXOUT",
      name: "Tax Output",
      type: "LIABILITY",
    });
    taxInputAccountA1Id = await createAccount(adminA1, {
      code: "JTX6-TAXIN",
      name: "Tax Input",
      type: "ASSET",
    });

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `JTX6P-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = period.body.data.id;

    taxCodeStandardId = await createTaxCode(adminA1, `JTX6-STD-${suffix}`);
    taxCodeSecondId = await createTaxCode(adminA1, `JTX6-SND-${suffix}`);
    inactiveTaxCodeId = await createTaxCode(adminA1, `JTX6-INA-${suffix}`);
    await request(app.getHttpServer())
      .patch(`/v1/finance/tax-codes/${inactiveTaxCodeId}/deactivate`)
      .set("Authorization", `Bearer ${adminA1}`)
      .expect(200);

    taxCodeA2Id = await createTaxCode(adminA2, `JTX6-A2-${suffix}`);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("JTX-001/002/003 — create with valid tax classification", () => {
    it("creates a DRAFT line tagged OUTPUT", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          { accountId: assetAccountA1Id, debitMinor: 100, creditMinor: 0 },
          {
            accountId: taxOutputAccountA1Id,
            debitMinor: 0,
            creditMinor: 100,
            taxCodeId: taxCodeStandardId,
            taxDirection: "OUTPUT",
          },
        ],
      }).expect(201);
      const taggedLine = res.body.data.lines.find(
        (l: { accountId: string }) => l.accountId === taxOutputAccountA1Id,
      );
      expect(taggedLine.taxCodeId).toBe(taxCodeStandardId);
      expect(taggedLine.taxDirection).toBe("OUTPUT");
    });

    it("creates a DRAFT line tagged INPUT", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: taxInputAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: taxCodeStandardId,
            taxDirection: "INPUT",
          },
          { accountId: assetAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(201);
      const taggedLine = res.body.data.lines.find(
        (l: { accountId: string }) => l.accountId === taxInputAccountA1Id,
      );
      expect(taggedLine.taxCodeId).toBe(taxCodeStandardId);
      expect(taggedLine.taxDirection).toBe("INPUT");
    });

    it("creates a DRAFT line with neither field (untagged) — JTX-003", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          { accountId: assetAccountA1Id, debitMinor: 100, creditMinor: 0 },
          { accountId: revenueAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(201);
      for (const l of res.body.data.lines) {
        expect(l.taxCodeId).toBeNull();
        expect(l.taxDirection).toBeNull();
      }
    });
  });

  describe("JTX-006 — invalid tax code rejected at create time (400)", () => {
    it("rejects a taxCodeId that does not exist", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: randomUUID(),
            taxDirection: "INPUT",
          },
          { accountId: revenueAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(400);
    });

    it("rejects an inactive tax code", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: inactiveTaxCodeId,
            taxDirection: "INPUT",
          },
          { accountId: revenueAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(400);
    });

    it("rejects a tax code belonging to a different legal entity — JTX-019 (legal entity isolation)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: taxCodeA2Id,
            taxDirection: "INPUT",
          },
          { accountId: revenueAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(400);
    });
  });

  describe("JTX-018 — tenant isolation", () => {
    it("a tenant B caller cannot reference tenant A's tax code", async () => {
      const tokenB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      // No accounts exist for tenant B in this suite's setup, but the
      // tax-code check runs before/alongside account validation — an
      // account from tenant A supplied by a tenant B caller is already
      // rejected by the pre-existing account check; this asserts the
      // request is rejected end-to-end regardless of which check fires.
      await createJournalEntry(tokenB, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: taxCodeStandardId,
            taxDirection: "INPUT",
          },
          { accountId: assetAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(400);
    });
  });

  describe("JTX-009 — post-time re-validation (422)", () => {
    it("rejects posting a draft whose tax code was deactivated after draft creation", async () => {
      const adminA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const toDeactivateId = await createTaxCode(
        adminA1,
        `JTX6-DEACT-${randomUUID().slice(0, 8)}`,
      );
      const created = await createJournalEntry(poster, {
        transactionDate: "2026-03-01",
        lines: [
          { accountId: assetAccountA1Id, debitMinor: 100, creditMinor: 0 },
          {
            accountId: taxOutputAccountA1Id,
            debitMinor: 0,
            creditMinor: 100,
            taxCodeId: toDeactivateId,
            taxDirection: "OUTPUT",
          },
        ],
      }).expect(201);

      await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${toDeactivateId}/deactivate`)
        .set("Authorization", `Bearer ${adminA1}`)
        .expect(200);

      await postJournalEntry(poster, created.body.data.id).expect(422);
    });
  });

  describe("JTX-011 — reversal retains tax classification", () => {
    it("carries taxCodeId/taxDirection unchanged onto the reversal's corresponding line", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await createAndPostManualJournal(token, "2026-04-01", [
        { accountId: assetAccountA1Id, debitMinor: 100, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 100,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
      ]);
      const reversed = await reverseJournalEntry(token, originalId, {
        transactionDate: "2026-04-02",
      }).expect(201);
      const reversedTaggedLine = reversed.body.data.lines.find(
        (l: { accountId: string }) => l.accountId === taxOutputAccountA1Id,
      );
      expect(reversedTaggedLine.taxCodeId).toBe(taxCodeStandardId);
      expect(reversedTaggedLine.taxDirection).toBe("OUTPUT");
      // Debit/credit swapped (reversal), tax classification not.
      expect(reversedTaggedLine.debitMinor).toBe(100);
      expect(reversedTaggedLine.creditMinor).toBe(0);
    });
  });

  describe("JTX-012/013 — manual tax contributes to the correct VAT headline side", () => {
    it("a manual OUTPUT-tagged line increases outputTaxMinor by its own amount and leaves inputTaxMinor unchanged", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      }).expect(200);

      await createAndPostManualJournal(token, "2026-05-10", [
        { accountId: expenseAccountA1Id, debitMinor: 250, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 250,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
      ]);

      const after = await vatPosition(token, {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      }).expect(200);

      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor + 250,
      );
      expect(after.body.meta.manualOutputTaxMinor).toBe(
        before.body.meta.manualOutputTaxMinor + 250,
      );
      expect(after.body.meta.inputTaxMinor).toBe(
        before.body.meta.inputTaxMinor,
      );

      const row = after.body.data.outputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeStandardId,
      );
      expect(row.manualTaxMinor).toBeGreaterThanOrEqual(250);
    });

    it("a manual INPUT-tagged line increases inputTaxMinor by its own amount and leaves outputTaxMinor unchanged", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      }).expect(200);

      await createAndPostManualJournal(token, "2026-06-10", [
        {
          accountId: taxInputAccountA1Id,
          debitMinor: 175,
          creditMinor: 0,
          taxCodeId: taxCodeStandardId,
          taxDirection: "INPUT",
        },
        { accountId: expenseAccountA1Id, debitMinor: 0, creditMinor: 175 },
      ]);

      const after = await vatPosition(token, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      }).expect(200);

      expect(after.body.meta.inputTaxMinor).toBe(
        before.body.meta.inputTaxMinor + 175,
      );
      expect(after.body.meta.manualInputTaxMinor).toBe(
        before.body.meta.manualInputTaxMinor + 175,
      );
      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor,
      );
    });
  });

  describe("JTX — reversal of a tax-tagged manual entry nets to zero in the VAT report", () => {
    it("original + reversal together contribute exactly zero net manual tax", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
      }).expect(200);

      const originalId = await createAndPostManualJournal(token, "2026-07-05", [
        { accountId: expenseAccountA1Id, debitMinor: 400, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 400,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
      ]);
      await reverseJournalEntry(token, originalId, {
        transactionDate: "2026-07-06",
      }).expect(201);

      const after = await vatPosition(token, {
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
      }).expect(200);

      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor,
      );
      expect(after.body.meta.manualOutputTaxMinor).toBe(
        before.body.meta.manualOutputTaxMinor,
      );
    });
  });

  describe("JTX-016 — manual tax does not double-count AP/AR tax (independent sources)", () => {
    it("a legal entity with only manual tax activity shows zero unclassified AP/AR tax", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await createAndPostManualJournal(token, "2026-08-05", [
        { accountId: expenseAccountA1Id, debitMinor: 90, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 90,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
      ]);
      const res = await vatPosition(token, {
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
      }).expect(200);
      // No invoices/bills posted in this window — the AP/AR-sourced
      // portion of the headline is exactly 0, only the manual portion
      // is nonzero.
      expect(res.body.meta.unclassifiedOutputTaxMinor).toBe(0);
      expect(res.body.meta.outputTaxMinor).toBe(
        res.body.meta.manualOutputTaxMinor,
      );
    });
  });

  describe("JTX-030 — multiple lines, only one tax-tagged", () => {
    it("only the tagged line's amount contributes to the classified VAT totals", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
      }).expect(200);

      await createAndPostManualJournal(token, "2026-09-10", [
        { accountId: expenseAccountA1Id, debitMinor: 500, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 120,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
        { accountId: assetAccountA1Id, debitMinor: 0, creditMinor: 380 },
      ]);

      const after = await vatPosition(token, {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
      }).expect(200);
      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor + 120,
      );
    });
  });

  describe("JTX-031 — multiple tax-tagged lines, different codes and directions", () => {
    it("preserves each classification independently without cross-contamination", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const before = await vatPosition(token, {
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
      }).expect(200);

      await createAndPostManualJournal(token, "2026-10-10", [
        { accountId: expenseAccountA1Id, debitMinor: 1000, creditMinor: 0 },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 60,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
        {
          accountId: taxOutputAccountA1Id,
          debitMinor: 0,
          creditMinor: 40,
          taxCodeId: taxCodeSecondId,
          taxDirection: "OUTPUT",
        },
        {
          accountId: taxInputAccountA1Id,
          debitMinor: 30,
          creditMinor: 0,
          taxCodeId: taxCodeStandardId,
          taxDirection: "INPUT",
        },
        { accountId: assetAccountA1Id, debitMinor: 0, creditMinor: 930 },
      ]);

      const after = await vatPosition(token, {
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
      }).expect(200);

      expect(after.body.meta.outputTaxMinor).toBe(
        before.body.meta.outputTaxMinor + 100, // 60 + 40, two distinct codes
      );
      expect(after.body.meta.inputTaxMinor).toBe(
        before.body.meta.inputTaxMinor + 30,
      );

      const stdOutputRow = after.body.data.outputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeStandardId,
      );
      const secondOutputRow = after.body.data.outputByTaxCode.find(
        (r: { taxCodeId: string }) => r.taxCodeId === taxCodeSecondId,
      );
      expect(stdOutputRow.manualTaxMinor).toBeGreaterThanOrEqual(60);
      expect(secondOutputRow.manualTaxMinor).toBeGreaterThanOrEqual(40);
    });
  });

  describe("RBAC — unchanged surface (no new routes; existing role matrix applies to tax-classified requests too)", () => {
    it("finance.viewer cannot create a journal entry, tax-classified or not (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
            taxCodeId: taxCodeStandardId,
            taxDirection: "INPUT",
          },
          { accountId: revenueAccountA1Id, debitMinor: 0, creditMinor: 100 },
        ],
      }).expect(403);
    });

    it("finance.viewer/poster/admin can all read the VAT report including manual attribution fields", async () => {
      for (const role of [
        "finance.viewer",
        "finance.poster",
        "finance.admin",
      ]) {
        const token = tokenFor(tenantAId, legalEntityA1Id, [role]);
        const res = await vatPosition(token, {
          dateFrom: "2026-05-01",
          dateTo: "2026-05-31",
        }).expect(200);
        expect(res.body.meta).toHaveProperty("manualOutputTaxMinor");
        expect(res.body.meta).toHaveProperty("manualInputTaxMinor");
      }
    });
  });

  describe("Audit evidence — JTX-audit direct persisted assertion", () => {
    it("persists taxCodeId and taxDirection in audit_logs row snapshots for tax-classified journal lines", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const createRes = await createJournalEntry(token, {
        transactionDate: "2026-03-01",
        lines: [
          {
            accountId: taxOutputAccountA1Id,
            debitMinor: 0,
            creditMinor: 100,
            taxCodeId: taxCodeStandardId,
            taxDirection: "OUTPUT",
          },
          {
            accountId: assetAccountA1Id,
            debitMinor: 100,
            creditMinor: 0,
          },
        ],
      }).expect(201);

      const entryId = createRes.body.data.id as string;

      // Post the entry so audit persistence is proven across the lifecycle
      await postJournalEntry(token, entryId).expect(200);

      const db = getPlatformDb();
      const logs = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "journal_entry"),
            eq(auditLogs.entityId, entryId),
          ),
        );

      // 1. Direct assertion on CREATE audit log payload
      const createLog = logs.find((r) => r.action === "CREATE");
      expect(createLog).toBeDefined();
      expect(createLog!.tenantId).toBe(tenantAId);
      expect(createLog!.legalEntityId).toBe(legalEntityA1Id);
      const createAfter = createLog!.afterState as {
        lines?: Array<{
          taxCodeId: string | null;
          taxDirection: string | null;
        }>;
      };
      expect(createAfter.lines).toBeDefined();
      const createTaxLine = createAfter.lines!.find(
        (l) => l.taxCodeId === taxCodeStandardId,
      );
      expect(createTaxLine).toBeDefined();
      expect(createTaxLine!.taxCodeId).toBe(taxCodeStandardId);
      expect(createTaxLine!.taxDirection).toBe("OUTPUT");

      // 2. Direct assertion on POST audit log payload
      const postLog = logs.find((r) => r.action === "POST");
      expect(postLog).toBeDefined();
      expect(postLog!.tenantId).toBe(tenantAId);
      expect(postLog!.legalEntityId).toBe(legalEntityA1Id);
      const postAfter = postLog!.afterState as {
        lines?: Array<{
          taxCodeId: string | null;
          taxDirection: string | null;
        }>;
      };
      expect(postAfter.lines).toBeDefined();
      const postTaxLine = postAfter.lines!.find(
        (l) => l.taxCodeId === taxCodeStandardId,
      );
      expect(postTaxLine).toBeDefined();
      expect(postTaxLine!.taxCodeId).toBe(taxCodeStandardId);
      expect(postTaxLine!.taxDirection).toBe("OUTPUT");
    });
  });
});
