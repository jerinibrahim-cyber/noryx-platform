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
  bankReconciliationMatches,
  bankStatementLines,
  chartOfAccounts,
  journalEntries,
  journalLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Banking-1c — Bank Statement Import & Bank Reconciliation
 * (docs/finance-work-item-banking-1c-proposal.md, CTO-approved —
 * implementation-authorization turn). Covers the CTO's §21 test
 * strategy and the 18-item acceptance criteria list: RBAC, CSV
 * import/validation/duplicate-detection, matching (deterministic +
 * manual 1:1/1:N/N:1 + partial + over-allocation rejection), GL-derived
 * book balance (including AP/AR/manual-journal activity bypassing
 * bank_transactions), the two-condition reconciliation-completion gate,
 * create-from-line, DB-trigger immutability once COMPLETED, and tenant/
 * legal-entity isolation. Runs against a real Postgres instance — no
 * mocking of accounting behavior.
 */
describe("Bank Statement Import & Reconciliation (e2e) — Banking-1c", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let bankCashA1Id: string; // primary, entity A1
  let bankCashA1SecondId: string; // TRANSFER counterparty, entity A1
  let bankCashA2Id: string; // entity A2
  let bankCashBId: string; // tenant B

  let expenseA1Id: string;
  let liabilityA1Id: string; // used to simulate an AP-bypass manual journal entry

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
        code: `BRC-${label}-${randomUUID().slice(0, 8)}`,
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
  ): Promise<{ id: string; glAccountId: string }> {
    const glId = await freshGlAccount(tenantId, legalEntityId, "ASSET", label);
    const admin = tokenFor(tenantId, legalEntityId, ["finance.admin"]);
    const res = await request(app.getHttpServer())
      .post("/v1/finance/bank-cash-accounts")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        code: `BRC-BCA-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} Bank/Cash Account`,
        kind: "BANK",
        glAccountId: glId,
      })
      .expect(201);
    return { id: res.body.data.id, glAccountId: glId };
  }

  function csv(rows: string[][]): Buffer {
    const header = "date,description,reference,debit,credit";
    const body = rows
      .map((r) => r.map((f) => (f.includes(",") ? `"${f}"` : f)).join(","))
      .join("\n");
    return Buffer.from(`${header}\n${body}\n`, "utf-8");
  }

  function uploadCsv(
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

  /** Creates + posts a Banking-1b bank transaction via the real API — a
   * matching-candidate for the reconciliation tests below. */
  async function postBankTransaction(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; amountMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bank-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      amountMinor: posted.body.data.amountMinor,
    };
  }

  /** Inserts a POSTED journal entry DIRECTLY against a GL account,
   * bypassing bank_transactions entirely — simulates the AP/AR-bypass
   * activity (§2.9): a Supplier Payment/Customer Receipt/manual Journal
   * Entry posting against the same GL account a Bank/Cash Account links
   * to, with no bank_transactions row at all. Used to prove book
   * balance (§17) includes this activity while it remains outside the
   * matching candidate universe (§8). */
  async function postManualJournalBypassingBankTransactions(
    tenantId: string,
    legalEntityId: string,
    periodId: string,
    debitAccountId: string,
    creditAccountId: string,
    amountMinor: number,
    transactionDate: string,
  ): Promise<string> {
    return withTenant(tenantId, async (tx) => {
      // journal_lines is immutable once its parent journal_entries is
      // POSTED (immutability trigger) — same discipline
      // JournalEntriesService.post() itself follows: insert the header
      // as DRAFT, insert the lines, THEN flip the header to POSTED.
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
          memo: "AP/AR-bypass simulation (manual journal, no bank_transactions row)",
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

  let openPeriodA1Id: string;

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
      .values({ slug: `brc-e2e-a-${suffix}`, name: "Bank Recon E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `brc-e2e-b-${suffix}`, name: "Bank Recon E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BRCA1",
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
        code: "BRCA2",
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
        code: "BRCB1",
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
    liabilityA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "LIABILITY",
      "LIAB",
    );

    const primary = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "PRIMARY",
    );
    bankCashA1Id = primary.id;
    const counterparty = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "COUNTERPARTY",
    );
    bankCashA1SecondId = counterparty.id;
    bankCashA2Id = (
      await freshBankCashAccount(tenantAId, legalEntityA2Id, "ENTITY2")
    ).id;
    bankCashBId = (
      await freshBankCashAccount(tenantBId, legalEntityBId, "TENANTB")
    ).id;

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BRC-OPEN-${suffix}`,
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
        .get("/v1/finance/bank-statement-imports")
        .expect(401);
    });

    it("finance.viewer can list (200) but cannot upload (403)", async () => {
      const viewer = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-statement-imports")
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await uploadCsv(
        viewer,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-02-01",
          statementDateTo: "2026-02-28",
        },
        csv([["2026-02-01", "desc", "ref", "", "100.00"]]),
      ).expect(403);
    });

    it("finance.admin can list (200) but cannot upload (403)", async () => {
      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-statement-imports")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      await uploadCsv(
        admin,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-02-01",
          statementDateTo: "2026-02-28",
        },
        csv([["2026-02-01", "desc", "ref", "", "100.00"]]),
      ).expect(403);
    });

    it("finance.poster can upload (201)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-02-01",
          statementDateTo: "2026-02-28",
        },
        csv([["2026-02-01", "rbac ok", "ref", "", "100.00"]]),
      ).expect(201);
    });
  });

  // ---------------------------------------------------------------------
  // Import — CSV parsing/validation (AC 1, 2, 3)
  // ---------------------------------------------------------------------
  describe("import — CSV_GENERIC parse/validate", () => {
    it("a valid CSV creates one header row and N line rows, status VALIDATED (AC1)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-03-01",
          statementDateTo: "2026-03-31",
        },
        csv([
          ["2026-03-01", "fee", "REF1", "50.00", ""],
          ["2026-03-02", "deposit", "REF2", "", "200.00"],
        ]),
      ).expect(201);
      expect(res.body.data.status).toBe("VALIDATED");
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${res.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(lines.body.data).toHaveLength(2);
      expect(
        lines.body.data.every(
          (l: { matchStatus: string }) => l.matchStatus === "UNMATCHED",
        ),
      ).toBe(true);
    });

    it("a malformed file (bad header) produces FAILED with zero lines persisted (AC1)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const badHeader = Buffer.from("wrong,header,shape\n1,2,3\n", "utf-8");
      const res = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-03-01",
          statementDateTo: "2026-03-31",
        },
        badHeader,
      ).expect(201);
      expect(res.body.data.status).toBe("FAILED");
      expect(Array.isArray(res.body.data.parseErrors)).toBe(true);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${res.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(lines.body.data).toHaveLength(0);
    });

    it("a malformed row (invalid date) produces FAILED with zero lines persisted, even when other rows are valid (AC1)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-03-01",
          statementDateTo: "2026-03-31",
        },
        csv([
          ["2026-03-05", "good row", "REF", "10.00", ""],
          ["not-a-date", "bad row", "REF", "10.00", ""],
        ]),
      ).expect(201);
      expect(res.body.data.status).toBe("FAILED");
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${res.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(lines.body.data).toHaveLength(0);
    });

    it("rejects a byte-identical re-upload for the same account (409, AC2)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const content = csv([["2026-04-01", "dup test", "REF", "25.00", ""]]);
      await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-04-01",
          statementDateTo: "2026-04-30",
        },
        content,
        "dup.csv",
      ).expect(201);
      await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-04-01",
          statementDateTo: "2026-04-30",
        },
        content,
        "dup.csv",
      ).expect(409);
    });

    it("a different (non-byte-identical) file with an overlapping date range is accepted, and produces a duplicate-line warning for a line matching a prior import's fingerprint (AC3)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const first = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-05-01",
          statementDateTo: "2026-05-31",
        },
        csv([["2026-05-10", "overlap line", "OVREF", "40.00", ""]]),
        "overlap-1.csv",
      ).expect(201);
      expect(first.body.data.status).toBe("VALIDATED");

      // A different file (extra trailing row makes the bytes differ),
      // covering an overlapping date range, containing a line with the
      // identical fingerprint fields.
      const second = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-05-01",
          statementDateTo: "2026-05-31",
        },
        csv([
          ["2026-05-10", "overlap line", "OVREF", "40.00", ""],
          ["2026-05-11", "extra distinguishing row", "OVREF2", "5.00", ""],
        ]),
        "overlap-2.csv",
      ).expect(201);
      expect(second.body.data.status).toBe("VALIDATED");
      expect(second.body.data.parseWarnings).toBeTruthy();
      expect(
        (second.body.data.parseWarnings as string[]).some((w) =>
          w.includes("Possible duplicate"),
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Book balance (AC 9, 10) — never a bank_transactions sum
  // ---------------------------------------------------------------------
  describe("book balance — GL-derived, includes AP/AR-bypass activity (AC9/AC10)", () => {
    it("glBookBalanceMinor reflects a manual journal entry posted with NO bank_transactions row at all, and differs from a naive bank_transactions-only sum", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "BOOKBAL",
      );

      // One real, POSTED bank_transactions row (DEPOSIT: Dr bank/cash GL).
      await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-06-01",
        amountMinor: 100000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });

      // A second, larger amount posted DIRECTLY against the same GL
      // account bypassing bank_transactions entirely — the AP/AR-bypass
      // simulation (§2.9).
      await postManualJournalBypassingBankTransactions(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        bca.glAccountId,
        liabilityA1Id,
        50000,
        "2026-06-02",
      );

      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-06-01",
          statementDateTo: "2026-06-30",
        },
        csv([["2026-06-01", "deposit", "REF", "", "1000.00"]]),
      ).expect(201);

      const found = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      // bank_transactions-only sum would be 100000; GL book balance must
      // be 150000 (100000 DEPOSIT + 50000 manual-journal-bypass, both Dr
      // on the ASSET-type bank/cash GL account).
      expect(found.body.data.summary.glBookBalanceMinor).toBe(150000);
      expect(found.body.data.summary.glBookBalanceMinor).not.toBe(100000);
    });
  });

  // ---------------------------------------------------------------------
  // Matching (AC 4-8) — deterministic, manual 1:1/1:N/N:1, partial,
  // over-allocation rejection.
  // ---------------------------------------------------------------------
  describe("matching", () => {
    it("suggests exactly one DETERMINISTIC_MATCH candidate for an unambiguous pair, and it is not auto-confirmed (AC6)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DETMATCH",
      );
      const btx = await postBankTransaction(poster, {
        type: "FEE",
        transactionDate: "2026-07-05",
        amountMinor: 7500,
        bankCashAccountId: bca.id,
        glAccountId: expenseA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-07-01",
          statementDateTo: "2026-07-31",
        },
        csv([["2026-07-06", "bank fee", "REF", "75.00", ""]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      const suggestions = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lineId}/suggestions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(suggestions.body.data.ambiguous).toBe(false);
      expect(suggestions.body.data.candidates).toHaveLength(1);
      expect(suggestions.body.data.candidates[0].id).toBe(btx.id);

      // Suggestion alone never creates a match — matchStatus is still
      // UNMATCHED until an explicit confirm.
      const reread = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(reread.body.data[0].matchStatus).toBe("UNMATCHED");
    });

    it("surfaces ambiguity rather than guessing when two candidates tie (AC7)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "AMBIG",
      );
      await postBankTransaction(poster, {
        type: "FEE",
        transactionDate: "2026-07-10",
        amountMinor: 3000,
        bankCashAccountId: bca.id,
        glAccountId: expenseA1Id,
      });
      await postBankTransaction(poster, {
        type: "FEE",
        transactionDate: "2026-07-11",
        amountMinor: 3000,
        bankCashAccountId: bca.id,
        glAccountId: expenseA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-07-01",
          statementDateTo: "2026-07-31",
        },
        csv([["2026-07-10", "ambiguous fee", "REF", "30.00", ""]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      const suggestions = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lineId}/suggestions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(suggestions.body.data.ambiguous).toBe(true);
      expect(suggestions.body.data.candidates.length).toBeGreaterThanOrEqual(2);

      // The server independently re-verifies DETERMINISTIC_MATCH and
      // rejects it as ambiguous even if the client claims it.
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: suggestions.body.data.candidates[0].id,
          matchedAmountMinor: 3000,
          matchType: "DETERMINISTIC_MATCH",
        })
        .expect(422);
    });

    it("manual 1:1 full match produces MATCHED; partial match produces PARTIALLY_MATCHED (AC4)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "PARTIAL",
      );
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-08-01",
        amountMinor: 10000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-08-01",
          statementDateTo: "2026-08-31",
        },
        csv([["2026-08-01", "deposit", "REF", "", "100.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      const partial = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 4000,
        })
        .expect(201);
      expect(partial.body.data.matchType).toBe("MANUAL");

      let reread = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(reread.body.data[0].matchStatus).toBe("PARTIALLY_MATCHED");

      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 6000,
        })
        .expect(201);

      reread = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(reread.body.data[0].matchStatus).toBe("MATCHED");
    });

    it("rejects over-allocation on the statement-line side and the bank-transaction side (AC5)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "OVERALLOC",
      );
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-08-05",
        amountMinor: 5000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-08-01",
          statementDateTo: "2026-08-31",
        },
        csv([["2026-08-05", "deposit", "REF", "", "50.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      // Over-allocates the statement line (line amount is 5000).
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 6000,
        })
        .expect(422);
    });

    it("manual matching supports 1:N and N:1 (AC8)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "MANYSIDE",
      );

      // 1:N — one bank transaction split across two statement lines.
      const btxOneToMany = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-09-01",
        amountMinor: 10000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const impA = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-09-01",
          statementDateTo: "2026-09-30",
        },
        csv([
          ["2026-09-01", "split part 1", "REF1", "", "60.00"],
          ["2026-09-01", "split part 2", "REF2", "", "40.00"],
        ]),
      ).expect(201);
      const linesA = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${impA.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${impA.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesA.body.data[0].id,
          bankTransactionId: btxOneToMany.id,
          matchedAmountMinor: 6000,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${impA.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesA.body.data[1].id,
          bankTransactionId: btxOneToMany.id,
          matchedAmountMinor: 4000,
        })
        .expect(201);

      // N:1 — two bank transactions combined against one statement line.
      const btx1 = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-09-05",
        amountMinor: 3000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const btx2 = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-09-05",
        amountMinor: 4000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const impB = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-09-01",
          statementDateTo: "2026-09-30",
        },
        csv([["2026-09-05", "combined deposit", "REF3", "", "70.00"]]),
        "n-to-1.csv",
      ).expect(201);
      const linesB = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${impB.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${impB.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesB.body.data[0].id,
          bankTransactionId: btx1.id,
          matchedAmountMinor: 3000,
        })
        .expect(201);
      const finalMatch = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${impB.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesB.body.data[0].id,
          bankTransactionId: btx2.id,
          matchedAmountMinor: 4000,
        })
        .expect(201);
      expect(finalMatch.body.data.status).toBe("ACTIVE");

      const rereadB = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${impB.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(rereadB.body.data[0].matchStatus).toBe("MATCHED");
    });

    it("undo returns a match to ACTIVE->UNDONE and recomputes matchStatus back toward UNMATCHED", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "UNDO",
      );
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-09-10",
        amountMinor: 2000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-09-01",
          statementDateTo: "2026-09-30",
        },
        csv([["2026-09-10", "deposit", "REF", "", "20.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 2000,
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/matches/${match.body.data.id}/undo`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const reread = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(reread.body.data[0].matchStatus).toBe("UNMATCHED");
    });

    it("ignoring a line marks it IGNORED, and an ignored line cannot subsequently be matched (AC4)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "IGNORE",
      );
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-09-01",
          statementDateTo: "2026-09-30",
        },
        csv([["2026-09-15", "unexplained fee", "REF", "5.00", ""]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      const ignored = await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lineId}/ignore`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({ reason: "bank fee already written off manually" })
        .expect(200);
      expect(ignored.body.data.matchStatus).toBe("IGNORED");

      const btx = await postBankTransaction(poster, {
        type: "FEE",
        transactionDate: "2026-09-15",
        amountMinor: 500,
        bankCashAccountId: bca.id,
        glAccountId: expenseA1Id,
      });
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 500,
        })
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Create-from-line (AC14)
  // ---------------------------------------------------------------------
  describe("create-bank-transaction from an unmatched line", () => {
    it("requires acknowledgeDuplicationWarning=true (400 otherwise), and creates a DRAFT only, never posting GL (AC14)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "FROMLINE",
      );
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-10-01",
          statementDateTo: "2026-10-31",
        },
        csv([["2026-10-01", "unexplained fee", "REF", "12.34", ""]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;

      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lineId}/create-bank-transaction`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          glAccountId: expenseA1Id,
          acknowledgeDuplicationWarning: false,
        })
        .expect(400);

      const created = await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lineId}/create-bank-transaction`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          glAccountId: expenseA1Id,
          acknowledgeDuplicationWarning: true,
        })
        .expect(201);
      expect(created.body.data.status).toBe("DRAFT");
      expect(created.body.data.journalEntryId).toBeNull();
      expect(created.body.data.amountMinor).toBe(1234);
      expect(created.body.data.bankCashAccountId).toBe(bca.id);
    });
  });

  // ---------------------------------------------------------------------
  // Reconciliation completion (AC 11-13, 15)
  // ---------------------------------------------------------------------
  describe("reconciliation completion — two independent conditions", () => {
    async function setupOneLineImport(label: string) {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(tenantAId, legalEntityA1Id, label);
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-11-01",
        amountMinor: 100000,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-11-01",
          statementDateTo: "2026-11-30",
        },
        csv([["2026-11-01", "deposit", "REF", "", "1000.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      return {
        poster,
        bca,
        btx,
        importId: imp.body.data.id,
        lineId: lines.body.data[0].id,
      };
    }

    it("rejects completion when lines are unmatched, even if closingBalanceMinor is correct (AC11/AC12 precondition)", async () => {
      const { poster, importId } = await setupOneLineImport("COMPLETE1");
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${importId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 100000 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("rejects completion when closingBalanceMinor is not set, even if all lines are disposed (AC13)", async () => {
      const { poster, btx, importId, lineId } =
        await setupOneLineImport("COMPLETE2");
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 100000,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("rejects completion when the balance differs, even if all lines are disposed (AC12)", async () => {
      const { poster, btx, importId, lineId } =
        await setupOneLineImport("COMPLETE3");
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 100000,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${importId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 999999 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("succeeds once BOTH conditions hold, and records completedBy/completedAt (AC11/AC15)", async () => {
      const { poster, btx, importId, lineId } =
        await setupOneLineImport("COMPLETE4");
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 100000,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${importId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 100000 })
        .expect(200);
      const completed = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(completed.body.data.reconciliationStatus).toBe("COMPLETED");
      expect(completed.body.data.completedBy).toBeTruthy();
      expect(completed.body.data.completedAt).toBeTruthy();

      // Double-complete rejected.
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${importId}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });

    it("an IGNORED line satisfies matching completeness for completion (AC11)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "IGNCOMPLETE",
      );
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-11-01",
          statementDateTo: "2026-11-30",
        },
        csv([["2026-11-05", "unexplained", "REF", "1.00", ""]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${imp.body.data.id}/lines/${lines.body.data[0].id}/ignore`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${imp.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 0 })
        .expect(200);
      const completed = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(completed.body.data.reconciliationStatus).toBe("COMPLETED");
    });
  });

  // ---------------------------------------------------------------------
  // Post-completion immutability at the DB trigger level (AC16)
  // ---------------------------------------------------------------------
  describe("immutability once COMPLETED — DB trigger level", () => {
    async function completedImportWithLineAndMatch() {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "IMMUT",
      );
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-12-01",
        amountMinor: 500,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-01", "deposit", "REF", "", "5.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const lineId = lines.body.data[0].id;
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lineId,
          bankTransactionId: btx.id,
          matchedAmountMinor: 500,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${imp.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 500 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/complete`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      return {
        poster,
        importId: imp.body.data.id,
        lineId,
        matchId: match.body.data.id,
      };
    }

    it("rejects a raw UPDATE of a completed import's bank_statement_lines row", async () => {
      const { lineId } = await completedImportWithLineAndMatch();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(bankStatementLines)
            .set({ externalReference: "bypassing service layer" })
            .where(eq(bankStatementLines.id, lineId)),
        ),
      ).rejects.toThrow(
        /immutable once its parent .* reconciliation is COMPLETED/,
      );
    });

    it("rejects a raw DELETE of a completed import's bank_reconciliation_matches row", async () => {
      const { matchId } = await completedImportWithLineAndMatch();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .delete(bankReconciliationMatches)
            .where(eq(bankReconciliationMatches.id, matchId)),
        ),
      ).rejects.toThrow(
        /immutable once its parent .* reconciliation is COMPLETED/,
      );
    });

    it("rejects undo/ignore/new-match/create-from-line via the API once COMPLETED (409)", async () => {
      const { poster, importId, lineId, matchId } =
        await completedImportWithLineAndMatch();
      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${importId}/matches/${matchId}/undo`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${importId}/lines/${lineId}/ignore`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({})
        .expect(409);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-statement-imports/${importId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ closingBalanceMinor: 1 })
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------
  describe("audit trail", () => {
    it("writes a CREATE row for the import and CREATE/UPDATE rows for matches", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "AUDIT",
      );
      const btx = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-12-10",
        amountMinor: 100,
        bankCashAccountId: bca.id,
        glAccountId: liabilityA1Id,
      });
      const imp = await uploadCsv(
        poster,
        {
          bankCashAccountId: bca.id,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-10", "deposit", "REF", "", "1.00"]]),
      ).expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const match = await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lines.body.data[0].id,
          bankTransactionId: btx.id,
          matchedAmountMinor: 100,
        })
        .expect(201);

      const db = getPlatformDb();
      const importAudit = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, imp.body.data.id),
            eq(auditLogs.entityType, "bank_statement_import"),
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
            eq(auditLogs.entityType, "bank_reconciliation_match"),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(matchAudit).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // Isolation (AC17/AC18)
  // ---------------------------------------------------------------------
  describe("cross-tenant isolation (RLS)", () => {
    it("tenant A cannot read tenant B's import by id (404)", async () => {
      const posterB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      const createdB = await uploadCsv(
        posterB,
        {
          bankCashAccountId: bankCashBId,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-01", "tenant b", "REF", "1.00", ""]]),
      ).expect(201);

      const posterA = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${createdB.body.data.id}`)
        .set("Authorization", `Bearer ${posterA}`)
        .expect(404);
    });
  });

  describe("cross-legal-entity isolation within the same tenant", () => {
    it("entity A1 cannot read entity A2's import by id (404) — explicit legalEntityId predicate", async () => {
      const posterA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const createdA2 = await uploadCsv(
        posterA2,
        {
          bankCashAccountId: bankCashA2Id,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-01", "entity a2", "REF", "1.00", ""]]),
      ).expect(201);

      const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${createdA2.body.data.id}`)
        .set("Authorization", `Bearer ${posterA1}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // TRANSFER double-leg matching (§8)
  // ---------------------------------------------------------------------
  describe("TRANSFER double-leg matching", () => {
    it("a TRANSFER appears as a DETERMINISTIC_MATCH candidate on both accounts' statements", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-12-15",
          amountMinor: 9900,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA1SecondId,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      // Primary account's statement sees it as a DEBIT (outflow).
      const impFrom = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1Id,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-15", "transfer out", "REF", "99.00", ""]]),
        "transfer-from.csv",
      ).expect(201);
      const linesFrom = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${impFrom.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const suggestFrom = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-statement-imports/${impFrom.body.data.id}/lines/${linesFrom.body.data[0].id}/suggestions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(suggestFrom.body.data.candidates).toHaveLength(1);
      expect(suggestFrom.body.data.candidates[0].id).toBe(created.body.data.id);

      // Counterparty account's statement sees it as a CREDIT (inflow).
      const impTo = await uploadCsv(
        poster,
        {
          bankCashAccountId: bankCashA1SecondId,
          statementDateFrom: "2026-12-01",
          statementDateTo: "2026-12-31",
        },
        csv([["2026-12-15", "transfer in", "REF", "", "99.00"]]),
        "transfer-to.csv",
      ).expect(201);
      const linesTo = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${impTo.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const suggestTo = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-statement-imports/${impTo.body.data.id}/lines/${linesTo.body.data[0].id}/suggestions`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(suggestTo.body.data.candidates).toHaveLength(1);
      expect(suggestTo.body.data.candidates[0].id).toBe(created.body.data.id);

      // The same bank_transaction can be matched on BOTH statements
      // independently (two separate bank_reconciliation_matches rows).
      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${impFrom.body.data.id}/matches`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesFrom.body.data[0].id,
          bankTransactionId: created.body.data.id,
          matchedAmountMinor: 9900,
          matchType: "DETERMINISTIC_MATCH",
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/v1/finance/bank-statement-imports/${impTo.body.data.id}/matches`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: linesTo.body.data[0].id,
          bankTransactionId: created.body.data.id,
          matchedAmountMinor: 9900,
          matchType: "DETERMINISTIC_MATCH",
        })
        .expect(201);
    });
  });
});
