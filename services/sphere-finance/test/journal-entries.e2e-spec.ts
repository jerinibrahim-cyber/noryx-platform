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
  journalEntries,
  journalLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * 2c-1 — journal entry draft CRUD: create, list, get, edit, delete. No
 * posting, no numbering, no reversal — those routes don't exist yet
 * (2c-2, docs/finance-2c-journal-entry-service-proposal.md §0.1).
 *
 * Covers RBAC, tenant + legal-entity isolation, account validation at
 * create/edit time (existence, active, same tenant+entity — the 2b->2c
 * handoff §7.1/§7.5's 2c-1 list), currency resolution, full-array line
 * replacement on PATCH, and audit logging.
 */
describe("Journal entries (e2e) — 2c-1 draft CRUD", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;
  let assetAccountA1Id: string;
  let revenueAccountA1Id: string;
  let inactiveAccountA1Id: string;
  let accountA2Id: string;
  let accountBId: string;
  let archivableAccountA1Id: string;
  // 2c-2 posting/reversal periods (entity A1) — non-overlapping date
  // ranges, seeded once here and reused across the posting/reversal
  // describe blocks below, so no test needs to create its own period
  // (which would risk an EXCLUDE-constraint overlap with another test's
  // period for the same legal entity). mainOpenPeriodA1 stays OPEN for
  // the whole file's run; only tests that explicitly need to close a
  // period create and close their own dedicated one.
  let mainOpenPeriodA1Id: string;
  let closedPeriodA1Id: string;
  let revClosePeriodA1Id: string;
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
      .values({ slug: `je-e2e-a-${suffix}`, name: "JE E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `je-e2e-b-${suffix}`, name: "JE E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "JEA1",
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
        code: "JEA2",
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
        code: "JEB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const financeDb = getFinanceDb();
    const [assetA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "JE-ASSET-1",
        name: "Cash",
        type: "ASSET",
      })
      .returning();
    const [revenueA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "JE-REV-1",
        name: "Sales",
        type: "REVENUE",
      })
      .returning();
    const [inactiveA1] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "JE-INACTIVE-1",
        name: "Archived Account",
        type: "ASSET",
        isActive: false,
      })
      .returning();
    const [accA2] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA2Id,
        code: "JE-A2-1",
        name: "Entity 2 Cash",
        type: "ASSET",
      })
      .returning();
    const [accB] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantBId,
        legalEntityId: legalEntityBId,
        code: "JE-B-1",
        name: "Tenant B Cash",
        type: "ASSET",
      })
      .returning();
    const [archivable] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId: tenantAId,
        legalEntityId: legalEntityA1Id,
        code: "JE-ARCHIVABLE-1",
        name: "Archived After Draft",
        type: "ASSET",
      })
      .returning();
    assetAccountA1Id = assetA1!.id;
    revenueAccountA1Id = revenueA1!.id;
    inactiveAccountA1Id = inactiveA1!.id;
    accountA2Id = accA2!.id;
    accountBId = accB!.id;
    archivableAccountA1Id = archivable!.id;

    // 2c-2 posting/reversal periods — see the top-of-describe comment on
    // the variable declarations for why these are seeded once here.
    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const mainOpen = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `JE-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    mainOpenPeriodA1Id = mainOpen.body.data.id;

    const closed = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `JE-CLOSED-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      })
      .expect(201);
    closedPeriodA1Id = closed.body.data.id;
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closedPeriodA1Id}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const revClose = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `JE-REVCLOSE-${suffix}`,
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      })
      .expect(201);
    revClosePeriodA1Id = revClose.body.data.id;
    // Left OPEN here — the reversal test that uses it posts an entry
    // into it first, then closes it itself, since a period must be
    // OPEN at the moment an entry is posted into it.
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  function balancedLines(accountId1: string, accountId2: string) {
    return [
      { accountId: accountId1, debitMinor: 1000, creditMinor: 0 },
      { accountId: accountId2, debitMinor: 0, creditMinor: 1000 },
    ];
  }

  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/journal-entries")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create (403)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-15" })
        .expect(403);
    });

    it("finance.admin cannot create a journal entry (403) — admin has no implicit posting/drafting authority", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-15" })
        .expect(403);
    });

    it("finance.poster can create (201)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-15" })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
    });
  });

  describe("create", () => {
    it("creates a bare header with no lines — DRAFT is not required to balance or have >=2 lines", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-15", memo: "Bare header" })
        .expect(201);
      expect(res.body.data.lines).toEqual([]);
      expect(res.body.data.journalNumber).toBeNull();
      expect(res.body.data.status).toBe("DRAFT");
    });

    it("rejects a client-supplied currencyCode outright — not a DTO field at all (400, forbidNonWhitelisted)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-15", currencyCode: "XYZ" })
        .expect(400);
    });

    it("resolves currencyCode from the caller's legal entity", async () => {
      const tokenA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const resA1 = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${tokenA1}`)
        .send({ transactionDate: "2026-08-15" })
        .expect(201);
      expect(resA1.body.data.currencyCode).toBe("AED");

      const tokenA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const resA2 = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${tokenA2}`)
        .send({ transactionDate: "2026-08-15" })
        .expect(201);
      expect(resA2.body.data.currencyCode).toBe("USD");
    });

    it("assigns line numbers 1..N from array order, ignoring any client lineNumber", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      expect(
        res.body.data.lines.map((l: { lineNumber: number }) => l.lineNumber),
      ).toEqual([1, 2]);
    });

    it("rejects a nonexistent account (400), zero effect", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: balancedLines(randomUUID(), revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects an inactive account (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: balancedLines(inactiveAccountA1Id, revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects an account belonging to a different legal entity of the SAME tenant (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: balancedLines(accountA2Id, revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects an account belonging to a DIFFERENT tenant (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: balancedLines(accountBId, revenueAccountA1Id),
        })
        .expect(400);
    });

    it("rejects a zero/zero line at the DTO layer (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-15",
          lines: [
            { accountId: assetAccountA1Id, debitMinor: 0, creditMinor: 0 },
          ],
        })
        .expect(400);
    });
  });

  describe("list / get", () => {
    it("filters by status", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-08-16" })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get("/v1/finance/journal-entries?status=DRAFT")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const entry of res.body.data) {
        expect(entry.status).toBe("DRAFT");
      }
    });

    it("rejects an invalid status filter (400)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/journal-entries?status=BOGUS")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("get includes lines ordered by lineNumber", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-17",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.lines).toHaveLength(2);
      expect(res.body.data.lines[0].lineNumber).toBe(1);
      expect(res.body.data.lines[1].lineNumber).toBe(2);
    });

    it("a nonexistent id returns 404", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${randomUUID()}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("edit (PATCH) — DRAFT only, full-array line replacement", () => {
    it("edits header fields without touching lines when lines is omitted", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-18",
          memo: "Original",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const updated = await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Updated memo" })
        .expect(200);
      expect(updated.body.data.memo).toBe("Updated memo");
      expect(updated.body.data.lines).toHaveLength(2);
    });

    it("fully replaces the line array when lines is present", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-19",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const updated = await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          lines: [
            { accountId: assetAccountA1Id, debitMinor: 500, creditMinor: 0 },
          ],
        })
        .expect(200);
      expect(updated.body.data.lines).toHaveLength(1);
      expect(updated.body.data.lines[0].lineNumber).toBe(1);
      expect(updated.body.data.lines[0].debitMinor).toBe(500);
    });

    it("rejects an edit that introduces a cross-entity account (400), zero effect", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-20",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ lines: balancedLines(accountA2Id, revenueAccountA1Id) })
        .expect(400);

      const after = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.lines).toHaveLength(2);
      expect(after.body.data.lines[0].accountId).toBe(assetAccountA1Id);
    });
  });

  describe("delete — DRAFT only", () => {
    it("deletes a draft and cascades its lines", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-21",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  describe("cross-tenant / cross-legal-entity isolation", () => {
    let entryAId: string;
    let entryBId: string;
    let entryA2Id: string;

    beforeAll(async () => {
      const resA = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"])}`,
        )
        .send({ transactionDate: "2026-08-22", memo: "Tenant A entry" })
        .expect(201);
      entryAId = resA.body.data.id;

      const resB = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.poster"])}`,
        )
        .send({ transactionDate: "2026-08-22", memo: "Tenant B entry" })
        .expect(201);
      entryBId = resB.body.data.id;

      const resA2 = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"])}`,
        )
        .send({ transactionDate: "2026-08-22", memo: "Entity 2 entry" })
        .expect(201);
      entryA2Id = resA2.body.data.id;
    });

    it("tenant A cannot read tenant B's entry by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${entryBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot edit or delete tenant B's entry, zero effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${entryBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"])}`,
        )
        .send({ memo: "tampered" })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/v1/finance/journal-entries/${entryBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"])}`,
        )
        .expect(404);

      const stillThere = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${entryBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(stillThere.body.data.memo).toBe("Tenant B entry");
    });

    it("entity 1 cannot read entity 2's entry within the same tenant (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${entryA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("entity 1's list does not include entity 2's entry, and vice versa", async () => {
      const listEntity1 = await request(app.getHttpServer())
        .get("/v1/finance/journal-entries")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(
        listEntity1.body.data.map((e: { id: string }) => e.id),
      ).not.toContain(entryA2Id);
      expect(listEntity1.body.data.map((e: { id: string }) => e.id)).toContain(
        entryAId,
      );

      const listEntity2 = await request(app.getHttpServer())
        .get("/v1/finance/journal-entries")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(
        listEntity2.body.data.map((e: { id: string }) => e.id),
      ).not.toContain(entryAId);
      expect(listEntity2.body.data.map((e: { id: string }) => e.id)).toContain(
        entryA2Id,
      );
    });

    it("entity 1 cannot edit or delete entity 2's entry, zero effect", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${entryA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"])}`,
        )
        .send({ memo: "tampered" })
        .expect(404);

      const stillThere = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${entryA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA2Id, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(stillThere.body.data.memo).toBe("Entity 2 entry");
    });
  });

  describe("audit trail", () => {
    it("records CREATE, UPDATE, DELETE with full line snapshots", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-08-23",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Edited" })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const db = getPlatformDb();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, id));

      const createRow = rows.find((r) => r.action === "CREATE");
      const updateRow = rows.find((r) => r.action === "UPDATE");
      const deleteRow = rows.find((r) => r.action === "DELETE");
      expect(createRow).toBeDefined();
      expect(createRow!.entityType).toBe("journal_entry");
      expect(
        (createRow!.afterState as { lines: unknown[] }).lines,
      ).toHaveLength(2);

      expect(updateRow).toBeDefined();
      expect((updateRow!.afterState as { memo: string }).memo).toBe("Edited");

      expect(deleteRow).toBeDefined();
      expect(deleteRow!.afterState).toBeNull();
      expect(
        (deleteRow!.beforeState as { lines: unknown[] }).lines,
      ).toHaveLength(2);
    });
  });

  describe("posting — POST /journal-entries/:id/post (2c-2)", () => {
    it("RBAC: finance.viewer and finance.admin cannot post (403); finance.poster can", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          transactionDate: "2026-02-01",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);

      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
    });

    it("posts a balanced 2-line DRAFT: assigns JE-###### journalNumber, correct periodId/postedAt/postedBy, becomes immutable, one POST audit event", async () => {
      const posterId = randomUUID();
      const token = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-15",
          memo: "Posting test",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.journalNumber).toMatch(/^JE-\d{6}$/);
      expect(posted.body.data.periodId).toBe(mainOpenPeriodA1Id);
      expect(posted.body.data.postedAt).toBeTruthy();
      expect(posted.body.data.postedBy).toBe(posterId);
      expect(posted.body.data.lines).toHaveLength(2);

      // Immutable once POSTED — editing/deleting is now a clean 409, not
      // a raw trigger error.
      await request(app.getHttpServer())
        .patch(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ memo: "Attempted edit after posting" })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);

      const db = getPlatformDb();
      const postRows = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "POST")));
      expect(postRows).toHaveLength(1);
      expect(
        (postRows[0]!.afterState as { journalNumber: string }).journalNumber,
      ).toBe(posted.body.data.journalNumber);
    });

    it("rejects posting a DRAFT with fewer than 2 lines (422) — zero lines and one line", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);

      const zeroLines = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2026-03-16" })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${zeroLines.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      const oneLine = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-16",
          lines: [
            { accountId: assetAccountA1Id, debitMinor: 500, creditMinor: 0 },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${oneLine.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("rejects posting an unbalanced entry (422), zero effect", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-17",
          lines: [
            { accountId: assetAccountA1Id, debitMinor: 1000, creditMinor: 0 },
            {
              accountId: revenueAccountA1Id,
              debitMinor: 0,
              creditMinor: 900,
            },
          ],
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      const getRes = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.data.status).toBe("DRAFT");
    });

    it("rejects re-posting an already-POSTED entry (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-18",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("rejects posting a 404 (nonexistent / cross-tenant / cross-legal-entity) entry", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${randomUUID()}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });

    it("rejects posting when a line's account has been archived since draft creation (422), zero effect — posting-time re-validation independent of create-time (§7.1)", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          transactionDate: "2026-03-19",
          lines: balancedLines(archivableAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .patch(`/v1/finance/accounts/${archivableAccountA1Id}/archive`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(422);

      const getRes = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      expect(getRes.body.data.status).toBe("DRAFT");
    });

    it("rejects posting when a line references a wrong-legal-entity account (422) — only reachable by simulating post-creation drift, since create-time validation already blocks this via the API (§7.1/§7.5's 2c-2 list)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-20",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      // Simulate drift the API itself cannot produce (create/edit already
      // reject a cross-entity account) — directly rewrite the lines to
      // reference an Entity-A2 account, bypassing the service entirely.
      await withTenant(tenantAId, async (tx) => {
        await tx
          .delete(journalLines)
          .where(eq(journalLines.journalEntryId, id));
        await tx.insert(journalLines).values([
          {
            tenantId: tenantAId,
            journalEntryId: id,
            lineNumber: 1,
            accountId: accountA2Id,
            debitMinor: 1000,
            creditMinor: 0,
          },
          {
            tenantId: tenantAId,
            journalEntryId: id,
            lineNumber: 2,
            accountId: assetAccountA1Id,
            debitMinor: 0,
            creditMinor: 1000,
          },
        ]);
      });

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("rejects posting when a line references a wrong-tenant account (422) — same drift-simulation technique", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-03-21",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await withTenant(tenantAId, async (tx) => {
        await tx
          .delete(journalLines)
          .where(eq(journalLines.journalEntryId, id));
        await tx.insert(journalLines).values([
          {
            tenantId: tenantAId,
            journalEntryId: id,
            lineNumber: 1,
            accountId: accountBId,
            debitMinor: 1000,
            creditMinor: 0,
          },
          {
            tenantId: tenantAId,
            journalEntryId: id,
            lineNumber: 2,
            accountId: assetAccountA1Id,
            debitMinor: 0,
            creditMinor: 1000,
          },
        ]);
      });

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("rejects posting when no accounting period covers the transaction date (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2099-01-01",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("rejects posting into a CLOSED accounting period (422), zero effect", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2025-01-15",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      const getRes = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.data.status).toBe("DRAFT");
      expect(getRes.body.data.periodId).toBeNull();
    });

    it("numbering: sequential across posts, gap-free relative to posting order, never burned by a failed post", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);

      // A failed post (unbalanced) between two successful posts must not
      // consume a number.
      const first = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-01",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const firstPosted = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${first.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const failing = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-02",
          lines: [
            { accountId: assetAccountA1Id, debitMinor: 100, creditMinor: 0 },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${failing.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);

      const second = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-03",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const secondPosted = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${second.body.data.id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const firstNum = parseInt(
        firstPosted.body.data.journalNumber.split("-")[1],
        10,
      );
      const secondNum = parseInt(
        secondPosted.body.data.journalNumber.split("-")[1],
        10,
      );
      expect(secondNum).toBe(firstNum + 1); // the failed post between them burned nothing
    });

    it("two concurrent POST requests against the same DRAFT entry: exactly one 200, one 409, exactly one journalNumber assigned, exactly one POST audit event (§5.1)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-10",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${id}/post`)
          .set("Authorization", `Bearer ${token}`),
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${id}/post`)
          .set("Authorization", `Bearer ${token}`),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([200, 409]);

      const db = getPlatformDb();
      const postRows = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "POST")));
      expect(postRows).toHaveLength(1);

      const entry = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, id))
          .then((rows) => rows[0]),
      );
      expect(entry!.journalNumber).toMatch(/^JE-\d{6}$/);
    });

    it("concurrent PATCH and POST against the same DRAFT entry serialize cleanly — never a raw trigger error, exactly one successful post (§0.3 item B)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-11",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const [patchRes, postRes] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/v1/finance/journal-entries/${id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ memo: "Edited concurrently with posting" }),
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${id}/post`)
          .set("Authorization", `Bearer ${token}`),
      ]);

      expect(patchRes.status).not.toBe(500);
      expect(postRes.status).not.toBe(500);
      // The draft is valid regardless of the memo edit, so posting
      // succeeds whichever order the lock resolves in: either the PATCH
      // committed first (200) and posting then posts the edited draft, or
      // posting won the lock first (200) and PATCH's blocked transaction
      // re-reads status = POSTED and cleanly rejects (409) — never a raw
      // immutability-trigger error either way.
      expect(postRes.status).toBe(200);
      expect([200, 409]).toContain(patchRes.status);

      const db = getPlatformDb();
      const postRows = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "POST")));
      expect(postRows).toHaveLength(1);
    });

    it("concurrent DELETE and POST against the same DRAFT entry serialize cleanly — never a raw trigger error, exactly one definitive outcome (§0.3 item B)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-04-12",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const [delRes, postRes] = await Promise.all([
        request(app.getHttpServer())
          .delete(`/v1/finance/journal-entries/${id}`)
          .set("Authorization", `Bearer ${token}`),
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${id}/post`)
          .set("Authorization", `Bearer ${token}`),
      ]);

      expect(delRes.status).not.toBe(500);
      expect(postRes.status).not.toBe(500);
      if (delRes.status === 200) {
        // DELETE won the lock: the entry is gone before POST's blocked
        // transaction unblocks and re-reads — a clean 404, not a raw error.
        expect(postRes.status).toBe(404);
      } else {
        // POST won the lock: DELETE's blocked transaction re-reads
        // status = POSTED and cleanly rejects — never the raw
        // immutability-trigger DELETE exception.
        expect(postRes.status).toBe(200);
        expect(delRes.status).toBe(409);
      }
    });

    it("concurrent POST and accounting-period CLOSE on the covering period: posting either succeeds against the still-open period or is cleanly rejected 422 — never partially applied, never a raw error (§0.3 item C)", async () => {
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);

      const period = await request(app.getHttpServer())
        .post("/v1/finance/accounting-periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          code: `JE-RACECLOSE-${suffix}`,
          startDate: "2023-05-01",
          endDate: "2023-05-31",
        })
        .expect(201);
      const periodId = period.body.data.id;

      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${posterToken}`)
        .send({
          transactionDate: "2023-05-15",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;

      const [postRes, closeRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${id}/post`)
          .set("Authorization", `Bearer ${posterToken}`),
        request(app.getHttpServer())
          .patch(`/v1/finance/accounting-periods/${periodId}/close`)
          .set("Authorization", `Bearer ${adminToken}`),
      ]);

      expect(postRes.status).not.toBe(500);
      expect(closeRes.status).toBe(200); // the only close attempt here always eventually succeeds
      expect([200, 422]).toContain(postRes.status);

      const entry = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, id))
          .then((rows) => rows[0]),
      );
      if (postRes.status === 200) {
        // Posting won the period lock first: it must have posted against
        // this period while it was still open, never partially applied.
        expect(entry!.status).toBe("POSTED");
        expect(entry!.periodId).toBe(periodId);
      } else {
        // The close won the period lock first: posting must be a clean
        // no-op, not a torn write.
        expect(entry!.status).toBe("DRAFT");
        expect(entry!.periodId).toBeNull();
      }
    });
  });

  describe("reversal — POST /journal-entries/:id/reverse (2c-2)", () => {
    async function postBalancedEntry(
      token: string,
      transactionDate: string,
    ): Promise<string> {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate,
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      const id = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/post`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      return id;
    }

    it("RBAC: finance.viewer and finance.admin cannot reverse (403); finance.poster can", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const id = await postBalancedEntry(posterToken, "2026-05-01");

      const viewerToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.viewer",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/reverse`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);

      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${id}/reverse`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(201);
    });

    it("reverses a posted entry: swapped debit/credit on matching accounts, own number/date, links the original, original unchanged except the linkage, both CREATE+POST audit rows for the reversal plus one REVERSE row on the original", async () => {
      const reverserId = randomUUID();
      const posterToken = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        reverserId,
      );
      const originalId = await postBalancedEntry(posterToken, "2026-05-02");

      const originalBefore = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);

      const reversed = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${posterToken}`)
        .send({ memo: "Correcting entry" })
        .expect(201);

      expect(reversed.body.data.status).toBe("POSTED");
      expect(reversed.body.data.journalNumber).toMatch(/^JE-\d{6}$/);
      expect(reversed.body.data.journalNumber).not.toBe(
        originalBefore.body.data.journalNumber,
      );
      expect(reversed.body.data.reversalOfJournalEntryId).toBe(originalId);
      expect(reversed.body.data.postedBy).toBe(reverserId);
      expect(reversed.body.data.memo).toBe("Correcting entry");

      // Debit/credit swapped, same accounts, same order.
      const originalLines = originalBefore.body.data.lines as Array<{
        accountId: string;
        debitMinor: number;
        creditMinor: number;
      }>;
      const reversalLines = reversed.body.data.lines as Array<{
        accountId: string;
        debitMinor: number;
        creditMinor: number;
      }>;
      expect(reversalLines).toHaveLength(originalLines.length);
      reversalLines.forEach((line, i) => {
        expect(line.accountId).toBe(originalLines[i]!.accountId);
        expect(line.debitMinor).toBe(originalLines[i]!.creditMinor);
        expect(line.creditMinor).toBe(originalLines[i]!.debitMinor);
      });

      // Original unchanged except the linkage — same journalNumber,
      // transactionDate, periodId, memo, lines; only
      // reversedByJournalEntryId moved.
      const originalAfter = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      expect(originalAfter.body.data.reversedByJournalEntryId).toBe(
        reversed.body.data.id,
      );
      expect(originalAfter.body.data.journalNumber).toBe(
        originalBefore.body.data.journalNumber,
      );
      expect(originalAfter.body.data.transactionDate).toBe(
        originalBefore.body.data.transactionDate,
      );
      expect(originalAfter.body.data.periodId).toBe(
        originalBefore.body.data.periodId,
      );
      expect(originalAfter.body.data.memo).toBe(originalBefore.body.data.memo);
      expect(originalAfter.body.data.lines).toEqual(
        originalBefore.body.data.lines,
      );

      const db = getPlatformDb();
      const reverseRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, originalId),
            eq(auditLogs.action, "REVERSE"),
          ),
        );
      expect(reverseRows).toHaveLength(1);
      const createRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, reversed.body.data.id),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(createRows).toHaveLength(1);
      const postRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, reversed.body.data.id),
            eq(auditLogs.action, "POST"),
          ),
        );
      expect(postRows).toHaveLength(1);
    });

    it("defaults memo to 'Reversal of {journalNumber}' and transactionDate to today when omitted", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-05-03");
      const original = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const reversed = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({})
        .expect(201);

      expect(reversed.body.data.memo).toBe(
        `Reversal of ${original.body.data.journalNumber}`,
      );
      expect(reversed.body.data.transactionDate).toBe(
        new Date().toISOString().slice(0, 10),
      );
    });

    it("rejects reversing a DRAFT entry (422)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/journal-entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          transactionDate: "2026-05-04",
          lines: balancedLines(assetAccountA1Id, revenueAccountA1Id),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${created.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("rejects reversing an already-reversed entry (409)", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-05-05");
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("rejects reversing a reversal (422) — no chained reversals", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-05-06");
      const reversed = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${reversed.body.data.id}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .expect(422);
    });

    it("reverses an entry whose original covering period has since closed — the reversal resolves against its own currently-open period, original left untouched", async () => {
      const posterToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const adminToken = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.admin",
      ]);
      const originalId = await postBalancedEntry(posterToken, "2024-06-15");

      const originalBefore = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      expect(originalBefore.body.data.periodId).toBe(revClosePeriodA1Id);

      await request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${revClosePeriodA1Id}/close`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      // Default transactionDate ("now") resolves into the file's
      // mainOpenPeriodA1 (covers all of 2026), which is a different,
      // still-open period from the original's now-closed one.
      const reversed = await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(201);

      expect(reversed.body.data.periodId).toBe(mainOpenPeriodA1Id);
      expect(reversed.body.data.periodId).not.toBe(revClosePeriodA1Id);

      const originalAfter = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${posterToken}`)
        .expect(200);
      expect(originalAfter.body.data.periodId).toBe(revClosePeriodA1Id); // untouched
      expect(originalAfter.body.data.reversedByJournalEntryId).toBe(
        reversed.body.data.id,
      );
    });

    it("a reversal that fails (no covering open period for its own transactionDate) leaves no orphan reversal entry and no linkage on the original — atomic rollback", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-05-07");

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionDate: "2099-01-01" })
        .expect(422);

      const originalAfter = await request(app.getHttpServer())
        .get(`/v1/finance/journal-entries/${originalId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(originalAfter.body.data.reversedByJournalEntryId).toBeNull();

      const orphans = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.reversalOfJournalEntryId, originalId)),
      );
      expect(orphans).toHaveLength(0);
    });

    it("rejects reversing a 404 (nonexistent / cross-tenant / cross-legal-entity) entry — the target lookup is always scoped to the caller's own tenant+entity (§6.3/§7.3)", async () => {
      const posterTokenA1 = tokenFor(tenantAId, legalEntityA1Id, [
        "finance.poster",
      ]);
      const originalId = await postBalancedEntry(posterTokenA1, "2026-05-08");

      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${randomUUID()}/reverse`)
        .set("Authorization", `Bearer ${posterTokenA1}`)
        .expect(404);

      const tokenTenantB = tokenFor(tenantBId, legalEntityBId, [
        "finance.poster",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${tokenTenantB}`)
        .expect(404);

      const tokenEntityA2 = tokenFor(tenantAId, legalEntityA2Id, [
        "finance.poster",
      ]);
      await request(app.getHttpServer())
        .post(`/v1/finance/journal-entries/${originalId}/reverse`)
        .set("Authorization", `Bearer ${tokenEntityA2}`)
        .expect(404);
    });

    it("two concurrent REVERSE requests against the same POSTED entry: exactly one success, one 409, exactly one linkage, exactly one REVERSE audit event", async () => {
      const token = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const originalId = await postBalancedEntry(token, "2026-05-09");

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${originalId}/reverse`)
          .set("Authorization", `Bearer ${token}`),
        request(app.getHttpServer())
          .post(`/v1/finance/journal-entries/${originalId}/reverse`)
          .set("Authorization", `Bearer ${token}`),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = resX.status === 201 ? resX : resY;

      const original = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, originalId))
          .then((rows) => rows[0]),
      );
      expect(original!.reversedByJournalEntryId).toBe(winner.body.data.id);

      const db = getPlatformDb();
      const reverseRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, originalId),
            eq(auditLogs.action, "REVERSE"),
          ),
        );
      expect(reverseRows).toHaveLength(1);
    });
  });
});
