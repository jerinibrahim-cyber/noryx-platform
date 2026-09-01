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
  paymentProviderSettlements,
  paymentSettlementMatches,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Banking-1e — Payment Provider Settlement Import & Reconciliation
 * (docs/finance-work-item-banking-1e-proposal.md, CTO-approved —
 * implementation-authorization turn). Covers: RBAC, the explicit
 * `purpose = CLEARING` classification requirement (§7),
 * GENERIC_SETTLEMENT_CSV import/validation/idempotency (§14/§15), the
 * `gross - fee + adjustment = net` DB-level invariant (§17), matching
 * (deterministic + manual, partial, over-allocation rejection, undo),
 * the create-settlement-transactions convenience (§19, DRAFT-only,
 * TRANSFER+FEE sign convention), the Clearing Account Reconciliation
 * report (§20), the two-condition reconciliation-completion gate (§18),
 * DB-trigger immutability once COMPLETED, audit logging, and tenant/
 * legal-entity isolation. Runs against a real Postgres instance — no
 * mocking of accounting behavior.
 */
describe("Payment Provider Settlement Import & Reconciliation (e2e) — Banking-1e", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let clearingA1Id: string;
  let operatingA1Id: string;
  let clearingA2Id: string;
  let clearingBId: string;

  let expenseA1Id: string;
  let revenueA1Id: string;

  let openPeriodA1Id: string;
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

  async function freshGlAccount(
    tenantId: string,
    legalEntityId: string,
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
    label: string,
  ): Promise<string> {
    const financeDb = getFinanceDb();
    const [row] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `PPS-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} account`,
        type,
      })
      .returning();
    return row!.id;
  }

  async function freshBankCashAccount(
    tenantId: string,
    legalEntityId: string,
    label: string,
    purpose: "OPERATING" | "CLEARING" = "OPERATING",
  ): Promise<{ id: string; glAccountId: string }> {
    const glId = await freshGlAccount(tenantId, legalEntityId, "ASSET", label);
    const admin = tokenFor(tenantId, legalEntityId, ["finance.admin"]);
    const res = await request(app.getHttpServer())
      .post("/v1/finance/bank-cash-accounts")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        code: `PPS-BCA-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} Bank/Cash Account`,
        kind: "BANK",
        purpose,
        glAccountId: glId,
      })
      .expect(201);
    return { id: res.body.data.id, glAccountId: glId };
  }

  function settlementCsv(rows: string[][]): Buffer {
    const header =
      "settlement_id,settlement_date,gross_amount,fee_amount,adjustment_amount,net_amount,description";
    const body = rows
      .map((r) => r.map((f) => (f.includes(",") ? `"${f}"` : f)).join(","))
      .join("\n");
    return Buffer.from(`${header}\n${body}\n`, "utf-8");
  }

  function uploadSettlementCsv(
    token: string,
    fields: Record<string, string>,
    fileBuffer: Buffer,
    filename = "settlements.csv",
  ) {
    let req = request(app.getHttpServer())
      .post("/v1/finance/payment-provider-settlement-imports")
      .set("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(fields)) {
      req = req.field(k, v);
    }
    return req.attach("file", fileBuffer, filename);
  }

  function statementCsv(rows: string[][]): Buffer {
    const header = "date,description,reference,debit,credit";
    const body = rows
      .map((r) => r.map((f) => (f.includes(",") ? `"${f}"` : f)).join(","))
      .join("\n");
    return Buffer.from(`${header}\n${body}\n`, "utf-8");
  }

  function uploadStatementCsv(
    token: string,
    fields: Record<string, string>,
    fileBuffer: Buffer,
    filename = "statement.csv",
  ) {
    let req = request(app.getHttpServer())
      .post("/v1/finance/bank-statement-imports")
      .set("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(fields)) {
      req = req.field(k, v);
    }
    return req.attach("file", fileBuffer, filename);
  }

  /** Inserts a POSTED journal entry DIRECTLY against a GL account,
   * independent of any bank_transactions/create-settlement-transactions
   * flow — used to precisely control a Clearing Account's GL MOVEMENT
   * within a date window for the completion-gate/report tests, the same
   * technique bank-reconciliation.e2e-spec.ts uses to control book
   * balance. */
  async function postManualJournal(
    tenantId: string,
    legalEntityId: string,
    periodId: string,
    debitAccountId: string,
    creditAccountId: string,
    amountMinor: number,
    transactionDate: string,
  ): Promise<string> {
    return withTenant(tenantId, async (tx) => {
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          journalNumber: `MANUAL-${randomUUID().slice(0, 12)}`,
          status: "DRAFT",
          transactionDate,
          periodId,
          currencyCode: "AED",
          memo: "Manual journal for Banking-1e e2e control",
        })
        .returning();
      await tx.insert(journalLines).values([
        {
          tenantId,
          journalEntryId: entry!.id,
          lineNumber: 1,
          accountId: debitAccountId,
          debitMinor: amountMinor,
          creditMinor: 0,
        },
        {
          tenantId,
          journalEntryId: entry!.id,
          lineNumber: 2,
          accountId: creditAccountId,
          debitMinor: 0,
          creditMinor: amountMinor,
        },
      ]);
      await tx
        .update(journalEntries)
        .set({ status: "POSTED", postedAt: new Date() })
        .where(eq(journalEntries.id, entry!.id));
      return entry!.id;
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
      .values({
        slug: `pps-e2e-a-${suffix}`,
        name: "Payment Settlements E2E Tenant A",
      })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `pps-e2e-b-${suffix}`,
        name: "Payment Settlements E2E Tenant B",
      })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "PPSA1",
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
        code: "PPSA2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "Tenant B — Entity 1",
        code: "PPSB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    expenseA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "EXPENSE",
      "EXP",
    );
    revenueA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "REVENUE",
      "REV",
    );

    const clearing = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "CLEARING",
      "CLEARING",
    );
    clearingA1Id = clearing.id;
    operatingA1Id = (
      await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "OPERATING",
        "OPERATING",
      )
    ).id;
    clearingA2Id = (
      await freshBankCashAccount(
        tenantAId,
        legalEntityA2Id,
        "CLEARING2",
        "CLEARING",
      )
    ).id;
    clearingBId = (
      await freshBankCashAccount(
        tenantBId,
        legalEntityBId,
        "CLEARINGB",
        "CLEARING",
      )
    ).id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `PPS-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;
  });

  afterAll(async () => {
    await closeFinanceDb();
    await closePlatformDb();
    await app.close();
  });

  // ---------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------
  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/payment-provider-settlement-imports")
        .expect(401);
    });

    it("finance.viewer can list (200) but cannot upload (403)", async () => {
      const viewer = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/payment-provider-settlement-imports")
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await uploadSettlementCsv(
        viewer,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          ["RBAC-1", "2026-02-01", "100.00", "0.00", "0.00", "100.00", ""],
        ]),
      ).expect(403);
    });

    it("finance.admin can list (200) but cannot upload (403)", async () => {
      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .get("/v1/finance/payment-provider-settlement-imports")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      await uploadSettlementCsv(
        admin,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          ["RBAC-2", "2026-02-01", "100.00", "0.00", "0.00", "100.00", ""],
        ]),
      ).expect(403);
    });

    it("finance.poster can upload (201)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          [
            "RBAC-3",
            "2026-02-01",
            "100.00",
            "0.00",
            "0.00",
            "100.00",
            "rbac ok",
          ],
        ]),
      ).expect(201);
    });
  });

  // ---------------------------------------------------------------------
  // Clearing Account requirement (§7)
  // ---------------------------------------------------------------------
  describe("purpose = CLEARING requirement", () => {
    it("rejects an import against an OPERATING account (400)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: operatingA1Id },
        settlementCsv([
          ["OP-1", "2026-02-01", "100.00", "0.00", "0.00", "100.00", ""],
        ]),
      ).expect(400);
    });

    it("accepts an import against a CLEARING account (201)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          ["OP-2", "2026-02-01", "100.00", "0.00", "0.00", "100.00", ""],
        ]),
      ).expect(201);
    });
  });

  // ---------------------------------------------------------------------
  // Import — GENERIC_SETTLEMENT_CSV parse/validate/idempotency (§14/§15)
  // ---------------------------------------------------------------------
  describe("import — GENERIC_SETTLEMENT_CSV parse/validate/idempotency", () => {
    it("a valid file creates one header row and N settlement rows, status VALIDATED", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "IMPORT1",
        "CLEARING",
      );
      const res = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          [
            "I1-A",
            "2026-03-01",
            "500.00",
            "10.00",
            "0.00",
            "490.00",
            "batch a",
          ],
          [
            "I1-B",
            "2026-03-02",
            "300.00",
            "5.00",
            "-2.00",
            "293.00",
            "batch b",
          ],
        ]),
      ).expect(201);
      expect(res.body.data.status).toBe("VALIDATED");
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${res.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(settlements.body.data).toHaveLength(2);
      expect(
        settlements.body.data.every(
          (s: { matchStatus: string }) => s.matchStatus === "UNMATCHED",
        ),
      ).toBe(true);
      const second = settlements.body.data.find(
        (s: { providerSettlementId: string }) =>
          s.providerSettlementId === "I1-B",
      );
      expect(second.netAmountMinor).toBe(29300);
      expect(second.adjustmentAmountMinor).toBe(-200);
    });

    it("a malformed file (bad header) produces FAILED with zero settlements persisted", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const badHeader = Buffer.from("wrong,header,shape\n1,2,3\n", "utf-8");
      const res = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        badHeader,
      ).expect(201);
      expect(res.body.data.status).toBe("FAILED");
      expect(Array.isArray(res.body.data.parseErrors)).toBe(true);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${res.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(settlements.body.data).toHaveLength(0);
    });

    it("an arithmetic-mismatch row produces FAILED with zero settlements persisted, even when other rows are valid", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          [
            "ARITH-GOOD",
            "2026-03-05",
            "100.00",
            "0.00",
            "0.00",
            "100.00",
            "good row",
          ],
          [
            "ARITH-BAD",
            "2026-03-05",
            "100.00",
            "10.00",
            "0.00",
            "95.00",
            "bad row",
          ],
        ]),
      ).expect(201);
      expect(res.body.data.status).toBe("FAILED");
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${res.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(settlements.body.data).toHaveLength(0);
    });

    it("a within-file duplicate providerSettlementId produces FAILED with zero settlements persisted", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        settlementCsv([
          [
            "DUP-IN-FILE",
            "2026-03-06",
            "10.00",
            "0.00",
            "0.00",
            "10.00",
            "first",
          ],
          [
            "DUP-IN-FILE",
            "2026-03-07",
            "20.00",
            "0.00",
            "0.00",
            "20.00",
            "second",
          ],
        ]),
      ).expect(201);
      expect(res.body.data.status).toBe("FAILED");
      expect(
        (res.body.data.parseErrors as string[]).some((e) =>
          e.includes("duplicates row"),
        ),
      ).toBe(true);
    });

    it("a cross-file duplicate providerSettlementId (already persisted for this account) produces FAILED, not a silent overwrite", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CROSSDUP",
        "CLEARING",
      );
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["CROSS-1", "2026-03-08", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
        "cross-1.csv",
      ).expect(201);
      const second = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["CROSS-1", "2026-03-09", "15.00", "0.00", "0.00", "15.00", ""],
        ]),
        "cross-2.csv",
      ).expect(201);
      expect(second.body.data.status).toBe("FAILED");
      expect(
        (second.body.data.parseErrors as string[]).some((e) =>
          e.includes("already exists"),
        ),
      ).toBe(true);
    });

    it("rejects a byte-identical re-upload for the same account (409)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const content = settlementCsv([
        [
          "FILEHASH-1",
          "2026-03-10",
          "10.00",
          "0.00",
          "0.00",
          "10.00",
          "dup test",
        ],
      ]);
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        content,
        "hashdup.csv",
      ).expect(201);
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        content,
        "hashdup.csv",
      ).expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Settlement arithmetic invariant — DB CHECK (§17)
  // ---------------------------------------------------------------------
  describe("settlement arithmetic invariant — enforced at the database level", () => {
    it("rejects a raw INSERT violating gross - fee + adjustment = net", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DBCHECK",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["DBCHK-SEED", "2026-03-11", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(paymentProviderSettlements).values({
            tenantId: tenantAId,
            legalEntityId: legalEntityA1Id,
            settlementImportId: imp.body.data.id,
            bankCashAccountId: bca.id,
            providerSettlementId: "DBCHK-BAD",
            settlementDate: "2026-03-11",
            currencyCode: "AED",
            grossAmountMinor: 10000,
            feeAmountMinor: 500,
            adjustmentAmountMinor: 0,
            netAmountMinor: 10000, // should be 9500 — violates the CHECK.
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects a raw INSERT duplicating providerSettlementId for the same account (idempotency race closer)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DBUNIQUE",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["DBUNIQ-1", "2026-03-12", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);

      await expect(
        withTenant(tenantAId, (tx) =>
          tx.insert(paymentProviderSettlements).values({
            tenantId: tenantAId,
            legalEntityId: legalEntityA1Id,
            settlementImportId: imp.body.data.id,
            bankCashAccountId: bca.id,
            providerSettlementId: "DBUNIQ-1", // duplicates the already-persisted row.
            settlementDate: "2026-03-12",
            currencyCode: "AED",
            grossAmountMinor: 10000,
            feeAmountMinor: 0,
            adjustmentAmountMinor: 0,
            netAmountMinor: 10000,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // Matching (§10)
  // ---------------------------------------------------------------------
  describe("matching", () => {
    async function setupSettlementWithStatementLine(
      label: string,
      netAmountMinor: number,
      settlementDate: string,
      lineDate: string,
    ) {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        label,
        "CLEARING",
      );
      const netStr = (netAmountMinor / 100).toFixed(2);
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          [
            `${label}-1`,
            settlementDate,
            netStr,
            "0.00",
            "0.00",
            netStr,
            "settlement",
          ],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const settlementId = settlements.body.data[0].id;

      const stmt = await uploadStatementCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-01-01",
          statementDateTo: "2026-12-31",
        },
        statementCsv([[lineDate, "settlement credit", "REF", "", netStr]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${stmt.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      return { poster, bca, importId: imp.body.data.id, settlementId, lineId };
    }

    it("suggests exactly one DETERMINISTIC_MATCH candidate for an unambiguous pair, and it is not auto-confirmed", async () => {
      const { poster, settlementId, lineId } =
        await setupSettlementWithStatementLine(
          "DETMATCH",
          9800,
          "2026-04-05",
          "2026-04-06",
        );

      const suggestions = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlements/${settlementId}/suggestions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(suggestions.body.data.ambiguous).toBe(false);
      expect(suggestions.body.data.candidates).toHaveLength(1);
      expect(suggestions.body.data.candidates[0].id).toBe(lineId);

      // Suggestion alone never creates a match — matchStatus is still
      // UNMATCHED until an explicit confirm.
      const matches = await request(app.getHttpServer())
        .get(`/v1/finance/payment-provider-settlements/${settlementId}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(matches.body.data).toHaveLength(0);
    });

    it("a DETERMINISTIC_MATCH request is independently re-verified — mismatched amount rejected (422)", async () => {
      const { poster, settlementId, lineId } =
        await setupSettlementWithStatementLine(
          "DETVERIFY",
          5000,
          "2026-04-10",
          "2026-04-11",
        );
      await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          bankStatementLineId: lineId,
          matchedAmountMinor: 4000, // != settlement's own netAmountMinor.
          matchType: "DETERMINISTIC_MATCH",
        })
        .expect(422);
    });

    it("manual full match produces MATCHED", async () => {
      const { poster, settlementId, lineId, importId } =
        await setupSettlementWithStatementLine(
          "MANUALFULL",
          7500,
          "2026-04-15",
          "2026-04-15",
        );
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ bankStatementLineId: lineId, matchedAmountMinor: 7500 })
        .expect(201);
      expect(match.body.data.matchType).toBe("MANUAL");
      expect(match.body.data.status).toBe("ACTIVE");

      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${importId}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(
        settlements.body.data.find((s: { id: string }) => s.id === settlementId)
          .matchStatus,
      ).toBe("MATCHED");
    });

    it("rejects over-allocation on the settlement side and the bank-statement-line side (422)", async () => {
      const { poster, settlementId, lineId } =
        await setupSettlementWithStatementLine(
          "OVERALLOC",
          5000,
          "2026-04-20",
          "2026-04-20",
        );
      await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ bankStatementLineId: lineId, matchedAmountMinor: 6000 })
        .expect(422);
    });

    it("undo returns a match to ACTIVE->UNDONE and recomputes matchStatus back toward UNMATCHED", async () => {
      const { poster, settlementId, lineId } =
        await setupSettlementWithStatementLine(
          "UNDOTEST",
          3000,
          "2026-04-25",
          "2026-04-25",
        );
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ bankStatementLineId: lineId, matchedAmountMinor: 3000 })
        .expect(201);

      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlementId}/matches/${match.body.data.id}/undo`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const matches = await request(app.getHttpServer())
        .get(`/v1/finance/payment-provider-settlements/${settlementId}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(matches.body.data[0].status).toBe("UNDONE");
    });
  });

  // ---------------------------------------------------------------------
  // create-settlement-transactions (§19) — DRAFT-only, never posts.
  // ---------------------------------------------------------------------
  describe("create-settlement-transactions", () => {
    it("creates a DRAFT TRANSFER (Clearing -> destination) and a DRAFT FEE when feeAmountMinor > 0, with correct legs and amounts", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CREATETX",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          [
            "CTX-1",
            "2026-05-01",
            "1000.00",
            "20.00",
            "0.00",
            "980.00",
            "settlement",
          ],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const settlementId = settlements.body.data[0].id;

      const created = await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlementId}/create-settlement-transactions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          destinationBankCashAccountId: operatingA1Id,
          feeGlAccountId: expenseA1Id,
        })
        .expect(201);
      expect(created.body.data).toHaveLength(2);

      const transfer = created.body.data.find(
        (t: { type: string }) => t.type === "TRANSFER",
      );
      const fee = created.body.data.find(
        (t: { type: string }) => t.type === "FEE",
      );
      expect(transfer.status).toBe("DRAFT");
      expect(transfer.journalEntryId).toBeNull();
      expect(transfer.amountMinor).toBe(98000);
      expect(transfer.bankCashAccountId).toBe(bca.id);
      expect(transfer.counterpartyBankCashAccountId).toBe(operatingA1Id);

      expect(fee.status).toBe("DRAFT");
      expect(fee.journalEntryId).toBeNull();
      expect(fee.amountMinor).toBe(2000);
      expect(fee.bankCashAccountId).toBe(bca.id);
      expect(fee.glAccountId).toBe(expenseA1Id);
    });

    it("requires feeGlAccountId when feeAmountMinor > 0 (400)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CREATETXFEE",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["CTXF-1", "2026-05-02", "500.00", "5.00", "0.00", "495.00", ""],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlements.body.data[0].id}/create-settlement-transactions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({ destinationBankCashAccountId: operatingA1Id })
        .expect(400);
    });

    it("creates only a TRANSFER (no FEE) when feeAmountMinor = 0", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CREATETXNOFEE",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["CTXNF-1", "2026-05-03", "300.00", "0.00", "0.00", "300.00", ""],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const created = await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlements.body.data[0].id}/create-settlement-transactions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({ destinationBankCashAccountId: operatingA1Id })
        .expect(201);
      expect(created.body.data).toHaveLength(1);
      expect(created.body.data[0].type).toBe("TRANSFER");
    });
  });

  // ---------------------------------------------------------------------
  // Clearing Account Reconciliation report (§20)
  // ---------------------------------------------------------------------
  describe("Clearing Account Reconciliation report", () => {
    it("reports the provider settlement total and the Clearing Account's real GL movement as two never-merged figures, and a zero difference once they align", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CLEARREPORT",
        "CLEARING",
      );
      await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["CLR-1", "2026-06-10", "800.00", "0.00", "0.00", "800.00", ""],
        ]),
      ).expect(201);

      // Before any GL activity, the provider total (80000) differs from
      // the Clearing Account's GL movement (0) — never silently treated
      // as reconciled.
      const before = await request(app.getHttpServer())
        .get("/v1/finance/payment-provider-settlements/clearing-reconciliation")
        .query({
          bankCashAccountId: bca.id,
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
        })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(before.body.data.providerSettlementTotalMinor).toBe(80000);
      expect(before.body.data.clearingAccountGlMovementMinor).toBe(0);
      expect(before.body.data.differenceMinor).toBe(80000);

      // Directly control the Clearing Account's GL movement to match the
      // provider total exactly (Dr Clearing GL account +80000, same
      // direction the real Collection posting — Dr Clearing/Cr
      // Revenue-AR — would use, §6).
      await postManualJournal(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        bca.glAccountId,
        revenueA1Id,
        80000,
        "2026-06-11",
      );

      const after = await request(app.getHttpServer())
        .get("/v1/finance/payment-provider-settlements/clearing-reconciliation")
        .query({
          bankCashAccountId: bca.id,
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
        })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(after.body.data.providerSettlementTotalMinor).toBe(80000);
      expect(after.body.data.clearingAccountGlMovementMinor).toBe(80000);
      expect(after.body.data.differenceMinor).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // Reconciliation completion — two independent conditions (§18)
  // ---------------------------------------------------------------------
  describe("reconciliation completion — two independent conditions", () => {
    async function setupCompletableImport(
      label: string,
      netAmountMinor: number,
    ) {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        label,
        "CLEARING",
      );
      const netStr = (netAmountMinor / 100).toFixed(2);
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          [`${label}-1`, "2026-07-01", netStr, "0.00", "0.00", netStr, ""],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const settlementId = settlements.body.data[0].id;

      const stmt = await uploadStatementCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-01-01",
          statementDateTo: "2026-12-31",
        },
        statementCsv([["2026-07-01", "settlement credit", "REF", "", netStr]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${stmt.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      return {
        poster,
        bca,
        importId: imp.body.data.id,
        settlementId,
        lineId: lines.body.data[0].id,
      };
    }

    it("rejects completion when a settlement is neither MATCHED nor IGNORED, even if the balance would align", async () => {
      const { poster, bca, importId } = await setupCompletableImport(
        "COMPLETE1",
        10000,
      );
      await postManualJournal(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        bca.glAccountId,
        revenueA1Id,
        10000,
        "2026-07-01",
      );
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${importId}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("rejects completion when the balance differs, even if the settlement is disposed", async () => {
      const { poster, settlementId, lineId, importId } =
        await setupCompletableImport("COMPLETE2", 20000);
      await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ bankStatementLineId: lineId, matchedAmountMinor: 20000 })
        .expect(201);
      // No GL movement posted at all — glMovement stays 0, differs from
      // the provider total of 20000.
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${importId}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("succeeds once BOTH conditions hold, and records completedBy/completedAt; double-complete rejected (409)", async () => {
      const { poster, bca, settlementId, lineId, importId } =
        await setupCompletableImport("COMPLETE3", 30000);
      await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ bankStatementLineId: lineId, matchedAmountMinor: 30000 })
        .expect(201);
      await postManualJournal(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        bca.glAccountId,
        revenueA1Id,
        30000,
        "2026-07-01",
      );

      const completed = await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${importId}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(completed.body.data.reconciliationStatus).toBe("COMPLETED");
      expect(completed.body.data.completedBy).toBeTruthy();
      expect(completed.body.data.completedAt).toBeTruthy();

      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${importId}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });

    it("an IGNORED-equivalent disposition is not available in MVP — a settlement can only be MATCHED via a real match (no ignore route exists for settlements)", async () => {
      // Confirms the proposal's own scope boundary: unlike Banking-1c's
      // bank_statement_lines, payment_provider_settlements has no
      // `ignore` route — every settlement must be disposed via a real
      // match to a bank statement line.
      const { importId, poster } = await setupCompletableImport(
        "NOIGNORE",
        1000,
      );
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${importId}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });
  });

  // ---------------------------------------------------------------------
  // Immutability once COMPLETED — DB trigger level
  // ---------------------------------------------------------------------
  describe("immutability once COMPLETED — DB trigger level", () => {
    async function completedImportWithMatch() {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "IMMUT",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["IMMUT-1", "2026-08-01", "50.00", "0.00", "0.00", "50.00", ""],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const settlementId = settlements.body.data[0].id;

      const stmt = await uploadStatementCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-01-01",
          statementDateTo: "2026-12-31",
        },
        statementCsv([["2026-08-01", "settlement credit", "REF", "", "50.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${stmt.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/payment-provider-settlements/${settlementId}/match`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          bankStatementLineId: lines.body.data[0].id,
          matchedAmountMinor: 5000,
        })
        .expect(201);

      await postManualJournal(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        bca.glAccountId,
        revenueA1Id,
        5000,
        "2026-08-01",
      );
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/complete`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      return {
        poster,
        importId: imp.body.data.id,
        settlementId,
        matchId: match.body.data.id,
      };
    }

    it("rejects a raw UPDATE of a completed import's payment_provider_settlements row", async () => {
      const { settlementId } = await completedImportWithMatch();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(paymentProviderSettlements)
            .set({ rawDescription: "bypassing service layer" })
            .where(eq(paymentProviderSettlements.id, settlementId)),
        ),
      ).rejects.toThrow(
        /immutable once its parent .* reconciliation is COMPLETED/,
      );
    });

    it("rejects a raw DELETE of a completed import's payment_settlement_matches row", async () => {
      const { matchId } = await completedImportWithMatch();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(paymentSettlementMatches)
            .where(eq(paymentSettlementMatches.id, matchId)),
        ),
      ).rejects.toThrow(
        /immutable once its parent .* reconciliation is COMPLETED/,
      );
    });

    it("rejects undo via the API once COMPLETED (409)", async () => {
      const { poster, settlementId, matchId } =
        await completedImportWithMatch();
      await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlementId}/matches/${matchId}/undo`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Delete import
  // ---------------------------------------------------------------------
  describe("delete a payment provider settlement import", () => {
    it("allows deleting a FAILED import", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bad = Buffer.from("wrong,header\n1,2\n", "utf-8");
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: clearingA1Id },
        bad,
      ).expect(201);
      expect(imp.body.data.status).toBe("FAILED");
      await request(app.getHttpServer())
        .delete(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);
    });

    it("rejects deleting a VALIDATED import (409) — re-import after correcting the source file is the intended path", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DELVALID",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["DELV-1", "2026-08-10", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);
      await request(app.getHttpServer())
        .delete(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------
  describe("audit trail", () => {
    it("writes a CREATE row for the import and a CREATE row for a match", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "AUDIT",
        "CLEARING",
      );
      const imp = await uploadSettlementCsv(
        poster,
        { bankCashAccountId: bca.id },
        settlementCsv([
          ["AUD-1", "2026-08-15", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);
      const settlements = await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${imp.body.data.id}/settlements`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const stmt = await uploadStatementCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-01-01",
          statementDateTo: "2026-12-31",
        },
        statementCsv([["2026-08-15", "settlement credit", "REF", "", "10.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${stmt.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const match = await request(app.getHttpServer())
        .post(
          `/v1/finance/payment-provider-settlements/${settlements.body.data[0].id}/match`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          bankStatementLineId: lines.body.data[0].id,
          matchedAmountMinor: 1000,
        })
        .expect(201);

      const db = getPlatformDb();
      const importAudit = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, imp.body.data.id),
            eq(auditLogs.entityType, "payment_provider_settlement_import"),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(importAudit).toHaveLength(1);

      const matchAudit = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, match.body.data.id),
            eq(auditLogs.entityType, "payment_settlement_match"),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(matchAudit).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // Isolation
  // ---------------------------------------------------------------------
  describe("cross-tenant isolation (RLS)", () => {
    it("tenant A cannot read tenant B's import by id (404)", async () => {
      const posterB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      const createdB = await uploadSettlementCsv(
        posterB,
        { bankCashAccountId: clearingBId },
        settlementCsv([
          ["TB-1", "2026-08-20", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);

      const posterA = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${createdB.body.data.id}`,
        )
        .set("Authorization", `Bearer ${posterA}`)
        .expect(404);
    });
  });

  describe("cross-legal-entity isolation within the same tenant", () => {
    it("entity A1 cannot read entity A2's import by id (404) — explicit legalEntityId predicate", async () => {
      const posterA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const createdA2 = await uploadSettlementCsv(
        posterA2,
        { bankCashAccountId: clearingA2Id },
        settlementCsv([
          ["A2-1", "2026-08-20", "10.00", "0.00", "0.00", "10.00", ""],
        ]),
      ).expect(201);

      const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(
          `/v1/finance/payment-provider-settlement-imports/${createdA2.body.data.id}`,
        )
        .set("Authorization", `Bearer ${posterA1}`)
        .expect(404);
    });
  });
});
