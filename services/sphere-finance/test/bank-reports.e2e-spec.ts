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
 * Banking-1d — Cash Position, Bank/Cash Account Statement, Unreconciled
 * Transactions (docs/finance-work-item-banking-1d-proposal.md, CTO-
 * approved — combined discovery/implementation turn). Covers §7's
 * acceptance criteria: GL-derived Cash Position (including the AP/AR/
 * manual-journal-bypass proof it is not a bank_transactions sum),
 * currency subtotaling, includeInactive filtering, the Statement's
 * three-source union (Bank Transactions + Supplier Payments + Customer
 * Receipts) with correct signs and a running balance that reconciles to
 * GL, the GL-completeness correction (a manual Journal Entry surfaced as
 * its own JOURNAL_ENTRY row so the invariant holds even when the GL
 * account is touched outside all three business sources), TRANSFER
 * double-leg signing, Unreconciled Transactions' leg-scoped
 * remaining-amount computation (including the TRANSFER double-leg case),
 * RBAC, and tenant/legal-entity isolation. Runs against a real Postgres
 * instance — no mocking of accounting behavior.
 */
describe("Bank & Cash Reporting (e2e) — Banking-1d", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let expenseA1Id: string;
  let revenueA1Id: string;
  let liabilityA1Id: string; // used for DEPOSIT/WITHDRAWAL offset legs.
  let apControlA1Id: string;
  let arControlA1Id: string;
  let supplierId: string;
  let customerId: string;

  let suffix: number;

  function tokenFor(tenantId: string, legalEntityId: string, roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
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
        code: `BRP-${label}-${randomUUID().slice(0, 8)}`,
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
        code: `BRP-BCA-${label}-${randomUUID().slice(0, 8)}`,
        name: `${label} Bank/Cash Account`,
        kind: "BANK",
        glAccountId: glId,
      })
      .expect(201);
    return { id: res.body.data.id, glAccountId: glId };
  }

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
   * bypassing bank_transactions entirely — same AP/AR-bypass simulation
   * Banking-1c's own e2e suite uses, reused here because Cash Position
   * makes the identical "not a bank_transactions sum" claim (§7 AC2). */
  async function postManualJournalBypassingBankTransactions(
    tenantId: string,
    legalEntityId: string,
    periodId: string,
    debitAccountId: string,
    creditAccountId: string,
    amountMinor: number,
    transactionDate: string,
  ): Promise<void> {
    await withTenant(tenantId, async (tx) => {
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
      .values({
        slug: `brp-e2e-a-${suffix}`,
        name: "Bank Reports E2E Tenant A",
      })
      .returning();
    tenantAId = tenantA!.id;
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({
        slug: `brp-e2e-b-${suffix}`,
        name: "Bank Reports E2E Tenant B",
      })
      .returning();
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tenant A — Entity 1",
        code: "BRPA1",
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
        code: "BRPA2",
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
        code: "BRPB1",
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
    liabilityA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "LIABILITY",
      "LIAB",
    );
    apControlA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "LIABILITY",
      "APCTL",
    );
    arControlA1Id = await freshGlAccount(
      tenantAId,
      legalEntityA1Id,
      "ASSET",
      "ARCTL",
    );

    const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${admin}`)
      .send({ apControlAccountId: apControlA1Id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${admin}`)
      .send({ arControlAccountId: arControlA1Id })
      .expect(201);
    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: `BRP-SUP-${suffix}`, name: "Statement Test Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;
    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: `BRP-CUST-${suffix}`, name: "Statement Test Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        code: `BRP-OPEN-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    openPeriodA1Id = period.body.data.id;
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
        .get("/v1/finance/bank-reports/cash-position")
        .expect(401);
    });

    it("all three finance roles can read every report route (200)", async () => {
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "RBAC",
      );
      for (const roles of [
        ["finance.viewer"],
        ["finance.poster"],
        ["finance.admin"],
      ]) {
        const token = tokenFor(tenantAId, legalEntityA1Id, roles);
        await request(app.getHttpServer())
          .get("/v1/finance/bank-reports/cash-position")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .get(`/v1/finance/bank-cash-accounts/${account.id}/statement`)
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .get("/v1/finance/bank-reports/unreconciled-transactions")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Cash Position
  // ---------------------------------------------------------------------
  describe("Cash Position — GL-derived (AC1/AC2)", () => {
    it("reflects GL book balance including AP/AR/manual-journal activity, not a bank_transactions-only sum, and subtotals by currency", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "CASHPOS",
      );

      // 100000 via a real Banking-1b bank transaction...
      await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-03-01",
        amountMinor: 100_000,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });
      // ...plus 50000 via a manual journal that never touches
      // bank_transactions at all (AP/AR-bypass simulation).
      await postManualJournalBypassingBankTransactions(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        account.glAccountId,
        liabilityA1Id,
        50_000,
        "2026-03-02",
      );

      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-reports/cash-position?asOf=2026-12-31")
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const row = res.body.data.find(
        (r: { bankCashAccountId: string }) =>
          r.bankCashAccountId === account.id,
      );
      expect(row).toBeDefined();
      expect(row.balanceMinor).toBe(150_000);
      expect(row.balanceMinor).not.toBe(100_000); // NOT the naive bank_transactions-only sum.
      expect(row.currencyCode).toBe("AED");

      // Single-currency legal entity (no FX exists in this schema, §2.1)
      // — totalsByCurrency has exactly one key, and it includes this
      // account's own balance.
      expect(Object.keys(res.body.meta.totalsByCurrency)).toEqual(["AED"]);
      expect(res.body.meta.totalsByCurrency.AED).toBeGreaterThanOrEqual(
        150_000,
      );
    });

    it("excludes a deactivated account by default, includes it with includeInactive=true", async () => {
      const admin = tokenFor(tenantAId, legalEntityA1Id, ["finance.admin"]);
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "INACTIVE",
      );
      await request(app.getHttpServer())
        .patch(`/v1/finance/bank-cash-accounts/${account.id}/deactivate`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);

      const defaultRes = await request(app.getHttpServer())
        .get("/v1/finance/bank-reports/cash-position")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      expect(
        defaultRes.body.data.some(
          (r: { bankCashAccountId: string }) =>
            r.bankCashAccountId === account.id,
        ),
      ).toBe(false);

      const includeRes = await request(app.getHttpServer())
        .get("/v1/finance/bank-reports/cash-position?includeInactive=true")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      expect(
        includeRes.body.data.some(
          (r: { bankCashAccountId: string }) =>
            r.bankCashAccountId === account.id,
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Bank/Cash Account Statement
  // ---------------------------------------------------------------------
  describe("Bank/Cash Account Statement — three-source union (AC3)", () => {
    it("unions Bank Transactions, Supplier Payments, and Customer Receipts with correct signs, chronological order, and a running balance that reconciles to GL", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "STMT",
      );

      // A DEPOSIT (+1000) and a WITHDRAWAL (-200).
      await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-04-01",
        amountMinor: 1000,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });
      await postBankTransaction(poster, {
        type: "WITHDRAWAL",
        transactionDate: "2026-04-02",
        amountMinor: 200,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });

      // A POSTED Supplier Payment against this account's own glAccountId
      // (-500) — AP's existing bankCashAccountId column, read-only.
      const bill = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          supplierId,
          supplierBillNumber: `BRP-BILL-${suffix}`,
          billDate: "2026-04-03",
          lines: [{ accountId: expenseA1Id, amountMinor: 500 }],
        })
        .expect(201);
      const postedBill = await request(app.getHttpServer())
        .post(`/v1/finance/bills/${bill.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          supplierId,
          paymentDate: "2026-04-04",
          paymentAmountMinor: 500,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId: account.glAccountId,
          allocations: [
            { billId: postedBill.body.data.id, allocatedAmountMinor: 500 },
          ],
        })
        .expect(201)
        .then((r) =>
          request(app.getHttpServer())
            .post(`/v1/finance/payments/${r.body.data.id}/post`)
            .set("Authorization", `Bearer ${poster}`)
            .expect(200),
        );

      // A POSTED Customer Receipt against this account's own glAccountId
      // (+800) — AR's existing bankCashAccountId column, read-only.
      const invoice = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          customerId,
          invoiceDate: "2026-04-05",
          lines: [
            { accountId: revenueA1Id, amountMinor: 800, taxAmountMinor: 0 },
          ],
        })
        .expect(201);
      const postedInvoice = await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${invoice.body.data.id}/post`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1/finance/receipts")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          customerId,
          receiptDate: "2026-04-06",
          receiptAmountMinor: 800,
          receiptMethod: "BANK_TRANSFER",
          bankCashAccountId: account.glAccountId,
          allocations: [
            {
              invoiceId: postedInvoice.body.data.id,
              allocatedAmountMinor: 800,
            },
          ],
        })
        .expect(201)
        .then((r) =>
          request(app.getHttpServer())
            .post(`/v1/finance/receipts/${r.body.data.id}/post`)
            .set("Authorization", `Bearer ${poster}`)
            .expect(200),
        );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-cash-accounts/${account.id}/statement?dateFrom=2026-04-01&dateTo=2026-04-30`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const rows = res.body.data as Array<{
        type: string;
        amountMinor: number;
        date: string;
      }>;
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.type)).toEqual([
        "BANK_TRANSACTION",
        "BANK_TRANSACTION",
        "SUPPLIER_PAYMENT",
        "CUSTOMER_RECEIPT",
      ]);
      expect(rows[0]!.amountMinor).toBe(1000);
      expect(rows[1]!.amountMinor).toBe(-200);
      expect(rows[2]!.amountMinor).toBe(-500);
      expect(rows[3]!.amountMinor).toBe(800);
      // Chronological.
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.date >= rows[i - 1]!.date).toBe(true);
      }

      expect(res.body.meta.openingBalanceMinor).toBe(0);
      expect(res.body.meta.closingBalanceMinor).toBe(1000 - 200 - 500 + 800);

      // Reconciles against the existing, unmodified GL balance endpoint —
      // the running balance is a presentation reconstruction of the same
      // GL book balance, never a second authority (§2.2).
      const glBalance = await request(app.getHttpServer())
        .get(
          `/v1/finance/accounts/${account.glAccountId}/balance?asOf=2026-04-30`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(res.body.meta.closingBalanceMinor).toBe(
        glBalance.body.data.closingBalanceMinor,
      );
    });

    it("signs a TRANSFER correctly on both accounts' own statements (outflow on the primary leg, inflow on the counterparty leg)", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const primary = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "XFERFROM",
      );
      const counterparty = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "XFERTO",
      );
      await postBankTransaction(poster, {
        type: "TRANSFER",
        transactionDate: "2026-05-01",
        amountMinor: 300,
        bankCashAccountId: primary.id,
        counterpartyBankCashAccountId: counterparty.id,
      });

      const fromStmt = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-cash-accounts/${primary.id}/statement?dateFrom=2026-05-01&dateTo=2026-05-01`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(fromStmt.body.data).toHaveLength(1);
      expect(fromStmt.body.data[0].amountMinor).toBe(-300);

      const toStmt = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-cash-accounts/${counterparty.id}/statement?dateFrom=2026-05-01&dateTo=2026-05-01`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(toStmt.body.data).toHaveLength(1);
      expect(toStmt.body.data[0].amountMinor).toBe(300);
    });

    it("surfaces a manual Journal Entry (not created by any business document) as its own JOURNAL_ENTRY row, keeping the running/closing balance equal to the authoritative GL balance", async () => {
      // CTO correction regression test (post-1D-implementation review):
      // proves the GL-completeness invariant
      //   opening GL balance + every displayed book-side movement = closing GL balance
      // holds even when a POSTED journal entry affects this account's GL
      // balance without going through bank_transactions/
      // supplier_payments/customer_receipts at all.
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "STMTJE",
      );

      // Opening balance (5000), dated BEFORE the requested window.
      await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-08-01",
        amountMinor: 5000,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });

      // Within the window: a normal Bank Transaction (+300)...
      await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-08-11",
        amountMinor: 300,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });
      // ...and a manual journal entry posted directly against the
      // account's own GL account (-150), bypassing bank_transactions/
      // supplier_payments/customer_receipts entirely — the exact failure
      // scenario the CTO's finding described.
      await postManualJournalBypassingBankTransactions(
        tenantAId,
        legalEntityA1Id,
        openPeriodA1Id,
        liabilityA1Id,
        account.glAccountId,
        150,
        "2026-08-12",
      );

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-cash-accounts/${account.id}/statement?dateFrom=2026-08-10&dateTo=2026-08-31`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);

      const rows = res.body.data as Array<{
        type: string;
        amountMinor: number;
        runningBalanceMinor: number;
        reference: string | null;
        description: string | null;
        journalEntryId?: string;
        bankTransactionId?: string;
      }>;
      expect(rows.map((r) => r.type)).toEqual([
        "BANK_TRANSACTION",
        "JOURNAL_ENTRY",
      ]);
      expect(rows[0]!.amountMinor).toBe(300);
      expect(rows[1]!.amountMinor).toBe(-150);

      // The manual journal is represented honestly — its own journal
      // reference/memo, never a fabricated bank_transaction.
      expect(rows[1]!.journalEntryId).toBeDefined();
      expect(rows[1]!.bankTransactionId).toBeUndefined();
      expect(rows[1]!.reference).toMatch(/^MANUAL-/);
      expect(rows[1]!.description).toBe(
        "AP/AR-bypass simulation (manual journal, no bank_transactions row)",
      );

      expect(res.body.meta.openingBalanceMinor).toBe(5000);
      expect(rows[0]!.runningBalanceMinor).toBe(5300);
      expect(rows[1]!.runningBalanceMinor).toBe(5150);
      expect(res.body.meta.closingBalanceMinor).toBe(5150);

      // Reconciles against the existing, unmodified GL balance endpoint —
      // never a second authority.
      const glBalance = await request(app.getHttpServer())
        .get(
          `/v1/finance/accounts/${account.glAccountId}/balance?asOf=2026-08-31`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      expect(res.body.meta.closingBalanceMinor).toBe(
        glBalance.body.data.closingBalanceMinor,
      );
    });

    it("404s for a Bank/Cash Account that does not exist in this legal entity", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${randomUUID()}/statement`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // Unreconciled Transactions
  // ---------------------------------------------------------------------
  describe("Unreconciled Transactions — leg-scoped remaining amount (AC5)", () => {
    it("lists an unmatched transaction, excludes a fully matched one, and shows the correct remainingMinor for a partial match", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const account = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "UNREC",
      );

      const unmatched = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-06-01",
        amountMinor: 400,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });
      const toFullyMatch = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-06-02",
        amountMinor: 600,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });
      const toPartiallyMatch = await postBankTransaction(poster, {
        type: "DEPOSIT",
        transactionDate: "2026-06-03",
        amountMinor: 1000,
        bankCashAccountId: account.id,
        glAccountId: liabilityA1Id,
      });

      // Import a statement and fully-match toFullyMatch, partially-match
      // toPartiallyMatch (400 of 1000) — reusing Banking-1c's own
      // matching API, unmodified.
      const header = "date,description,reference,debit,credit";
      const csv = Buffer.from(
        `${header}\n2026-06-02,full,REF,,6.00\n2026-06-03,partial,REF,,10.00\n`,
        "utf-8",
      );
      const imp = await request(app.getHttpServer())
        .post("/v1/finance/bank-statement-imports")
        .set("Authorization", `Bearer ${poster}`)
        .field("bankCashAccountId", account.id)
        .field("statementDateFrom", "2026-06-01")
        .field("statementDateTo", "2026-06-30")
        .attach("file", csv, "unrec.csv")
        .expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const fullLine = lines.body.data.find(
        (l: { amountMinor: number }) => l.amountMinor === 600,
      );
      const partialLine = lines.body.data.find(
        (l: { amountMinor: number }) => l.amountMinor === 1000,
      );

      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: fullLine.id,
          bankTransactionId: toFullyMatch.id,
          matchedAmountMinor: 600,
          matchType: "MANUAL",
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: partialLine.id,
          bankTransactionId: toPartiallyMatch.id,
          matchedAmountMinor: 400,
          matchType: "MANUAL",
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-reports/unreconciled-transactions?bankCashAccountId=${account.id}&asOf=2026-12-31`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const rows = res.body.data as Array<{
        bankTransactionId: string;
        remainingMinor: number;
      }>;
      const byId = new Map(rows.map((r) => [r.bankTransactionId, r]));

      expect(byId.get(unmatched.id)?.remainingMinor).toBe(400);
      expect(byId.has(toFullyMatch.id)).toBe(false);
      expect(byId.get(toPartiallyMatch.id)?.remainingMinor).toBe(600);
    });

    it("shows a TRANSFER matched on one leg only exactly once, for the unmatched leg, when queried legal-entity-wide", async () => {
      const poster = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const primary = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "XFERUNRECFROM",
      );
      const counterparty = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "XFERUNRECTO",
      );
      const transfer = await postBankTransaction(poster, {
        type: "TRANSFER",
        transactionDate: "2026-07-01",
        amountMinor: 700,
        bankCashAccountId: primary.id,
        counterpartyBankCashAccountId: counterparty.id,
      });

      // Match only the primary (FROM) leg.
      const header = "date,description,reference,debit,credit";
      const csv = Buffer.from(
        `${header}\n2026-07-01,transfer out,REF,7.00,\n`,
        "utf-8",
      );
      const imp = await request(app.getHttpServer())
        .post("/v1/finance/bank-statement-imports")
        .set("Authorization", `Bearer ${poster}`)
        .field("bankCashAccountId", primary.id)
        .field("statementDateFrom", "2026-07-01")
        .field("statementDateTo", "2026-07-31")
        .attach("file", csv, "xfer-unrec.csv")
        .expect(201);
      const lines = await request(app.getHttpServer())
        .get(`/v1/finance/bank-statement-imports/${imp.body.data.id}/lines`)
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/v1/finance/bank-statement-imports/${imp.body.data.id}/matches`)
        .set("Authorization", `Bearer ${poster}`)
        .send({
          statementLineId: lines.body.data[0].id,
          bankTransactionId: transfer.id,
          matchedAmountMinor: 700,
          matchType: "MANUAL",
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/v1/finance/bank-reports/unreconciled-transactions?asOf=2026-12-31`,
        )
        .set("Authorization", `Bearer ${poster}`)
        .expect(200);
      const rows = (
        res.body.data as Array<{
          bankTransactionId: string;
          bankCashAccountId: string;
          remainingMinor: number;
        }>
      ).filter((r) => r.bankTransactionId === transfer.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.bankCashAccountId).toBe(counterparty.id);
      expect(rows[0]!.remainingMinor).toBe(700);
    });
  });

  // ---------------------------------------------------------------------
  // Isolation
  // ---------------------------------------------------------------------
  describe("Tenant / legal-entity isolation", () => {
    it("Cash Position never returns another tenant's or another legal entity's accounts", async () => {
      const accountA1 = await freshBankCashAccount(
        tenantAId,
        legalEntityA1Id,
        "ISOA1",
      );
      const accountA2 = await freshBankCashAccount(
        tenantAId,
        legalEntityA2Id,
        "ISOA2",
      );
      const accountB = await freshBankCashAccount(
        tenantBId,
        legalEntityBId,
        "ISOB",
      );

      const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      const res = await request(app.getHttpServer())
        .get("/v1/finance/bank-reports/cash-position?includeInactive=true")
        .set("Authorization", `Bearer ${posterA1}`)
        .expect(200);
      const ids = res.body.data.map(
        (r: { bankCashAccountId: string }) => r.bankCashAccountId,
      );
      expect(ids).toContain(accountA1.id);
      expect(ids).not.toContain(accountA2.id);
      expect(ids).not.toContain(accountB.id);
    });

    it("entity A1 cannot read entity A2's Bank/Cash Account statement (404)", async () => {
      const accountA2 = await freshBankCashAccount(
        tenantAId,
        legalEntityA2Id,
        "ISOSTMT",
      );
      const posterA1 = tokenFor(tenantAId, legalEntityA1Id, ["finance.poster"]);
      await request(app.getHttpServer())
        .get(`/v1/finance/bank-cash-accounts/${accountA2.id}/statement`)
        .set("Authorization", `Bearer ${posterA1}`)
        .expect(404);
    });
  });
});
