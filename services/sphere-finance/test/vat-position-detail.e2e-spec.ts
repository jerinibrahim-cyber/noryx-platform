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
  sql,
} from "@noryx/db-core";
import {
  closeDb as closeFinanceDb,
  withTenant,
  type TxClient,
} from "../src/db/db";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import {
  TaxReportsService,
  type VatPositionDetailRow,
} from "../src/tax-reports/tax-reports.service";
import { REPORT_TX_CONFIG } from "../src/general-ledger/general-ledger.service";

/**
 * Tax/VAT Phase 7 — VAT Position Detail / Source-Document Drill-Down
 * (docs/work-items/tax-vat-phase-7-vat-position-detail-drill-down/
 * CONTRACT.md, ACCEPTANCE.md). Every account, tax code/rate,
 * customer/supplier, invoice/credit-note/bill/debit-note/manual-journal
 * used here is created and posted through the real HTTP API, never
 * inserted directly — same discipline vat-position-report.e2e-spec.ts
 * and every other Finance e2e suite in this codebase follows.
 *
 * `it` titles reference the ACCEPTANCE.md scenario ID(s) they exercise.
 * Not every one of ACCEPTANCE.md's 40 scenarios has a dedicated test
 * below — this suite prioritizes the accounting-correctness invariants
 * (polarity, reversal handling per source type, isolation, reconciliation,
 * ordering) and the two behavioral corrections from the hardening pass
 * (DRILL-032, DRILL-039); the completion report states plainly which
 * scenarios this file exercises directly, which are covered indirectly
 * by an existing e2e suite this file's route also touches (e.g.
 * RBAC/guard wiring, shared with every other controller in this
 * service), and which remain NOT EXECUTED.
 */
describe("VAT Position Detail / Source-Document Drill-Down (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let service: TaxReportsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let servicePrivate: any;
  let suffix: number;

  let tenantAId: string;
  let tenantBId: string;
  let legalEntityA1Id: string;
  let legalEntityA2Id: string;
  let legalEntityBId: string;

  let revenueAccountA1Id: string;
  let taxOutputAccountA1Id: string;
  let expenseAccountA1Id: string;
  let taxInputAccountA1Id: string;
  let manualAccountA1Id: string;
  let manualAccountA1CounterId: string;

  let customerA1Id: string;
  let supplierA1Id: string;
  let widePeriodId: string;

  let taxCodeStandardId: string;
  let taxCodeSecondId: string;

  function tokenFor(
    roles: string[],
    tenantId: string = tenantAId,
    legalEntityId: string | null = legalEntityA1Id,
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
      .send({ rateBasisPoints: 500, effectiveFrom: "2020-01-01" })
      .expect(201);
    return taxCodeId;
  }

  async function createAndPostInvoice(
    token: string,
    invoiceDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ): Promise<{ id: string; journalEntryId: string }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId: customerA1Id, invoiceDate, lines })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      journalEntryId: posted.body.data.journalEntryId,
    };
  }

  async function createAndPostCreditNote(
    token: string,
    creditNoteDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
    invoiceId: string,
    allocatedAmountMinor: number,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/credit-notes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customerA1Id,
        creditNoteDate,
        lines,
        allocations: [{ invoiceId, allocatedAmountMinor }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/credit-notes/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  async function createAndPostBill(
    token: string,
    billDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplierA1Id,
        supplierBillNumber: `SBN-${randomUUID().slice(0, 8)}`,
        billDate,
        lines,
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return {
      id: posted.body.data.id,
      totalMinor: posted.body.data.totalMinor,
    };
  }

  async function createAndPostDebitNote(
    token: string,
    debitNoteDate: string,
    lines: Array<{
      accountId: string;
      amountMinor: number;
      taxCodeId?: string;
      taxAmountMinor?: number;
    }>,
    billId: string,
    allocatedAmountMinor: number,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/debit-notes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplierA1Id,
        debitNoteDate,
        lines,
        allocations: [{ billId, allocatedAmountMinor }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/debit-notes/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  async function reverseDocument(
    token: string,
    resource: string,
    id: string,
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/${resource}/${id}/reverse`)
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(201);
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
    const created = await request(app.getHttpServer())
      .post("/v1/finance/journal-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate, lines })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return created.body.data.id;
  }

  async function reverseJournalEntry(
    token: string,
    id: string,
    transactionDate: string,
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/journal-entries/${id}/reverse`)
      .set("Authorization", `Bearer ${token}`)
      .send({ transactionDate })
      .expect(201);
  }

  function vatPositionDetail(token: string, query: Record<string, unknown>) {
    return request(app.getHttpServer())
      .get("/v1/finance/tax-reports/vat-position-detail")
      .set("Authorization", `Bearer ${token}`)
      .query(query as Record<string, string>);
  }

  function vatPosition(token: string, query: Record<string, unknown>) {
    return request(app.getHttpServer())
      .get("/v1/finance/tax-reports/vat-position")
      .set("Authorization", `Bearer ${token}`)
      .query(query as Record<string, string>);
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

    service = app.get(TaxReportsService);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    servicePrivate = service as any;

    jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

    const platformDb = getPlatformDb();
    suffix = Date.now();
    const [tenantA] = await platformDb
      .insert(tenants)
      .values({ slug: `vat-det-e2e-a-${suffix}`, name: "VAT Detail E2E A" })
      .returning();
    const [tenantB] = await platformDb
      .insert(tenants)
      .values({ slug: `vat-det-e2e-b-${suffix}`, name: "VAT Detail E2E B" })
      .returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;

    const [entityA1] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "VAT Detail A — Entity 1",
        code: "VATDETA1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    const [entityA2] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantAId,
        name: "VAT Detail A — Entity 2",
        code: "VATDETA2",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: false,
      })
      .returning();
    const [entityB] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId: tenantBId,
        name: "VAT Detail B — Entity 1",
        code: "VATDETB1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityA1Id = entityA1!.id;
    legalEntityA2Id = entityA2!.id;
    legalEntityBId = entityB!.id;

    const adminA1 = tokenFor(["finance.admin"]);

    revenueAccountA1Id = await createAccount(adminA1, {
      code: "VD-REV",
      name: "Revenue",
      type: "REVENUE",
    });
    const arControlAccountA1Id = await createAccount(adminA1, {
      code: "VD-AR",
      name: "AR Control",
      type: "ASSET",
    });
    taxOutputAccountA1Id = await createAccount(adminA1, {
      code: "VD-TAXOUT",
      name: "Tax Output",
      type: "LIABILITY",
    });
    expenseAccountA1Id = await createAccount(adminA1, {
      code: "VD-EXP",
      name: "Expense",
      type: "EXPENSE",
    });
    const apControlAccountA1Id = await createAccount(adminA1, {
      code: "VD-AP",
      name: "AP Control",
      type: "LIABILITY",
    });
    taxInputAccountA1Id = await createAccount(adminA1, {
      code: "VD-TAXIN",
      name: "Tax Input",
      type: "ASSET",
    });
    manualAccountA1Id = await createAccount(adminA1, {
      code: "VD-MANUAL",
      name: "Manual Journal Suspense",
      type: "EXPENSE",
    });
    manualAccountA1CounterId = await createAccount(adminA1, {
      code: "VD-MANUAL-CTR",
      name: "Manual Journal Suspense Counter",
      type: "LIABILITY",
    });

    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        arControlAccountId: arControlAccountA1Id,
        taxOutputAccountId: taxOutputAccountA1Id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        apControlAccountId: apControlAccountA1Id,
        taxInputAccountId: taxInputAccountA1Id,
      })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({ code: `VDCUST-${suffix}`, name: "VAT Detail Customer" })
      .expect(201);
    customerA1Id = customer.body.data.id;

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({ code: `VDSUPP-${suffix}`, name: "VAT Detail Supplier" })
      .expect(201);
    supplierA1Id = supplier.body.data.id;

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminA1}`)
      .send({
        code: `VD-PERIOD-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      })
      .expect(201);
    widePeriodId = period.body.data.id;

    taxCodeStandardId = await createTaxCode(adminA1, `VD-STD-${suffix}`);
    taxCodeSecondId = await createTaxCode(adminA1, `VD-STD2-${suffix}`);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  describe("Source-Line Granularity and Every Source Type (DRILL-001/002/003)", () => {
    it("returns one row per tax-tagged source line, across all five source types, never collapsed by document or tax code", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-01";

      const invoice = await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 500,
        },
        {
          accountId: revenueAccountA1Id,
          amountMinor: 20000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 1000,
        },
      ]);
      const bill = await createAndPostBill(poster, date, [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 5000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 250,
        },
      ]);
      const debitNote = await createAndPostDebitNote(
        poster,
        date,
        [
          {
            accountId: expenseAccountA1Id,
            amountMinor: 1000,
            taxCodeId: taxCodeStandardId,
            taxAmountMinor: 50,
          },
        ],
        bill.id,
        1050,
      );
      const creditNote = await createAndPostCreditNote(
        poster,
        date,
        [
          {
            accountId: revenueAccountA1Id,
            amountMinor: 2000,
            taxCodeId: taxCodeStandardId,
            taxAmountMinor: 100,
          },
        ],
        invoice.id,
        2100,
      );
      await createAndPostManualJournal(poster, date, [
        {
          accountId: manualAccountA1Id,
          debitMinor: 0,
          creditMinor: 300,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
        {
          accountId: manualAccountA1CounterId,
          debitMinor: 300,
          creditMinor: 0,
        },
      ]);

      const res = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);

      const rows: VatPositionDetailRow[] = res.body.data.rows;
      // DRILL-001/002 — the two-line invoice contributes exactly two
      // rows, never one row per document or one row per shared tax code.
      const invoiceRows = rows.filter(
        (r) => r.sourceType === "CUSTOMER_INVOICE",
      );
      expect(invoiceRows).toHaveLength(2);

      // DRILL-003 — every one of the five source types is independently
      // represented at least once.
      const sourceTypes = new Set(rows.map((r) => r.sourceType));
      expect(sourceTypes).toEqual(
        new Set([
          "SUPPLIER_BILL",
          "SUPPLIER_DEBIT_NOTE",
          "CUSTOMER_INVOICE",
          "CUSTOMER_CREDIT_NOTE",
          "MANUAL_JOURNAL",
        ]),
      );

      void debitNote;
      void creditNote;
    });
  });

  describe("INPUT/OUTPUT Direction and Polarity (DRILL-006/007/008/009/010/011)", () => {
    it("assigns correct direction and signed contribution per source type", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-05";

      const invoice = await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 10000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 500,
        },
      ]);
      await createAndPostCreditNote(
        poster,
        date,
        [
          {
            accountId: revenueAccountA1Id,
            amountMinor: 2000,
            taxCodeId: taxCodeStandardId,
            taxAmountMinor: 100,
          },
        ],
        invoice.id,
        2100,
      );

      const bill = await createAndPostBill(poster, date, [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 5000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 250,
        },
      ]);
      await createAndPostDebitNote(
        poster,
        date,
        [
          {
            accountId: expenseAccountA1Id,
            amountMinor: 1000,
            taxCodeId: taxCodeStandardId,
            taxAmountMinor: 50,
          },
        ],
        bill.id,
        1050,
      );

      await createAndPostManualJournal(poster, date, [
        {
          accountId: manualAccountA1Id,
          debitMinor: 0,
          creditMinor: 300,
          taxCodeId: taxCodeStandardId,
          taxDirection: "OUTPUT",
        },
        { accountId: manualAccountA1CounterId, debitMinor: 300, creditMinor: 0 },
      ]);
      await createAndPostManualJournal(poster, date, [
        {
          accountId: manualAccountA1Id,
          debitMinor: 150,
          creditMinor: 0,
          taxCodeId: taxCodeStandardId,
          taxDirection: "INPUT",
        },
        { accountId: manualAccountA1CounterId, debitMinor: 0, creditMinor: 150 },
      ]);

      const res = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      const rows: VatPositionDetailRow[] = res.body.data.rows;

      const byType = (t: string) => rows.filter((r) => r.sourceType === t);

      expect(byType("CUSTOMER_INVOICE")[0]!.direction).toBe("OUTPUT");
      expect(byType("CUSTOMER_INVOICE")[0]!.signedTaxContributionMinor).toBe(
        500,
      );
      expect(byType("CUSTOMER_CREDIT_NOTE")[0]!.direction).toBe("OUTPUT");
      expect(
        byType("CUSTOMER_CREDIT_NOTE")[0]!.signedTaxContributionMinor,
      ).toBe(-100);

      expect(byType("SUPPLIER_BILL")[0]!.direction).toBe("INPUT");
      expect(byType("SUPPLIER_BILL")[0]!.signedTaxContributionMinor).toBe(250);
      expect(byType("SUPPLIER_DEBIT_NOTE")[0]!.direction).toBe("INPUT");
      expect(
        byType("SUPPLIER_DEBIT_NOTE")[0]!.signedTaxContributionMinor,
      ).toBe(-50);

      const manualRows = byType("MANUAL_JOURNAL");
      const manualOutput = manualRows.find((r) => r.direction === "OUTPUT")!;
      const manualInput = manualRows.find((r) => r.direction === "INPUT")!;
      expect(manualOutput.signedTaxContributionMinor).toBe(300);
      expect(manualInput.signedTaxContributionMinor).toBe(150);
    });
  });

  describe("Reversal Handling — AP/AR exclusion vs. manual journal inclusion (DRILL-012/013/014/015)", () => {
    it("excludes a reversed AP/AR document entirely, but includes both sides of a reversed manual journal", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-10";

      const bill = await createAndPostBill(poster, date, [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 4000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 200,
        },
      ]);
      const otherBill = await createAndPostBill(poster, date, [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);
      await reverseDocument(poster, "bills", bill.id);

      const manualId = await createAndPostManualJournal(poster, date, [
        {
          accountId: manualAccountA1Id,
          debitMinor: 0,
          creditMinor: 400,
          taxCodeId: taxCodeSecondId,
          taxDirection: "OUTPUT",
        },
        { accountId: manualAccountA1CounterId, debitMinor: 400, creditMinor: 0 },
      ]);
      await reverseJournalEntry(poster, manualId, date);

      const res = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      const rows: VatPositionDetailRow[] = res.body.data.rows;

      // DRILL-014/015 — the reversed bill contributes zero rows; the
      // unrelated, non-reversed bill still appears.
      const billRows = rows.filter((r) => r.sourceType === "SUPPLIER_BILL");
      expect(billRows).toHaveLength(1);
      expect(billRows[0]!.signedTaxContributionMinor).toBe(50);
      void otherBill;

      // DRILL-012/013 — both the original and reversal manual journal
      // lines appear as independent rows, netting exactly to zero.
      const manualRows = rows.filter(
        (r) =>
          r.sourceType === "MANUAL_JOURNAL" && r.taxCodeId === taxCodeSecondId,
      );
      expect(manualRows).toHaveLength(2);
      const netManual = manualRows.reduce(
        (sum, r) => sum + r.signedTaxContributionMinor,
        0,
      );
      expect(netManual).toBe(0);

      const reconTotal = (
        res.body.data.reconciliationTotals as Array<{
          taxCodeId: string;
          direction: string;
          netTaxContributionMinor: number;
        }>
      ).find(
        (t) => t.taxCodeId === taxCodeSecondId && t.direction === "OUTPUT",
      );
      expect(reconTotal?.netTaxContributionMinor ?? 0).toBe(0);
    });
  });

  describe("Untagged-Line Exclusion (DRILL-016/017)", () => {
    it("excludes lines with no taxCodeId, on both an AP/AR document and a manual journal", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-12";

      await createAndPostBill(poster, date, [
        { accountId: expenseAccountA1Id, amountMinor: 1000 },
      ]);
      await createAndPostManualJournal(poster, date, [
        { accountId: manualAccountA1Id, debitMinor: 500, creditMinor: 0 },
        { accountId: manualAccountA1CounterId, debitMinor: 0, creditMinor: 500 },
      ]);

      const res = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      expect(res.body.data.rows).toHaveLength(0);
      expect(res.body.meta.totalItems).toBe(0);
    });
  });

  describe("Tax-Code Filtering (DRILL-004/005)", () => {
    it("narrows to one taxCodeId when supplied, returns all codes when omitted", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-15";

      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);
      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 2000,
          taxCodeId: taxCodeSecondId,
          taxAmountMinor: 100,
        },
      ]);

      const filtered = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        taxCodeId: taxCodeStandardId,
        pageSize: 200,
      }).expect(200);
      expect(
        (filtered.body.data.rows as VatPositionDetailRow[]).every(
          (r) => r.taxCodeId === taxCodeStandardId,
        ),
      ).toBe(true);
      expect(filtered.body.data.reconciliationTotals).toHaveLength(1);

      const unfiltered = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      const codes = new Set(
        (unfiltered.body.data.rows as VatPositionDetailRow[]).map(
          (r) => r.taxCodeId,
        ),
      );
      expect(codes.has(taxCodeStandardId)).toBe(true);
      expect(codes.has(taxCodeSecondId)).toBe(true);
    });
  });

  describe("Deterministic Ordering (DRILL-026/027, Correction 1)", () => {
    it("orders by sourceDocumentDate ASC, sourceType ASC, sourceLineId ASC — byte-identical across repeated requests", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-20";

      await createAndPostBill(poster, date, [
        {
          accountId: expenseAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);
      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);

      const res1 = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      const res2 = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);

      expect(res1.body.data.rows).toEqual(res2.body.data.rows);

      const rows: VatPositionDetailRow[] = res1.body.data.rows;
      const sameDateRows = rows.filter(
        (r) => r.sourceDocumentDate === date,
      );
      // Same-date rows are grouped by sourceType in ascending
      // (alphabetical) order — CUSTOMER_INVOICE before SUPPLIER_BILL.
      const typeOrder = sameDateRows.map((r) => r.sourceType);
      const sortedTypeOrder = [...typeOrder].sort();
      expect(typeOrder).toEqual(sortedTypeOrder);
    });
  });

  describe("Pagination Correctness and Metadata (DRILL-028/029/030/031)", () => {
    it("pages partition the complete result with no gaps/duplicates, and reject invalid page/pageSize", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-02-25";

      for (let i = 0; i < 3; i++) {
        await createAndPostInvoice(poster, date, [
          {
            accountId: revenueAccountA1Id,
            amountMinor: 1000,
            taxCodeId: taxCodeStandardId,
            taxAmountMinor: 50,
          },
        ]);
      }

      const full = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      const totalItems = full.body.meta.totalItems;
      expect(totalItems).toBeGreaterThanOrEqual(3);

      const page1 = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        page: 1,
        pageSize: 2,
      }).expect(200);
      const page2 = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        page: 2,
        pageSize: 2,
      }).expect(200);

      const ids1 = (page1.body.data.rows as VatPositionDetailRow[]).map(
        (r) => r.sourceLineId,
      );
      const ids2 = (page2.body.data.rows as VatPositionDetailRow[]).map(
        (r) => r.sourceLineId,
      );
      expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
      expect(page1.body.meta.totalPages).toBe(Math.ceil(totalItems / 2));

      await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        page: 0,
      }).expect(400);
      await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 0,
      }).expect(400);
      await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 201,
      }).expect(400);
    });
  });

  describe("Zero-Result Behavior (DRILL-040)", () => {
    it("returns 200 with empty rows/reconciliationTotals and totalItems 0 for a scope with no activity", async () => {
      const poster = tokenFor(["finance.poster"]);
      const res = await vatPositionDetail(poster, {
        dateFrom: "2019-01-01",
        dateTo: "2019-01-02",
      }).expect(200);
      expect(res.body.data.rows).toEqual([]);
      expect(res.body.data.reconciliationTotals).toEqual([]);
      expect(res.body.meta.totalItems).toBe(0);
      expect(res.body.meta.totalPages).toBe(0);
    });
  });

  describe("Same-Snapshot Reconciliation and Correction 3's partial-page distinction (DRILL-033/039)", () => {
    it("reconciliationTotals equals the complete filtered result, not merely the returned page", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-03-01";
      const taxCode = await createTaxCode(tokenFor(["finance.admin"]), `VD-P39-${suffix}`);

      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCode,
          taxAmountMinor: 100,
        },
      ]);
      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCode,
          taxAmountMinor: 250,
        },
      ]);
      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCode,
          taxAmountMinor: 400,
        },
      ]);

      // DRILL-033 — pageSize covering the complete result: page sum
      // equals reconciliationTotals exactly.
      const full = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        taxCodeId: taxCode,
        pageSize: 200,
      }).expect(200);
      const fullSum = (full.body.data.rows as VatPositionDetailRow[]).reduce(
        (s, r) => s + r.signedTaxContributionMinor,
        0,
      );
      const fullReconTotal = (
        full.body.data.reconciliationTotals as Array<{
          netTaxContributionMinor: number;
        }>
      )![0]!.netTaxContributionMinor;
      expect(fullSum).toBe(750);
      expect(fullReconTotal).toBe(750);

      // DRILL-039 (Correction 3) — a deliberately small pageSize: the
      // single returned page's sum must NOT equal reconciliationTotals,
      // while reconciliationTotals still equals the complete result.
      const partial = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        taxCodeId: taxCode,
        page: 1,
        pageSize: 1,
      }).expect(200);
      const partialPageSum = (
        partial.body.data.rows as VatPositionDetailRow[]
      ).reduce((s, r) => s + r.signedTaxContributionMinor, 0);
      const partialReconTotal = (
        partial.body.data.reconciliationTotals as Array<{
          netTaxContributionMinor: number;
        }>
      )![0]!.netTaxContributionMinor;
      expect(partial.body.data.rows).toHaveLength(1);
      expect(partialPageSum).not.toBe(750);
      expect(partialReconTotal).toBe(750);
    });
  });

  describe("Regression against the existing VAT Position Report (DRILL-034)", () => {
    it("reconciliationTotals agrees with the aggregate report's netTaxMinor/manualTaxMinor for an identical scope", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-03-05";
      const taxCode = await createTaxCode(
        tokenFor(["finance.admin"]),
        `VD-P34-${suffix}`,
      );

      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCode,
          taxAmountMinor: 120,
        },
      ]);
      await createAndPostManualJournal(poster, date, [
        {
          accountId: manualAccountA1Id,
          debitMinor: 0,
          creditMinor: 30,
          taxCodeId: taxCode,
          taxDirection: "OUTPUT",
        },
        { accountId: manualAccountA1CounterId, debitMinor: 30, creditMinor: 0 },
      ]);

      const detail = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        taxCodeId: taxCode,
        pageSize: 200,
      }).expect(200);
      const aggregate = await vatPosition(poster, {
        dateFrom: date,
        dateTo: date,
      }).expect(200);

      const reconOutput = (
        detail.body.data.reconciliationTotals as Array<{
          direction: string;
          netTaxContributionMinor: number;
        }>
      ).find((t) => t.direction === "OUTPUT")!.netTaxContributionMinor;

      const aggregateRow = (
        aggregate.body.data.outputByTaxCode as Array<{
          taxCodeId: string;
          netTaxMinor: number;
        }>
      ).find((r) => r.taxCodeId === taxCode)!;

      expect(reconOutput).toBe(150);
      expect(aggregateRow.netTaxMinor).toBe(150);
      expect(reconOutput).toBe(aggregateRow.netTaxMinor);
    });
  });

  describe("Tenant and Legal-Entity Isolation (DRILL-022/023)", () => {
    it("never leaks another tenant's or another legal entity's tax-tagged activity", async () => {
      const date = "2026-03-10";
      const posterA1 = tokenFor(["finance.poster"]);
      await createAndPostInvoice(posterA1, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);

      const viewerA2 = tokenFor(["finance.viewer"], tenantAId, legalEntityA2Id);
      const resA2 = await vatPositionDetail(viewerA2, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      expect(
        (resA2.body.data.rows as VatPositionDetailRow[]).some(
          (r) => r.sourceDocumentDate === date,
        ),
      ).toBe(false);

      const viewerB = tokenFor(["finance.viewer"], tenantBId, legalEntityBId);
      const resB = await vatPositionDetail(viewerB, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      expect(resB.body.data.rows).toEqual([]);
    });
  });

  describe("RBAC and Validation (DRILL-024/025/036/037)", () => {
    it("allows all three finance roles, rejects unauthenticated/unauthorized, validates taxCodeId", async () => {
      const date = "2026-03-15";
      for (const role of ["finance.viewer", "finance.poster", "finance.admin"]) {
        await vatPositionDetail(tokenFor([role]), {
          dateFrom: date,
          dateTo: date,
        }).expect(200);
      }

      await request(app.getHttpServer())
        .get("/v1/finance/tax-reports/vat-position-detail")
        .query({ dateFrom: date, dateTo: date })
        .expect(401);

      await vatPositionDetail(tokenFor(["identity.viewer"]), {
        dateFrom: date,
        dateTo: date,
      }).expect(403);

      // DRILL-036 — syntactically invalid taxCodeId.
      await vatPositionDetail(tokenFor(["finance.poster"]), {
        dateFrom: date,
        dateTo: date,
        taxCodeId: "not-a-uuid",
      }).expect(400);

      // DRILL-037 (corrected to 404 — see CONTRACT.md/completion report)
      // — a well-formed but nonexistent taxCodeId.
      await vatPositionDetail(tokenFor(["finance.poster"]), {
        dateFrom: date,
        dateTo: date,
        taxCodeId: randomUUID(),
      }).expect(404);

      // Window required.
      await vatPositionDetail(tokenFor(["finance.poster"]), {}).expect(400);
      // periodId XOR dateFrom/dateTo.
      await vatPositionDetail(tokenFor(["finance.poster"]), {
        periodId: widePeriodId,
        dateFrom: date,
      }).expect(400);
    });
  });

  describe("Behavioral Consistent-Read Semantics (DRILL-032, Correction 2)", () => {
    it("a concurrent commit between two statements of the SAME transaction is invisible to that transaction, but visible to a new one", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-03-20";
      const taxCode = await createTaxCode(
        tokenFor(["finance.admin"]),
        `VD-P32-${suffix}`,
      );

      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCode,
          taxAmountMinor: 50,
        },
      ]);

      // Session A: begin the exact REPORT_TX_CONFIG transaction the
      // shipped service uses, reusing its own private union/count
      // helpers directly (never duplicated SQL) — mirrors
      // general-ledger-concurrency.e2e-spec.ts's established mechanism.
      const { before, after } = await withTenant(
        tenantAId,
        async (tx: TxClient) => {
          const unionSql = servicePrivate.detailUnionSql(
            tenantAId,
            legalEntityA1Id,
            date,
            date,
          );
          const filterSql = sql`WHERE d.tax_code_id = ${taxCode}`;

          const before = await servicePrivate.countDetailRows(
            tx,
            unionSql,
            filterSql,
          );

          // Session B: a genuinely independent, concurrently committed
          // write via the real HTTP API — a second tax-tagged invoice
          // for the identical scope, landing squarely inside Session
          // A's still-open transaction.
          await createAndPostInvoice(poster, date, [
            {
              accountId: revenueAccountA1Id,
              amountMinor: 1000,
              taxCodeId: taxCode,
              taxAmountMinor: 75,
            },
          ]);

          const after = await servicePrivate.countDetailRows(
            tx,
            unionSql,
            filterSql,
          );
          return { before, after };
        },
        undefined,
        REPORT_TX_CONFIG,
      );

      // DRILL-032 — Session A's second read, inside the SAME
      // transaction, does not see Session B's concurrently committed
      // row: the snapshot was pinned at first read.
      expect(before).toBe(1);
      expect(after).toBe(1);

      // Contrast: a genuinely NEW request (new transaction) DOES see it.
      const fresh = await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        taxCodeId: taxCode,
        pageSize: 200,
      }).expect(200);
      expect(fresh.body.data.rows).toHaveLength(2);
    });
  });

  describe("No Mutation (DRILL-038)", () => {
    it("querying the detail endpoint, including an error-path query, writes nothing", async () => {
      const poster = tokenFor(["finance.poster"]);
      const date = "2026-03-25";
      await createAndPostInvoice(poster, date, [
        {
          accountId: revenueAccountA1Id,
          amountMinor: 1000,
          taxCodeId: taxCodeStandardId,
          taxAmountMinor: 50,
        },
      ]);

      const countInvoiceLines = () =>
        withTenant(tenantAId, async (tx: TxClient) => {
          const rows = await tx.execute(sql`
            SELECT COUNT(*) AS total FROM customer_invoice_lines
            WHERE tenant_id = ${tenantAId}
          `);
          return (rows as unknown as Array<{ total: string }>)[0]!.total;
        });

      const before = await countInvoiceLines();

      await vatPositionDetail(poster, {
        dateFrom: date,
        dateTo: date,
        pageSize: 200,
      }).expect(200);
      await vatPositionDetail(poster, { page: -1 }).expect(400);

      const after = await countInvoiceLines();

      expect(after).toBe(before);
    });
  });
});
