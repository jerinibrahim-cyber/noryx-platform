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
import { closeDb as closeFinanceDb } from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * Tax/VAT Phase 5 — Per-Tax-Code GL Account Mapping.
 * docs/finance-work-item-tax-vat-phase-5-proposal.md,
 * docs/finance-work-item-tax-vat-phase-5-discovery.md §13 (historical
 * attribution correctness proof).
 *
 * Covers, against a real Postgres instance through the real HTTP API
 * (same discipline as every other Finance e2e suite):
 *  - PATCH /tax-codes/:id/gl-accounts — RBAC, validation, set/clear.
 *  - resolveLineTax() resolution: code-level override vs. AP/AR
 *    settings singleton fallback vs. no tax; symmetric across all four
 *    tax-bearing document types.
 *  - Snapshot semantics: resolved at DRAFT time, NOT re-derived by a
 *    later tax-code account change, immutable once POSTED.
 *  - Credit-note/debit-note tax-account resolution independence from
 *    allocation.
 *  - post() polarity + multi-account aggregation (the CTO's exact
 *    worked example: two lines sharing one account aggregate into one
 *    journal line; a third line on a different account stays separate).
 *  - post()-time "every posted tax line has a deterministic
 *    destination" validation, and posting-time re-validation that a
 *    resolved tax account is still active.
 *  - VAT Position Report's additive multi-account GL cross-check.
 */
describe("Tax/VAT Phase 5 — Per-Tax-Code GL Account Mapping (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let suffix: number;

  let tenantAId: string;
  let legalEntityId: string; // fully configured: AP+AR settings incl. singleton tax accounts
  let legalEntityNoTaxSettingsId: string; // AP/AR settings exist but carry NO tax account at all

  let revenueAccountId: string;
  let expenseAccountId: string;
  let arControlAccountId: string;
  let apControlAccountId: string;
  let taxOutputSingletonId: string; // ar_settings.taxOutputAccountId
  let taxInputSingletonId: string; // ap_settings.taxInputAccountId
  let taxOutputOverrideAId: string;
  let taxOutputOverrideBId: string;
  let taxInputOverrideAId: string;
  let taxInputOverrideBId: string;

  let customerId: string;
  let supplierId: string;

  let taxCodeNoOverrideId: string; // falls back to the singleton on both sides
  let taxCodeOverrideAId: string; // ap/arTaxAccountId -> override A
  let taxCodeOverrideBId: string; // ap/arTaxAccountId -> override B

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

  async function archiveAccount(token: string, id: string): Promise<void> {
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounts/${id}/archive`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  }

  async function createTaxCode(
    token: string,
    code: string,
    rateBasisPoints: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/tax-codes")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, name: code, treatment: "STANDARD" })
      .expect(201);
    const taxCodeId = res.body.data.id as string;
    await request(app.getHttpServer())
      .post(`/v1/finance/tax-codes/${taxCodeId}/rates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rateBasisPoints, effectiveFrom: "2020-01-01" })
      .expect(201);
    return taxCodeId;
  }

  function setGlAccounts(
    token: string,
    taxCodeId: string,
    body: { apTaxAccountId?: string | null; arTaxAccountId?: string | null },
  ) {
    return request(app.getHttpServer())
      .patch(`/v1/finance/tax-codes/${taxCodeId}/gl-accounts`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  async function createBill(
    token: string,
    billDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ) {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `SBN-${randomUUID().slice(0, 8)}`,
        billDate,
        lines,
      })
      .expect(201);
    return res.body.data;
  }

  async function createInvoice(
    token: string,
    invoiceDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ) {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId, invoiceDate, lines })
      .expect(201);
    return res.body.data;
  }

  async function postDocument(
    token: string,
    kind: "bills" | "invoices" | "debit-notes" | "credit-notes",
    id: string,
    expectStatus = 200,
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/${kind}/${id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(expectStatus);
  }

  async function getJournalEntry(token: string, id: string) {
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/journal-entries/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return res.body.data;
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
      .values({ slug: `tax5-e2e-a-${suffix}`, name: "Tax Phase 5 E2E Tenant" })
      .returning();
    tenantAId = tenantA!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tax Phase 5 — Entity 1",
        code: `TAX5A1-${suffix}`,
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const [entityNoTax] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "Tax Phase 5 — Entity 2 (no tax singleton)",
        code: `TAX5A2-${suffix}`,
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    legalEntityNoTaxSettingsId = entityNoTax!.id;

    const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);

    revenueAccountId = await createAccount(admin, {
      code: "T5-REV",
      name: "Revenue",
      type: "REVENUE",
    });
    expenseAccountId = await createAccount(admin, {
      code: "T5-EXP",
      name: "Expense",
      type: "EXPENSE",
    });
    arControlAccountId = await createAccount(admin, {
      code: "T5-AR",
      name: "AR Control",
      type: "ASSET",
    });
    apControlAccountId = await createAccount(admin, {
      code: "T5-AP",
      name: "AP Control",
      type: "LIABILITY",
    });
    taxOutputSingletonId = await createAccount(admin, {
      code: "T5-TAXOUT-SINGLETON",
      name: "Tax Output (singleton)",
      type: "LIABILITY",
    });
    taxInputSingletonId = await createAccount(admin, {
      code: "T5-TAXIN-SINGLETON",
      name: "Tax Input (singleton)",
      type: "ASSET",
    });
    taxOutputOverrideAId = await createAccount(admin, {
      code: "T5-TAXOUT-A",
      name: "Tax Output Override A",
      type: "LIABILITY",
    });
    taxOutputOverrideBId = await createAccount(admin, {
      code: "T5-TAXOUT-B",
      name: "Tax Output Override B",
      type: "LIABILITY",
    });
    taxInputOverrideAId = await createAccount(admin, {
      code: "T5-TAXIN-A",
      name: "Tax Input Override A",
      type: "ASSET",
    });
    taxInputOverrideBId = await createAccount(admin, {
      code: "T5-TAXIN-B",
      name: "Tax Input Override B",
      type: "ASSET",
    });

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        arControlAccountId,
        taxOutputAccountId: taxOutputSingletonId,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        apControlAccountId,
        taxInputAccountId: taxInputSingletonId,
      })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: `T5CUST-${suffix}`, name: "Tax Phase 5 Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: `T5SUPP-${suffix}`, name: "Tax Phase 5 Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        code: `T5P-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);

    taxCodeNoOverrideId = await createTaxCode(admin, `T5-STD-${suffix}`, 500);
    taxCodeOverrideAId = await createTaxCode(admin, `T5-OVA-${suffix}`, 500);
    taxCodeOverrideBId = await createTaxCode(admin, `T5-OVB-${suffix}`, 1800);

    await setGlAccounts(admin, taxCodeOverrideAId, {
      apTaxAccountId: taxInputOverrideAId,
      arTaxAccountId: taxOutputOverrideAId,
    }).expect(200);
    await setGlAccounts(admin, taxCodeOverrideBId, {
      apTaxAccountId: taxInputOverrideBId,
      arTaxAccountId: taxOutputOverrideBId,
    }).expect(200);

    // Second legal entity: AP/AR settings exist (control accounts
    // required) but carry NO tax account at all — used to prove the
    // "every posted tax line must have a deterministic destination"
    // invariant actually blocks posting when neither a code override
    // nor a singleton fallback is configured.
    const adminNoTax = tokenFor(tenantAId, legalEntityNoTaxSettingsId, [
      "finance.admin",
    ]);
    const arControlNoTax = await createAccount(adminNoTax, {
      code: "T5B-AR",
      name: "AR Control",
      type: "ASSET",
    });
    const apControlNoTax = await createAccount(adminNoTax, {
      code: "T5B-AP",
      name: "AP Control",
      type: "LIABILITY",
    });
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminNoTax}`)
      .send({ arControlAccountId: arControlNoTax })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminNoTax}`)
      .send({ apControlAccountId: apControlNoTax })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminNoTax}`)
      .send({
        code: `T5BP-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("PATCH /tax-codes/:id/gl-accounts — RBAC and validation", () => {
    it("rejects a request with no token (401)", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/finance/tax-codes/${taxCodeNoOverrideId}/gl-accounts`)
        .send({ apTaxAccountId: taxInputOverrideAId })
        .expect(401);
    });

    it("rejects finance.viewer/finance.poster (403) — write-side is finance.admin only", async () => {
      for (const role of ["finance.viewer", "finance.poster"]) {
        const token = tokenFor(tenantAId, legalEntityId, [role]);
        await setGlAccounts(token, taxCodeNoOverrideId, {
          apTaxAccountId: taxInputOverrideAId,
        }).expect(403);
      }
    });

    it("404s for a tax code id that doesn't exist", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      await setGlAccounts(admin, randomUUID(), {
        apTaxAccountId: taxInputOverrideAId,
      }).expect(404);
    });

    it("400s for an account id that doesn't exist", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const code = await createTaxCode(admin, `T5-BADACC-${suffix}`, 500);
      await setGlAccounts(admin, code, {
        apTaxAccountId: randomUUID(),
      }).expect(400);
    });

    it("400s for an account belonging to a different legal entity", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const adminNoTax = tokenFor(tenantAId, legalEntityNoTaxSettingsId, [
        "finance.admin",
      ]);
      const foreignAccount = await createAccount(adminNoTax, {
        code: `T5-FOREIGN-${suffix}`,
        name: "Foreign account",
        type: "ASSET",
      });
      const code = await createTaxCode(admin, `T5-CROSS-${suffix}`, 500);
      await setGlAccounts(admin, code, {
        apTaxAccountId: foreignAccount,
      }).expect(400);
    });

    it("400s for an archived (inactive) account", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const toArchive = await createAccount(admin, {
        code: `T5-ARCHIVE-${suffix}`,
        name: "To be archived",
        type: "ASSET",
      });
      await archiveAccount(admin, toArchive);
      const code = await createTaxCode(admin, `T5-INACTIVE-${suffix}`, 500);
      await setGlAccounts(admin, code, {
        apTaxAccountId: toArchive,
      }).expect(400);
    });

    it("sets both accounts, returns them on the tax code, and each is independently clearable back to null", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const code = await createTaxCode(admin, `T5-SETCLEAR-${suffix}`, 500);

      const set = await setGlAccounts(admin, code, {
        apTaxAccountId: taxInputOverrideAId,
        arTaxAccountId: taxOutputOverrideAId,
      }).expect(200);
      expect(set.body.data.apTaxAccountId).toBe(taxInputOverrideAId);
      expect(set.body.data.arTaxAccountId).toBe(taxOutputOverrideAId);

      // Omitted field leaves it untouched.
      const partial = await setGlAccounts(admin, code, {
        arTaxAccountId: taxOutputOverrideBId,
      }).expect(200);
      expect(partial.body.data.apTaxAccountId).toBe(taxInputOverrideAId);
      expect(partial.body.data.arTaxAccountId).toBe(taxOutputOverrideBId);

      // Explicit null clears back to "use the singleton".
      const cleared = await setGlAccounts(admin, code, {
        apTaxAccountId: null,
        arTaxAccountId: null,
      }).expect(200);
      expect(cleared.body.data.apTaxAccountId).toBeNull();
      expect(cleared.body.data.arTaxAccountId).toBeNull();
    });
  });

  describe("resolution + snapshot semantics (draft time)", () => {
    it("supplier bill line: tax code WITH an apTaxAccountId override resolves to that override, not the singleton", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-03-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
        },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBe(taxInputOverrideAId);
    });

    it("supplier bill line: tax code with NO override falls back to ap_settings.taxInputAccountId", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-03-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeNoOverrideId,
        },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBe(taxInputSingletonId);
    });

    it("supplier bill line: legacy line (no taxCodeId, manual taxAmountMinor > 0) falls back to the singleton", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-03-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxAmountMinor: 500,
        },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBe(taxInputSingletonId);
    });

    it("supplier bill line: no tax at all -> resolvedTaxAccountId is null", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-03-01", [
        { accountId: expenseAccountId, amountMinor: 10000 },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBeNull();
    });

    it("customer invoice line: tax code WITH an arTaxAccountId override resolves to that override (AR/output direction)", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const invoice = await createInvoice(poster, "2026-03-01", [
        {
          accountId: revenueAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
        },
      ]);
      expect(invoice.lines[0].resolvedTaxAccountId).toBe(taxOutputOverrideAId);
    });

    it("customer invoice line: tax code with NO override falls back to ar_settings.taxOutputAccountId", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const invoice = await createInvoice(poster, "2026-03-01", [
        {
          accountId: revenueAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeNoOverrideId,
        },
      ]);
      expect(invoice.lines[0].resolvedTaxAccountId).toBe(taxOutputSingletonId);
    });

    it("supplier debit note line: resolves independently, same AP/input direction as a bill", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-03-02", [
        {
          accountId: expenseAccountId,
          amountMinor: 20000,
          taxCodeId: taxCodeOverrideBId,
        },
      ]);
      await postDocument(poster, "bills", bill.id);

      const debitNote = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          supplierId,
          debitNoteDate: "2026-03-03",
          lines: [
            {
              accountId: expenseAccountId,
              amountMinor: 5000,
              taxCodeId: taxCodeOverrideAId,
            },
          ],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 100 }],
        })
        .expect(201);

      // The debit note's OWN tax code (override A) determines its
      // resolvedTaxAccountId — NOT the allocated bill's tax code
      // (override B), proving independence from allocation.
      expect(debitNote.body.data.lines[0].resolvedTaxAccountId).toBe(
        taxInputOverrideAId,
      );
    });

    it("customer credit note line: resolves independently of the allocated invoice's own tax code (AR/output direction)", async () => {
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const invoice = await createInvoice(poster, "2026-03-02", [
        {
          accountId: revenueAccountId,
          amountMinor: 20000,
          taxCodeId: taxCodeOverrideBId,
        },
      ]);
      await postDocument(poster, "invoices", invoice.id);

      const creditNote = await request(app.getHttpServer())
        .post("/v1/finance/credit-notes")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          customerId,
          creditNoteDate: "2026-03-03",
          lines: [
            {
              accountId: revenueAccountId,
              amountMinor: 5000,
              taxCodeId: taxCodeOverrideAId,
            },
          ],
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 100 }],
        })
        .expect(201);

      expect(creditNote.body.data.lines[0].resolvedTaxAccountId).toBe(
        taxOutputOverrideAId,
      );
    });

    it("a later change to the tax code's GL account does NOT retroactively change an already-resolved DRAFT line", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const churnCode = await createTaxCode(admin, `T5-CHURN-${suffix}`, 500);
      await setGlAccounts(admin, churnCode, {
        apTaxAccountId: taxInputOverrideAId,
      }).expect(200);

      const bill = await createBill(poster, "2026-03-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: churnCode,
        },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBe(taxInputOverrideAId);

      // Remap the tax code to a DIFFERENT account after the bill line
      // was already resolved.
      await setGlAccounts(admin, churnCode, {
        apTaxAccountId: taxInputOverrideBId,
      }).expect(200);

      // Re-GET the still-DRAFT bill (no PATCH with new lines was made)
      // — the stored snapshot is unchanged.
      const reGet = await request(app.getHttpServer())
        .get(`/v1/finance/bills/${bill.id}`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      expect(reGet.body.data.lines[0].resolvedTaxAccountId).toBe(
        taxInputOverrideAId,
      );
    });

    it("remains unchanged after posting, even if the tax code is remapped again afterward", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const churnCode = await createTaxCode(admin, `T5-CHURN2-${suffix}`, 500);
      await setGlAccounts(admin, churnCode, {
        apTaxAccountId: taxInputOverrideAId,
      }).expect(200);

      const bill = await createBill(poster, "2026-03-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: churnCode,
        },
      ]);
      const posted = await postDocument(poster, "bills", bill.id);
      expect(posted.body.data.lines[0].resolvedTaxAccountId).toBe(
        taxInputOverrideAId,
      );

      await setGlAccounts(admin, churnCode, {
        apTaxAccountId: taxInputOverrideBId,
      }).expect(200);

      const reGet = await request(app.getHttpServer())
        .get(`/v1/finance/bills/${bill.id}`)
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);
      expect(reGet.body.data.lines[0].resolvedTaxAccountId).toBe(
        taxInputOverrideAId,
      );
    });
  });

  describe("posting — polarity and multi-account aggregation", () => {
    it("supplier bill: CTO worked example — two lines share account A (aggregate), a third uses account B (stays separate); tax debited", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-04-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 500,
        },
        {
          accountId: expenseAccountId,
          amountMinor: 6000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 300,
        },
        {
          accountId: expenseAccountId,
          amountMinor: 5000,
          taxCodeId: taxCodeOverrideBId,
          taxAmountMinor: 900,
        },
      ]);
      const posted = await postDocument(poster, "bills", bill.id);
      const je = await getJournalEntry(admin, posted.body.data.journalEntryId);

      const taxLines = je.lines.filter(
        (l: { accountId: string }) =>
          l.accountId === taxInputOverrideAId ||
          l.accountId === taxInputOverrideBId,
      );
      expect(taxLines).toHaveLength(2);

      const accountALine = taxLines.find(
        (l: { accountId: string }) => l.accountId === taxInputOverrideAId,
      );
      const accountBLine = taxLines.find(
        (l: { accountId: string }) => l.accountId === taxInputOverrideBId,
      );
      expect(accountALine.debitMinor).toBe(800); // 500 + 300 aggregated
      expect(accountALine.creditMinor).toBe(0);
      expect(accountBLine.debitMinor).toBe(900);
      expect(accountBLine.creditMinor).toBe(0);
    });

    it("customer invoice: same aggregation shape, tax CREDITED (output side)", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const invoice = await createInvoice(poster, "2026-04-01", [
        {
          accountId: revenueAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 500,
        },
        {
          accountId: revenueAccountId,
          amountMinor: 6000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 300,
        },
        {
          accountId: revenueAccountId,
          amountMinor: 5000,
          taxCodeId: taxCodeOverrideBId,
          taxAmountMinor: 900,
        },
      ]);
      const posted = await postDocument(poster, "invoices", invoice.id);
      const je = await getJournalEntry(admin, posted.body.data.journalEntryId);

      const accountALine = je.lines.find(
        (l: { accountId: string }) => l.accountId === taxOutputOverrideAId,
      );
      const accountBLine = je.lines.find(
        (l: { accountId: string }) => l.accountId === taxOutputOverrideBId,
      );
      expect(accountALine.creditMinor).toBe(800);
      expect(accountALine.debitMinor).toBe(0);
      expect(accountBLine.creditMinor).toBe(900);
      expect(accountBLine.debitMinor).toBe(0);
    });

    it("supplier debit note: reversed polarity — tax CREDITED, not debited", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-04-02", [
        {
          accountId: expenseAccountId,
          amountMinor: 50000,
          taxCodeId: taxCodeOverrideAId,
        },
      ]);
      await postDocument(poster, "bills", bill.id);

      const debitNote = await request(app.getHttpServer())
        .post("/v1/finance/debit-notes")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          supplierId,
          debitNoteDate: "2026-04-03",
          lines: [
            {
              accountId: expenseAccountId,
              amountMinor: 4000,
              taxCodeId: taxCodeOverrideAId,
              taxAmountMinor: 200,
            },
          ],
          allocations: [{ billId: bill.id, allocatedAmountMinor: 4200 }],
        })
        .expect(201);
      const posted = await postDocument(
        poster,
        "debit-notes",
        debitNote.body.data.id,
      );
      const je = await getJournalEntry(admin, posted.body.data.journalEntryId);
      const taxLine = je.lines.find(
        (l: { accountId: string }) => l.accountId === taxInputOverrideAId,
      );
      expect(taxLine.creditMinor).toBe(200);
      expect(taxLine.debitMinor).toBe(0);
    });

    it("customer credit note: reversed polarity — tax DEBITED, not credited", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const invoice = await createInvoice(poster, "2026-04-02", [
        {
          accountId: revenueAccountId,
          amountMinor: 50000,
          taxCodeId: taxCodeOverrideAId,
        },
      ]);
      await postDocument(poster, "invoices", invoice.id);

      const creditNote = await request(app.getHttpServer())
        .post("/v1/finance/credit-notes")
        .set("Authorization", `Bearer ${poster}`)
        .send({
          customerId,
          creditNoteDate: "2026-04-03",
          lines: [
            {
              accountId: revenueAccountId,
              amountMinor: 4000,
              taxCodeId: taxCodeOverrideAId,
              taxAmountMinor: 200,
            },
          ],
          allocations: [{ invoiceId: invoice.id, allocatedAmountMinor: 4200 }],
        })
        .expect(201);
      const posted = await postDocument(
        poster,
        "credit-notes",
        creditNote.body.data.id,
      );
      const je = await getJournalEntry(admin, posted.body.data.journalEntryId);
      const taxLine = je.lines.find(
        (l: { accountId: string }) => l.accountId === taxOutputOverrideAId,
      );
      expect(taxLine.debitMinor).toBe(200);
      expect(taxLine.creditMinor).toBe(0);
    });

    it("does not aggregate two DIFFERENT accounts together merely because both are input/output tax", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-04-04", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 111,
        },
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideBId,
          taxAmountMinor: 222,
        },
      ]);
      const posted = await postDocument(poster, "bills", bill.id);
      const je = await getJournalEntry(admin, posted.body.data.journalEntryId);
      const taxLines = je.lines.filter(
        (l: { accountId: string }) =>
          l.accountId === taxInputOverrideAId ||
          l.accountId === taxInputOverrideBId,
      );
      expect(taxLines).toHaveLength(2);
    });
  });

  describe("post()-time deterministic-destination and active-account re-validation", () => {
    it("blocks posting when a tax line has no resolved tax account (no code override, no singleton configured) — 422", async () => {
      const adminNoTax = tokenFor(tenantAId, legalEntityNoTaxSettingsId, [
        "finance.admin",
      ]);
      const posterNoTax = tokenFor(tenantAId, legalEntityNoTaxSettingsId, [
        "finance.poster",
      ]);
      const expenseNoTax = await createAccount(adminNoTax, {
        code: `T5B-EXP-${suffix}`,
        name: "Expense (no-tax entity)",
        type: "EXPENSE",
      });
      const supplierNoTax = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set("Authorization", `Bearer ${adminNoTax}`)
        .send({ code: `T5BSUPP-${suffix}`, name: "No-tax Supplier" })
        .expect(201);
      const codeNoTax = await createTaxCode(
        adminNoTax,
        `T5B-STD-${suffix}`,
        500,
      );

      const bill = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set("Authorization", `Bearer ${posterNoTax}`)
        .send({
          supplierId: supplierNoTax.body.data.id,
          supplierBillNumber: `SBN-${randomUUID().slice(0, 8)}`,
          billDate: "2026-04-01",
          lines: [
            {
              accountId: expenseNoTax,
              amountMinor: 10000,
              taxCodeId: codeNoTax,
            },
          ],
        })
        .expect(201);
      // Resolved with no override and no singleton -> null.
      expect(bill.body.data.lines[0].resolvedTaxAccountId).toBeNull();

      await postDocument(posterNoTax, "bills", bill.body.data.id, 422);
    });

    it("blocks posting when the resolved tax account was archived between draft resolution and posting — 422", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const toArchive = await createAccount(admin, {
        code: `T5-ARCPOST-${suffix}`,
        name: "Will be archived before posting",
        type: "ASSET",
      });
      const code = await createTaxCode(admin, `T5-ARCPOSTCODE-${suffix}`, 500);
      await setGlAccounts(admin, code, { apTaxAccountId: toArchive }).expect(
        200,
      );

      const bill = await createBill(poster, "2026-04-01", [
        { accountId: expenseAccountId, amountMinor: 10000, taxCodeId: code },
      ]);
      expect(bill.lines[0].resolvedTaxAccountId).toBe(toArchive);

      await archiveAccount(admin, toArchive);
      await postDocument(poster, "bills", bill.id, 422);
    });
  });

  describe("VAT Position Report — additive multi-account GL cross-check", () => {
    it("outputTaxAccounts/inputTaxAccounts reports each distinct resolved account separately, reconciled against actual journal movement", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);

      const invoice = await createInvoice(poster, "2026-05-01", [
        {
          accountId: revenueAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 500,
        },
        {
          accountId: revenueAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideBId,
          taxAmountMinor: 900,
        },
      ]);
      await postDocument(poster, "invoices", invoice.id);

      const bill = await createBill(poster, "2026-05-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeOverrideAId,
          taxAmountMinor: 400,
        },
      ]);
      await postDocument(poster, "bills", bill.id);

      const res = await vatPosition(admin, {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      }).expect(200);

      const { glCrossCheck } = res.body.meta;
      // Additive fields present without disturbing the pre-Phase-5
      // singleton fields' shape.
      expect(Array.isArray(glCrossCheck.outputTaxAccounts)).toBe(true);
      expect(Array.isArray(glCrossCheck.inputTaxAccounts)).toBe(true);
      expect(typeof glCrossCheck.taxOutputAccountId).toBe("string");
      expect(typeof glCrossCheck.taxInputAccountId).toBe("string");

      const outputA = glCrossCheck.outputTaxAccounts.find(
        (a: { accountId: string }) => a.accountId === taxOutputOverrideAId,
      );
      const outputB = glCrossCheck.outputTaxAccounts.find(
        (a: { accountId: string }) => a.accountId === taxOutputOverrideBId,
      );
      expect(outputA.sourceLineTaxMinor).toBe(500);
      expect(outputA.glMovementMinor).toBe(500);
      expect(outputA.reconciled).toBe(true);
      expect(outputB.sourceLineTaxMinor).toBe(900);
      expect(outputB.glMovementMinor).toBe(900);
      expect(outputB.reconciled).toBe(true);

      const inputA = glCrossCheck.inputTaxAccounts.find(
        (a: { accountId: string }) => a.accountId === taxInputOverrideAId,
      );
      expect(inputA.sourceLineTaxMinor).toBe(400);
      expect(inputA.glMovementMinor).toBe(400);
      expect(inputA.reconciled).toBe(true);
    });

    it("a tenant using only the singleton (no code overrides) still gets exactly one breakdown entry, matching the singleton fields", async () => {
      const admin = tokenFor(tenantAId, legalEntityId, ["finance.admin"]);
      const poster = tokenFor(tenantAId, legalEntityId, ["finance.poster"]);
      const bill = await createBill(poster, "2026-06-01", [
        {
          accountId: expenseAccountId,
          amountMinor: 10000,
          taxCodeId: taxCodeNoOverrideId,
          taxAmountMinor: 500,
        },
      ]);
      await postDocument(poster, "bills", bill.id);

      const res = await vatPosition(admin, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      }).expect(200);
      const { glCrossCheck } = res.body.meta;
      expect(glCrossCheck.inputTaxAccounts).toHaveLength(1);
      expect(glCrossCheck.inputTaxAccounts[0].accountId).toBe(
        taxInputSingletonId,
      );
      expect(glCrossCheck.inputTaxAccounts[0].sourceLineTaxMinor).toBe(
        glCrossCheck.glInputTaxMovementMinor,
      );
    });
  });
});
