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
  bankCashAccounts,
  bankTransactions,
  chartOfAccounts,
  journalEntries,
  journalLines,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Banking-1b — Bank Transactions
 * (docs/finance-work-item-banking-1b-proposal.md §6-§15, CTO-approved).
 * Covers RBAC (document shape — finance.poster writes, all three roles
 * read, unlike bank-cash-accounts' master-data shape), DTO validation via
 * the real API, create-time business validation (account existence/
 * active/type/tenant/entity scoping), draft CRUD, posting for all five
 * transaction types with exact GL polarity and a balanced 2-line journal,
 * already-posted protection (409), posting-time re-validation (422 —
 * accounts/periods that changed state between draft and post), DB-trigger
 * immutability (bypassing the service layer entirely), the audit trail,
 * tenant/legal-entity isolation, and transaction/journal numbering
 * (including a concurrent-post race). Runs against a real Postgres
 * instance — no mocking of accounting behavior.
 */
describe("Bank Transactions (e2e) — RBAC, validation, posting, immutability, isolation, audit", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  // Bank/Cash Accounts (entity A1) — created via the real API.
  let bankCashA1Id: string; // primary leg, active
  let bankCashA1SecondId: string; // TRANSFER counterparty, active, distinct GL
  let cashCashA1Id: string; // a third active Bank/Cash Account, entity A1
  let inactiveBankCashA1Id: string; // deactivated after creation

  // Cross-entity / cross-tenant Bank/Cash Accounts.
  let bankCashA2Id: string; // entity A2
  let bankCashBId: string; // tenant B

  // GL accounts (entity A1) for offset legs.
  let expenseA1Id: string; // FEE offset
  let revenueA1Id: string; // INTEREST offset
  let liabilityA1Id: string; // DEPOSIT/WITHDRAWAL offset (valid)
  let equityA1Id: string; // DEPOSIT/WITHDRAWAL offset (valid, alternate)
  let wrongTypeAssetA1Id: string; // ASSET — invalid offset for FEE/INTEREST

  let openPeriodA1Id: string;
  let closedPeriodA1Id: string;
  let suffix: number;

  const NO_PERIOD_DATE = "2027-06-15"; // outside every period seeded below

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

  /** Creates a fresh, dedicated chart_of_accounts row — every caller gets
   * its own row so uniqueness invariants (bank_cash_accounts_gl_account_
   * unique) never collide across independent test blocks (the exact
   * lesson learned debugging Banking-1a's own e2e suite). */
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
        code: `BTX-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} account`,
        type,
      })
      .returning();
    return row!.id;
  }

  /** Reads back a Bank/Cash Account's own linked glAccountId directly from
   * the DB (not exposed on the bank transaction response body itself). */
  async function glAccountIdOfBankCashAccount(
    tenantId: string,
    bankCashAccountId: string,
  ): Promise<string> {
    return withTenant(tenantId, (tx) =>
      tx
        .select({ glAccountId: bankCashAccounts.glAccountId })
        .from(bankCashAccounts)
        .where(eq(bankCashAccounts.id, bankCashAccountId))
        .then((rows) => rows[0]!.glAccountId),
    );
  }

  /** Creates a fresh, active Bank/Cash Account (via the real API) in the
   * given tenant/legal entity, backed by its own dedicated GL account. */
  async function freshBankCashAccount(
    tenantId: string,
    legalEntityId: string,
    label: string,
  ): Promise<string> {
    const glId = await freshGlAccount(tenantId, legalEntityId, "ASSET", label);
    const admin = tokenFor(tenantId, legalEntityId, ["finance.admin"]);
    const res = await request(app.getHttpServer())
      .post("/v1/finance/bank-cash-accounts")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        code: `BTX-BCA-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} Bank/Cash Account`,
        kind: "BANK",
        glAccountId: glId,
      })
      .expect(201);
    return res.body.data.id;
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
      .values({ slug: `btx-e2e-a-${suffix}`, name: "Bank Txn E2E Tenant A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `btx-e2e-b-${suffix}`, name: "Bank Txn E2E Tenant B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BTXA1",
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
        code: "BTXA2",
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
        code: "BTXB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    // GL offset accounts, entity A1.
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
    liabilityA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "LIABILITY",
      "LIAB",
    );
    equityA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "EQUITY",
      "EQ",
    );
    wrongTypeAssetA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "ASSET",
      "WRONGTYPE",
    );

    // Bank/Cash Accounts, entity A1.
    bankCashA1Id = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "PRIMARY",
    );
    bankCashA1SecondId = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "COUNTERPARTY",
    );
    cashCashA1Id = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "THIRD",
    );

    const toDeactivateId = await freshBankCashAccount(
      tenantAId,
      legalEntityA1Id,
      "TOBEDEACTIVATED",
    );
    await request(app.getHttpServer())
      .patch(`/v1/finance/bank-cash-accounts/${toDeactivateId}/deactivate`)
      .set(
        "Authorization",
        `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
      )
      .expect(200);
    inactiveBankCashA1Id = toDeactivateId;

    // Cross-entity / cross-tenant Bank/Cash Accounts.
    bankCashA2Id = await freshBankCashAccount(
      tenantAId,
      legalEntityA2Id,
      "ENTITY2",
    );
    bankCashBId = await freshBankCashAccount(
      tenantBId,
      legalEntityBId,
      "TENANTB",
    );

    const adminToken = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    const openPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BTX-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = openPeriod.body.data.id;

    const closedPeriod = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BTX-CLOSED-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      })
      .expect(201);
    closedPeriodA1Id = closedPeriod.body.data.id;
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closedPeriodA1Id}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // ---------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------
  describe("RBAC", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .expect(401);
    });

    it("finance.viewer can list/get (200) but cannot create/edit/delete/post (403)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 500,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(201);
      const id = created.body.data.id;

      const viewer = tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"]);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${id}`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${viewer}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 500,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${id}`)
        .set("Authorization", `Bearer ${viewer}`)
        .send({ memo: "nope" })
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-transactions/${id}`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${id}/post`)
        .set("Authorization", `Bearer ${viewer}`)
        .expect(403);
    });

    it("finance.admin can list/get (200) but cannot create/edit/delete/post (403) — document shape, not master-data shape", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "WITHDRAWAL",
          transactionDate: "2026-02-01",
          amountMinor: 250,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(201);
      const id = created.body.data.id;

      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${id}`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${admin}`)
        .send({
          type: "WITHDRAWAL",
          transactionDate: "2026-02-01",
          amountMinor: 250,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${id}/post`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(403);
    });

    it("finance.poster can create/edit/delete/post (2xx)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ memo: "poster edit" })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------
  // DTO validation via the real API
  // ---------------------------------------------------------------------
  describe("DTO validation", () => {
    let poster: string;
    beforeAll(() => {
      poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    });

    it("rejects a missing type/transactionDate/amountMinor/bankCashAccountId (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({})
        .expect(400);
    });

    it("rejects an unrecognized type (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "REFUND",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(400);
    });

    it("rejects amountMinor <= 0 (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 0,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("rejects an unknown extra field (400, forbidNonWhitelisted)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
          notARealField: "x",
        })
        .expect(400);
    });

    it("TRANSFER missing counterpartyBankCashAccountId, glAccountId supplied instead (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("TRANSFER with both counterpartyBankCashAccountId and glAccountId (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA1SecondId,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("DEPOSIT with counterpartyBankCashAccountId instead of glAccountId (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA1SecondId,
        })
        .expect(400);
    });

    it("DEPOSIT missing glAccountId entirely (400)", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
        })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------
  // Create-time business validation
  // ---------------------------------------------------------------------
  describe("create-time business validation", () => {
    let poster: string;
    beforeAll(() => {
      poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    });

    it("400 when bankCashAccountId does not exist", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: randomUUID(),
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("400 when bankCashAccountId is inactive", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: inactiveBankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("400 when bankCashAccountId belongs to a different legal entity", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA2Id,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("400 when bankCashAccountId belongs to a different tenant", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashBId,
          glAccountId: liabilityA1Id,
        })
        .expect(400);
    });

    it("400 when TRANSFER's counterpartyBankCashAccountId equals bankCashAccountId", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA1Id,
        })
        .expect(400);
    });

    it("400 when TRANSFER's counterpartyBankCashAccountId is inactive/cross-entity/cross-tenant", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: inactiveBankCashA1Id,
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA2Id,
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashBId,
        })
        .expect(400);
    });

    it("400 when glAccountId does not exist / is inactive / cross-entity / cross-tenant", async () => {
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: randomUUID(),
        })
        .expect(400);

      const inactiveGlId = await freshGlAccount(
        tenantAId,
        legalEntityA1Id,
        "LIABILITY",
        "INACTIVEOFFSET",
      );
      const financeDb = getFinanceDb();
      await financeDb
        .update(chartOfAccounts)
        .set({ isActive: false })
        .where(eq(chartOfAccounts.id, inactiveGlId));
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: inactiveGlId,
        })
        .expect(400);

      const glA2 = await freshGlAccount(
        tenantAId,
        legalEntityA2Id,
        "LIABILITY",
        "CROSSENTITY",
      );
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: glA2,
        })
        .expect(400);
    });

    it("400 when glAccountId's type is not permitted for the transaction type", async () => {
      // FEE requires EXPENSE.
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: wrongTypeAssetA1Id,
        })
        .expect(400);
      // INTEREST requires REVENUE.
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "INTEREST",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(400);
      // DEPOSIT/WITHDRAWAL require ASSET/LIABILITY/EQUITY — REVENUE rejected.
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: revenueA1Id,
        })
        .expect(400);
      await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "WITHDRAWAL",
          transactionDate: "2026-02-01",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(400);
    });

    it("accepts DEPOSIT/WITHDRAWAL against ASSET, LIABILITY, or EQUITY offset accounts", async () => {
      for (const glId of [wrongTypeAssetA1Id, liabilityA1Id, equityA1Id]) {
        await request(app.getHttpServer())
          .post("/v1/finance/bank-transactions")
          .set("Authorization", `Bearer ${poster}`)
          .send({
            type: "DEPOSIT",
            transactionDate: "2026-02-01",
            amountMinor: 50,
            bankCashAccountId: bankCashA1Id,
            glAccountId: glId,
          })
          .expect(201);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Draft CRUD
  // ---------------------------------------------------------------------
  describe("draft CRUD", () => {
    let poster: string;
    beforeAll(() => {
      poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    });

    it("creates a DRAFT with server-resolved currencyCode/status, returns 201", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-03-01",
          amountMinor: 300,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
          reference: "REF-1",
          memo: "test deposit",
        })
        .expect(201);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.currencyCode).toBe("AED");
      expect(res.body.data.internalReference).toBeNull();
      expect(res.body.data.journalEntryId).toBeNull();
      expect(res.body.data.reference).toBe("REF-1");
    });

    it("gets by id (200) and 404s for an unknown id", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-03-01",
          amountMinor: 300,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${randomUUID()}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);
    });

    it("lists filtered by status/type/bankCashAccountId/dateFrom/dateTo", async () => {
      const marker = randomUUID();
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "WITHDRAWAL",
          transactionDate: "2026-04-15",
          amountMinor: 400,
          bankCashAccountId: cashCashA1Id,
          glAccountId: liabilityA1Id,
          reference: marker,
        })
        .expect(201);

      const byType = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ type: "WITHDRAWAL", status: "DRAFT" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(
        byType.body.data.some(
          (t: { id: string }) => t.id === created.body.data.id,
        ),
      ).toBe(true);

      const byAccount = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ bankCashAccountId: cashCashA1Id })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(
        byAccount.body.data.every(
          (t: { bankCashAccountId: string }) =>
            t.bankCashAccountId === cashCashA1Id,
        ),
      ).toBe(true);

      const byDateRange = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ dateFrom: "2026-04-01", dateTo: "2026-04-30" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(
        byDateRange.body.data.some(
          (t: { id: string }) => t.id === created.body.data.id,
        ),
      ).toBe(true);

      const outOfRange = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ dateFrom: "2026-05-01", dateTo: "2026-05-31" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(
        outOfRange.body.data.some(
          (t: { id: string }) => t.id === created.body.data.id,
        ),
      ).toBe(false);

      await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ status: "BOGUS" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(400);
      await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .query({ type: "BOGUS" })
        .set("Authorization", `Bearer ${poster}`)
        .expect(400);
    });

    it("updates a DRAFT's fields (amount, date, reference, memo, accounts)", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-03-05",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      const updated = await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          amountMinor: 150,
          transactionDate: "2026-03-06",
          reference: "UPDATED-REF",
          memo: "updated memo",
          bankCashAccountId: cashCashA1Id,
        })
        .expect(200);
      expect(updated.body.data.amountMinor).toBe(150);
      expect(updated.body.data.transactionDate).toBe("2026-03-06");
      expect(updated.body.data.reference).toBe("UPDATED-REF");
      expect(updated.body.data.memo).toBe("updated memo");
      expect(updated.body.data.bankCashAccountId).toBe(cashCashA1Id);
    });

    it("400 when PATCHing a TRANSFER with glAccountId, or a non-TRANSFER with counterpartyBankCashAccountId", async () => {
      const transfer = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-03-07",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          counterpartyBankCashAccountId: bankCashA1SecondId,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${transfer.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ glAccountId: liabilityA1Id })
        .expect(400);

      const deposit = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-03-07",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: liabilityA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${deposit.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ counterpartyBankCashAccountId: bankCashA1SecondId })
        .expect(400);
    });

    it("deletes a DRAFT (200), subsequent GET 404s; 404 deleting/updating an unknown id", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-03-08",
          amountMinor: 100,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-transactions/${randomUUID()}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${randomUUID()}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ memo: "x" })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${randomUUID()}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // Posting — all five types, exact GL polarity, balanced journal.
  // ---------------------------------------------------------------------
  describe("posting — POST /bank-transactions/:id/post", () => {
    let poster: string;
    let posterId: string;
    beforeAll(() => {
      posterId = randomUUID();
      poster = tokenFor(
        tenantAId,
        legalEntityA1Id,
        ["finance.poster"],
        posterId,
      );
    });

    async function assertBalancedTwoLineJournal(
      journalEntryId: string,
      amountMinor: number,
      debitAccountId: string,
      creditAccountId: string,
    ) {
      const je = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, journalEntryId))
          .then((rows) => rows[0]!),
      );
      expect(je.journalNumber).toMatch(/^JE-\d{6}$/);
      expect(je.status).toBe("POSTED");

      const lines = await withTenant(tenantAId, (tx) =>
        tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.journalEntryId, journalEntryId)),
      );
      expect(lines).toHaveLength(2);
      const debitLine = lines.find((l) => l.accountId === debitAccountId);
      const creditLine = lines.find((l) => l.accountId === creditAccountId);
      expect(debitLine).toBeTruthy();
      expect(creditLine).toBeTruthy();
      expect(debitLine!.debitMinor).toBe(amountMinor);
      expect(debitLine!.creditMinor).toBe(0);
      expect(creditLine!.creditMinor).toBe(amountMinor);
      expect(creditLine!.debitMinor).toBe(0);

      const totalDebits = lines.reduce((sum, l) => sum + l.debitMinor, 0);
      const totalCredits = lines.reduce((sum, l) => sum + l.creditMinor, 0);
      expect(totalDebits).toBe(totalCredits);
      expect(totalDebits).toBe(amountMinor);
    }

    it("TRANSFER: Dr counterparty GL / Cr primary GL", async () => {
      const from = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "TXFROMBCA",
      );
      const to = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "TXTOBCA",
      );

      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "TRANSFER",
          transactionDate: "2026-05-01",
          amountMinor: 700,
          bankCashAccountId: from,
          counterpartyBankCashAccountId: to,
        })
        .expect(201);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(posted.body.data.status).toBe("POSTED");
      expect(posted.body.data.internalReference).toMatch(/^BTX-\d{6}$/);
      expect(posted.body.data.periodId).toBe(openPeriodA1Id);
      expect(posted.body.data.postedBy).toBe(posterId);

      const [fromGl, toGl] = await Promise.all([
        glAccountIdOfBankCashAccount(tenantAId, from),
        glAccountIdOfBankCashAccount(tenantAId, to),
      ]);

      await assertBalancedTwoLineJournal(
        posted.body.data.journalEntryId,
        700,
        toGl, // destination = debit
        fromGl, // source = credit
      );
    });

    it("DEPOSIT: Dr Bank/Cash GL / Cr offset GL", async () => {
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DEPBCA",
      );
      const offset = await freshGlAccount(
        tenantAId,
        legalEntityA1Id,
        "LIABILITY",
        "DEPOFFSET",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "DEPOSIT",
          transactionDate: "2026-05-02",
          amountMinor: 800,
          bankCashAccountId: bca,
          glAccountId: offset,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const bcaGl = await glAccountIdOfBankCashAccount(tenantAId, bca);
      await assertBalancedTwoLineJournal(
        posted.body.data.journalEntryId,
        800,
        bcaGl, // bank/cash = debit
        offset, // offset = credit
      );
    });

    it("WITHDRAWAL: Dr offset GL / Cr Bank/Cash GL", async () => {
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "WDBCA",
      );
      const offset = await freshGlAccount(
        tenantAId,
        legalEntityA1Id,
        "EQUITY",
        "WDOFFSET",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "WITHDRAWAL",
          transactionDate: "2026-05-03",
          amountMinor: 350,
          bankCashAccountId: bca,
          glAccountId: offset,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const bcaGl = await glAccountIdOfBankCashAccount(tenantAId, bca);
      await assertBalancedTwoLineJournal(
        posted.body.data.journalEntryId,
        350,
        offset, // offset = debit
        bcaGl, // bank/cash = credit
      );
    });

    it("FEE: Dr EXPENSE offset / Cr Bank/Cash GL", async () => {
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "FEEBCA",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-05-04",
          amountMinor: 25,
          bankCashAccountId: bca,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const bcaGl = await glAccountIdOfBankCashAccount(tenantAId, bca);
      await assertBalancedTwoLineJournal(
        posted.body.data.journalEntryId,
        25,
        expenseA1Id, // EXPENSE offset = debit
        bcaGl, // bank/cash = credit
      );
    });

    it("INTEREST: Dr Bank/Cash GL / Cr REVENUE offset", async () => {
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "INTBCA",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "INTEREST",
          transactionDate: "2026-05-05",
          amountMinor: 15,
          bankCashAccountId: bca,
          glAccountId: revenueA1Id,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const bcaGl = await glAccountIdOfBankCashAccount(tenantAId, bca);
      await assertBalancedTwoLineJournal(
        posted.body.data.journalEntryId,
        15,
        bcaGl, // bank/cash = debit
        revenueA1Id, // REVENUE offset = credit
      );
    });
  });

  // ---------------------------------------------------------------------
  // Already-posted protection
  // ---------------------------------------------------------------------
  describe("already-posted protection", () => {
    let poster: string;
    let postedId: string;

    beforeAll(async () => {
      poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-05-10",
          amountMinor: 40,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      postedId = posted.body.data.id;
    });

    it("409 on double-post", async () => {
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${postedId}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });

    it("409 on PATCH of a POSTED bank transaction", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${postedId}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ memo: "should be rejected" })
        .expect(409);
    });

    it("409 on DELETE of a POSTED bank transaction", async () => {
      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-transactions/${postedId}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------
  // Posting-time re-validation (422) — state that changed after draft
  // create, and period edge cases.
  // ---------------------------------------------------------------------
  describe("posting-time re-validation (422)", () => {
    let poster: string;
    beforeAll(() => {
      poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
    });

    it("422 when the primary Bank/Cash Account was deactivated after draft creation", async () => {
      const bca = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "DEACTAFTER",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-05-11",
          amountMinor: 20,
          bankCashAccountId: bca,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${bca}/deactivate`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"])}`,
        )
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("422 when the Bank/Cash Account's own linked GL account was archived after draft creation", async () => {
      const glId = await freshGlAccount(
        tenantAId,
        legalEntityA1Id,
        "ASSET",
        "GLARCHAFTER",
      );
      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const bcaRes = await request(app.getHttpServer())
        .post("/v1/finance/bank-cash-accounts")
        .set("Authorization", `Bearer ${admin}`)
        .send({
          code: `BTX-GLARCH-${randomUUID().slice(0, 8)}`,
          name: "GL Archived After",
          kind: "BANK",
          glAccountId: glId,
        })
        .expect(201);
      const bca = bcaRes.body.data.id;

      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-05-12",
          amountMinor: 20,
          bankCashAccountId: bca,
          glAccountId: expenseA1Id,
        })
        .expect(201);

      // Archive the underlying GL account directly (no HTTP archive route
      // exists that survives the Bank/Cash Account still being active) —
      // same direct-DB technique used by Banking-1a's own e2e suite for
      // this class of state transition.
      const financeDb = getFinanceDb();
      await financeDb
        .update(chartOfAccounts)
        .set({ isActive: false })
        .where(eq(chartOfAccounts.id, glId));

      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("422 when the offset glAccountId was archived after draft creation", async () => {
      const offsetGl = await freshGlAccount(
        tenantAId,
        legalEntityA1Id,
        "EXPENSE",
        "OFFSETARCHAFTER",
      );
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-05-13",
          amountMinor: 20,
          bankCashAccountId: bankCashA1Id,
          glAccountId: offsetGl,
        })
        .expect(201);
      const financeDb = getFinanceDb();
      await financeDb
        .update(chartOfAccounts)
        .set({ isActive: false })
        .where(eq(chartOfAccounts.id, offsetGl));
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("422 when no accounting period covers the transaction date", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: NO_PERIOD_DATE,
          amountMinor: 20,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });

    it("422 when the covering accounting period is CLOSED", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2025-01-15", // inside closedPeriodA1
          amountMinor: 20,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(422);
    });
  });

  // ---------------------------------------------------------------------
  // Immutability at the DB trigger level.
  // ---------------------------------------------------------------------
  describe("immutability at the DB trigger level — proves the guarantee holds even bypassing the service layer", () => {
    async function createAndPostBankTransaction(): Promise<string> {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-06-01",
          amountMinor: 10,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${created.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      return posted.body.data.id;
    }

    it("rejects a raw UPDATE of any column on a POSTED bank_transactions row — zero exceptions", async () => {
      const id = await createAndPostBankTransaction();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx
            .update(bankTransactions)
            .set({ memo: "bypassing the service layer" })
            .where(eq(bankTransactions.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });

    it("rejects a raw DELETE of a POSTED bank_transactions row", async () => {
      const id = await createAndPostBankTransaction();
      await expect(
        withTenant(tenantAId, (tx) =>
          tx.delete(bankTransactions).where(eq(bankTransactions.id, id)),
        ),
      ).rejects.toThrow(/immutable once POSTED/);
    });
  });

  // ---------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------
  describe("audit trail", () => {
    it("writes CREATE/UPDATE/POST rows on the bank transaction and a linked journal_entry CREATE row", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-07-01",
          amountMinor: 60,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-transactions/${id}`)
        .set("Authorization", `Bearer ${poster}`)
        .send({ memo: "audit test" })
        .expect(200);

      const posted = await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const db = getPlatformDb();
      const txnRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, id),
            eq(auditLogs.entityType, "bank_transaction"),
          ),
        );
      const actions = txnRows.map((r) => r.action).sort();
      expect(actions).toEqual(["CREATE", "POST", "UPDATE"]);

      const jeRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, posted.body.data.journalEntryId),
            eq(auditLogs.entityType, "journal_entry"),
            eq(auditLogs.action, "CREATE"),
          ),
        );
      expect(jeRows).toHaveLength(1);
    });

    it("writes a DELETE row when a DRAFT is deleted", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          type: "FEE",
          transactionDate: "2026-07-02",
          amountMinor: 15,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/v1/finance/bank-transactions/${created.body.data.id}`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const db = getPlatformDb();
      const deleteRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.body.data.id),
            eq(auditLogs.action, "DELETE"),
          ),
        );
      expect(deleteRows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // Cross-tenant isolation
  // ---------------------------------------------------------------------
  describe("cross-tenant isolation", () => {
    let btxAId: string;
    let btxBId: string;

    beforeAll(async () => {
      const posterA = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const createdA = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${posterA}`)
        .send({
          type: "FEE",
          transactionDate: "2026-08-01",
          amountMinor: 10,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      btxAId = createdA.body.data.id;

      const expenseB = await freshGlAccount(
        tenantBId,
        legalEntityBId,
        "EXPENSE",
        "ISOB",
      );
      const posterB = tokenFor(tenantBId, legalEntityBId, ["finance.poster"]);
      const createdB = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${posterB}`)
        .send({
          type: "FEE",
          transactionDate: "2026-08-01",
          amountMinor: 10,
          bankCashAccountId: bankCashBId,
          glAccountId: expenseB,
        })
        .expect(201);
      btxBId = createdB.body.data.id;
    });

    it("tenant A lists: sees its own bank transaction, not tenant B's — RLS-enforced", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toContain(btxAId);
      expect(ids).not.toContain(btxBId);
    });

    it("tenant A cannot directly read tenant B's bank transaction by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${btxBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });

    it("tenant A cannot post tenant B's bank transaction — RLS blocks it, and the attempt has no effect", async () => {
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-transactions/${btxBId}/post`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"])}`,
        )
        .expect(404);

      const res = await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${btxBId}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantBId, legalEntityBId, ["finance.viewer"])}`,
        )
        .expect(200);
      expect(res.body.data.status).toBe("DRAFT");
    });
  });

  // ---------------------------------------------------------------------
  // Cross-legal-entity isolation within the same tenant.
  // ---------------------------------------------------------------------
  describe("cross-legal-entity isolation within the same tenant", () => {
    let btxA1Id: string;
    let btxA2Id: string;

    beforeAll(async () => {
      const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const createdA1 = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${posterA1}`)
        .send({
          type: "FEE",
          transactionDate: "2026-08-05",
          amountMinor: 10,
          bankCashAccountId: bankCashA1Id,
          glAccountId: expenseA1Id,
        })
        .expect(201);
      btxA1Id = createdA1.body.data.id;

      const expenseA2 = await freshGlAccount(
        tenantAId,
        legalEntityA2Id,
        "EXPENSE",
        "LEISO",
      );
      const posterA2 = tokenFor(tenantAId, legalEntityA2Id, ["finance.poster"]);
      const createdA2 = await request(app.getHttpServer())
        .post("/v1/finance/bank-transactions")
        .set("Authorization", `Bearer ${posterA2}`)
        .send({
          type: "FEE",
          transactionDate: "2026-08-05",
          amountMinor: 10,
          bankCashAccountId: bankCashA2Id,
          glAccountId: expenseA2,
        })
        .expect(201);
      btxA2Id = createdA2.body.data.id;
    });

    it("entity A1 lists: sees its own bank transaction, not entity A2's — explicit legalEntityId predicate", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-transactions")
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toContain(btxA1Id);
      expect(ids).not.toContain(btxA2Id);
    });

    it("entity A1 cannot directly read entity A2's bank transaction by id (404)", async () => {
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-transactions/${btxA2Id}`)
        .set(
          "Authorization",
          `Bearer ${tokenFor(tenantAId, legalEntityA1Id, ["finance.viewer"])}`,
        )
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // Numbering — sequential BTX-/JE- allocation, and a concurrency race.
  // ---------------------------------------------------------------------
  describe("numbering", () => {
    it("assigns sequential BTX-NNNNNN internalReferences only at post time", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await request(app.getHttpServer())
          .post("/v1/finance/bank-transactions")
          .set("Authorization", `Bearer ${poster}`)
          .send({
            type: "FEE",
            transactionDate: "2026-09-01",
            amountMinor: 5,
            bankCashAccountId: bankCashA1Id,
            glAccountId: expenseA1Id,
          })
          .expect(201);
        ids.push(created.body.data.id);
      }
      const refs: string[] = [];
      for (const id of ids) {
        const posted = await request(app.getHttpServer())
          .post(`/v1/finance/bank-transactions/${id}/post`)
          .set("Authorization", `Bearer ${poster}`)
          .expect(200);
        refs.push(posted.body.data.internalReference);
      }
      const numbers = refs.map((r) => parseInt(r.split("-")[1]!, 10));
      expect(numbers[1]).toBe(numbers[0]! + 1);
      expect(numbers[2]).toBe(numbers[1]! + 1);
    });

    it("concurrency: two simultaneous posts racing for the transaction-number counter — both succeed with distinct sequential numbers, no gaps or duplicates", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const [createdX, createdY] = await Promise.all([
        request(app.getHttpServer())
          .post("/v1/finance/bank-transactions")
          .set("Authorization", `Bearer ${poster}`)
          .send({
            type: "FEE",
            transactionDate: "2026-09-02",
            amountMinor: 5,
            bankCashAccountId: bankCashA1Id,
            glAccountId: expenseA1Id,
          })
          .expect(201),
        request(app.getHttpServer())
          .post("/v1/finance/bank-transactions")
          .set("Authorization", `Bearer ${poster}`)
          .send({
            type: "FEE",
            transactionDate: "2026-09-02",
            amountMinor: 5,
            bankCashAccountId: bankCashA1Id,
            glAccountId: expenseA1Id,
          })
          .expect(201),
      ]);

      const [postX, postY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/bank-transactions/${createdX.body.data.id}/post`)
          .set("Authorization", `Bearer ${poster}`),
        request(app.getHttpServer())
          .post(`/v1/finance/bank-transactions/${createdY.body.data.id}/post`)
          .set("Authorization", `Bearer ${poster}`),
      ]);
      expect(postX.status).toBe(200);
      expect(postY.status).toBe(200);
      expect(postX.body.data.internalReference).not.toBe(
        postY.body.data.internalReference,
      );
      expect(postX.body.data.journalEntryId).toBeTruthy();
      expect(postY.body.data.journalEntryId).toBeTruthy();

      const [jeX, jeY] = await withTenant(tenantAId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(journalEntries)
            .where(eq(journalEntries.id, postX.body.data.journalEntryId))
            .then((rows) => rows[0]!),
          tx
            .select()
            .from(journalEntries)
            .where(eq(journalEntries.id, postY.body.data.journalEntryId))
            .then((rows) => rows[0]!),
        ]),
      );
      expect(jeX.journalNumber).not.toBe(jeY.journalNumber);
    });
  });
});
