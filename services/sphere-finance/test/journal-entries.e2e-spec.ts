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
} from "@noryx/db-core";
import { closeDb as closeFinanceDb, getDb as getFinanceDb } from "../src/db/db";
import { chartOfAccounts } from "../src/db/schema";
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
    const suffix = Date.now();
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
    assetAccountA1Id = assetA1!.id;
    revenueAccountA1Id = revenueA1!.id;
    inactiveAccountA1Id = inactiveA1!.id;
    accountA2Id = accA2!.id;
    accountBId = accB!.id;
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
});
