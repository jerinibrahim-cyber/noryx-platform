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
  asc,
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
 * Document-Level Reversal for Posted AP & AR Documents
 * (docs/finance-work-item-document-reversal-proposal.md, CTO-approved
 * implementation authorization).
 *
 * Covers all six document types — Supplier Bills, Supplier Debit Notes,
 * Customer Invoices, Customer Credit Notes, Supplier Payments, Customer
 * Receipts — via one parameterized `DOC_TYPES` table so that every
 * generic assertion (successful reversal, state derivation, repeated-
 * reversal rejection, source immutability, accounting polarity, RBAC)
 * runs identically against all six, rather than testing one AP/one AR
 * representative and asserting symmetry only in prose (CTO's explicit
 * instruction). Type-specific behavior — target-document allocation
 * safety (G) vs. settlement-document allocation unwind (H), and tax/
 * account preservation (F, line-bearing types only) — is scoped with an
 * explicit `kind`/`hasTax` flag on each entry, never silently skipped.
 *
 * Atomic-rollback (I), concurrent-reversal safety (L), and the banking
 * interaction (M) are exercised on representative types only (Supplier
 * Bill + Supplier Payment) — deliberately: those guarantees are
 * inherited from `JournalEntriesService`'s own already-proven
 * atomicity/concurrency/GL infrastructure (reused, not reimplemented,
 * per proposal §15/§18) rather than being novel per-document-type
 * behavior. Disclosed in the completion report.
 */
describe("Document-Level Reversal for Posted AP & AR Documents (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let revenueAccountId: string;
  let apControlAccountId: string;
  let arControlAccountId: string;
  let taxInputAccountId: string;
  let taxOutputAccountId: string;
  let bankCashAccountId: string;
  let supplierId: string;
  let customerId: string;
  let suffix: number;
  let posterToken: string;
  let viewerToken: string;
  let adminToken: string;
  // The `sub` claim baked into `posterToken` at creation time (fixed for
  // the whole suite) — the exact `actorUserId` every reverse() call in
  // this file is expected to have written into its audit rows.
  let posterUserId: string;

  // Wide open period so the suite is independent of wall-clock date;
  // a narrow CLOSED period is used to force the atomic-rollback (I)
  // failure deterministically.
  const CLOSED_PERIOD_DATE = "2019-06-15";

  function tokenFor(roles: string[], userId?: string) {
    return jwt.sign({
      sub: userId ?? randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  function auth(token: string) {
    return ["Authorization", `Bearer ${token}`] as [string, string];
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
    const [tenant] = await platformDb
      .insert(tenants)
      .values({ slug: `reversal-e2e-${suffix}`, name: "Reversal E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Reversal E2E Entity",
        code: `REV1-${suffix}`,
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    posterToken = tokenFor(["finance.poster"]);
    viewerToken = tokenFor(["finance.viewer"]);
    adminToken = tokenFor(["finance.admin"]);
    posterUserId = (jwt.decode(posterToken) as { sub: string }).sub;

    const financeDb = getFinanceDb();
    const [exp] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-EXP-${suffix}`,
        name: "Expense",
        type: "EXPENSE",
      })
      .returning();
    const [rev] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-REV-${suffix}`,
        name: "Revenue",
        type: "REVENUE",
      })
      .returning();
    const [apCtrl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-APCTRL-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [arCtrl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-ARCTRL-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    const [taxIn] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-TAXIN-${suffix}`,
        name: "Input VAT",
        type: "ASSET",
      })
      .returning();
    const [taxOut] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-TAXOUT-${suffix}`,
        name: "Output VAT",
        type: "ASSET",
      })
      .returning();
    const [bankCash] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `REV-BANK-${suffix}`,
        name: "Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = exp!.id;
    revenueAccountId = rev!.id;
    apControlAccountId = apCtrl!.id;
    arControlAccountId = arCtrl!.id;
    taxInputAccountId = taxIn!.id;
    taxOutputAccountId = taxOut!.id;
    bankCashAccountId = bankCash!.id;

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set(...auth(adminToken))
      .send({ apControlAccountId, taxInputAccountId })
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set(...auth(adminToken))
      .send({ arControlAccountId, taxOutputAccountId })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set(...auth(adminToken))
      .send({ code: `REV-SUP-${suffix}`, name: "Reversal Test Supplier" })
      .expect(201);
    supplierId = supplier.body.data.id;

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set(...auth(adminToken))
      .send({ code: `REV-CUST-${suffix}`, name: "Reversal Test Customer" })
      .expect(201);
    customerId = customer.body.data.id;

    // Wide open period — independent of wall-clock date.
    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set(...auth(adminToken))
      .send({
        code: `REV-OPEN-${suffix}`,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      })
      .expect(201);

    // A separate, CLOSED period — used only to force a deterministic
    // reverse() failure for the atomic-rollback (I) tests.
    const closed = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set(...auth(adminToken))
      .send({
        code: `REV-CLOSED-${suffix}`,
        startDate: "2019-01-01",
        endDate: "2019-12-31",
      })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/v1/finance/accounting-periods/${closed.body.data.id}/close`)
      .set(...auth(adminToken))
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  // -------------------------------------------------------------------
  // Document creation helpers — each creates a DRAFT then posts it,
  // returning the posted GET representation (including the additive
  // `reversal` field, always null at this point).
  // -------------------------------------------------------------------

  function uniq(label: string): string {
    return `${label}-${suffix}-${randomUUID().slice(0, 8)}`;
  }

  async function createPostedBill(
    amountMinor: number,
    taxAmountMinor = 0,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set(...auth(posterToken))
      .send({
        supplierId,
        supplierBillNumber: uniq("BILL"),
        billDate: "2026-03-01",
        lines: [{ accountId: expenseAccountId, amountMinor, taxAmountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/bills/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/bills/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function createPostedInvoice(
    amountMinor: number,
    taxAmountMinor = 0,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set(...auth(posterToken))
      .send({
        customerId,
        invoiceDate: "2026-03-01",
        lines: [{ accountId: revenueAccountId, amountMinor, taxAmountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/invoices/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function createPostedPayment(
    billId: string,
    amountMinor: number,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set(...auth(posterToken))
      .send({
        supplierId,
        paymentDate: "2026-03-05",
        paymentAmountMinor: amountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId,
        allocations: [{ billId, allocatedAmountMinor: amountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/payments/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function createPostedReceipt(
    invoiceId: string,
    amountMinor: number,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/receipts")
      .set(...auth(posterToken))
      .send({
        customerId,
        receiptDate: "2026-03-05",
        receiptAmountMinor: amountMinor,
        receiptMethod: "BANK_TRANSFER",
        bankCashAccountId,
        allocations: [{ invoiceId, allocatedAmountMinor: amountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/receipts/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/receipts/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function createPostedDebitNote(
    billId: string,
    amountMinor: number,
    taxAmountMinor = 0,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/debit-notes")
      .set(...auth(posterToken))
      .send({
        supplierId,
        debitNoteDate: "2026-03-05",
        lines: [
          {
            accountId: expenseAccountId,
            amountMinor: amountMinor - taxAmountMinor,
            taxAmountMinor,
          },
        ],
        allocations: [{ billId, allocatedAmountMinor: amountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/debit-notes/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/debit-notes/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function createPostedCreditNote(
    invoiceId: string,
    amountMinor: number,
    taxAmountMinor = 0,
  ): Promise<any> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/credit-notes")
      .set(...auth(posterToken))
      .send({
        customerId,
        creditNoteDate: "2026-03-05",
        lines: [
          {
            accountId: revenueAccountId,
            amountMinor: amountMinor - taxAmountMinor,
            taxAmountMinor,
          },
        ],
        allocations: [{ invoiceId, allocatedAmountMinor: amountMinor }],
      })
      .expect(201);
    const id = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/v1/finance/credit-notes/${id}/post`)
      .set(...auth(posterToken))
      .expect(200);
    const got = await request(app.getHttpServer())
      .get(`/v1/finance/credit-notes/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return got.body.data;
  }

  async function getDoc(resource: string, id: string): Promise<any> {
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/${resource}/${id}`)
      .set(...auth(posterToken))
      .expect(200);
    return res.body.data;
  }

  async function fetchJournalLines(journalEntryId: string) {
    return withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, journalEntryId))
        .orderBy(asc(journalLines.lineNumber)),
    );
  }

  async function fetchJournalEntry(journalEntryId: string) {
    return withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, journalEntryId))
        .then((rows) => rows[0]),
    );
  }

  /** Audit rows are written to the PLATFORM db (@noryx/db-core's
   * `auditLogs`), never the finance-tenant-scoped db — same distinction
   * ap-bill-concurrency.e2e-spec.ts's own audit assertions already rely
   * on. Ordered by `createdAt` so callers can assert exact write order
   * within a single reverse() transaction. */
  async function fetchAuditRows(entityType: string, entityId: string) {
    const platformDb = getPlatformDb();
    return platformDb
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.entityType, entityType),
          eq(auditLogs.entityId, entityId),
        ),
      )
      .orderBy(asc(auditLogs.createdAt));
  }

  // -------------------------------------------------------------------
  // DOC_TYPES — the symmetry table. Each `setup()` call creates a FRESH
  // document (and, for settlement types, a fresh target it settles
  // against) so every test starts from a clean, independent instance.
  // -------------------------------------------------------------------

  interface DocTypeConfig {
    name: string;
    resource: string;
    kind: "target" | "settlement";
    hasTax: boolean;
    // The exact `entityType` string each service's reverse() writes on
    // its own document-level audit row (confirmed against each
    // service's source, not assumed) — needed to query auditLogs.
    entityType: string;
    setup: () => Promise<{ doc: any; target?: any }>;
  }

  const DOC_TYPES: DocTypeConfig[] = [
    {
      name: "Supplier Bill",
      resource: "bills",
      kind: "target",
      hasTax: true,
      entityType: "supplier_bill",
      setup: async () => ({ doc: await createPostedBill(10000, 500) }),
    },
    {
      name: "Customer Invoice",
      resource: "invoices",
      kind: "target",
      hasTax: true,
      entityType: "customer_invoice",
      setup: async () => ({ doc: await createPostedInvoice(10000, 500) }),
    },
    {
      name: "Supplier Payment",
      resource: "payments",
      kind: "settlement",
      hasTax: false,
      entityType: "supplier_payment",
      setup: async () => {
        const bill = await createPostedBill(10000);
        const doc = await createPostedPayment(bill.id, bill.totalMinor);
        return { doc, target: bill };
      },
    },
    {
      name: "Customer Receipt",
      resource: "receipts",
      kind: "settlement",
      hasTax: false,
      entityType: "customer_receipt",
      setup: async () => {
        const invoice = await createPostedInvoice(10000);
        const doc = await createPostedReceipt(invoice.id, invoice.totalMinor);
        return { doc, target: invoice };
      },
    },
    {
      name: "Supplier Debit Note",
      resource: "debit-notes",
      kind: "settlement",
      hasTax: true,
      entityType: "supplier_debit_note",
      setup: async () => {
        const bill = await createPostedBill(10000);
        const doc = await createPostedDebitNote(
          bill.id,
          bill.totalMinor,
          Math.floor(bill.totalMinor * 0.05),
        );
        return { doc, target: bill };
      },
    },
    {
      name: "Customer Credit Note",
      resource: "credit-notes",
      kind: "settlement",
      hasTax: true,
      entityType: "customer_credit_note",
      setup: async () => {
        const invoice = await createPostedInvoice(10000);
        const doc = await createPostedCreditNote(
          invoice.id,
          invoice.totalMinor,
          Math.floor(invoice.totalMinor * 0.05),
        );
        return { doc, target: invoice };
      },
    },
  ];

  function targetResourceFor(cfg: DocTypeConfig): string {
    return cfg.resource === "payments" || cfg.resource === "debit-notes"
      ? "bills"
      : "invoices";
  }

  for (const cfg of DOC_TYPES) {
    describe(cfg.name, () => {
      it("(A/B) successful reversal: creates a linked reversal journal entry, document stays POSTED, GET surfaces the derived `reversal` field", async () => {
        const { doc } = await cfg.setup();

        const before = await getDoc(cfg.resource, doc.id);
        expect(before.reversal).toBeNull();
        expect(before.status).toBe("POSTED");

        const res = await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);

        // §16 — reversal state is never a status transition; the
        // document is always still POSTED.
        expect(res.body.data.status).toBe("POSTED");
        expect(res.body.data.reversal).not.toBeNull();
        expect(res.body.data.reversal.journalEntryId).toBeTruthy();
        expect(res.body.data.reversal.journalNumber).toBeTruthy();

        const after = await getDoc(cfg.resource, doc.id);
        expect(after.reversal.journalEntryId).toBe(
          res.body.data.reversal.journalEntryId,
        );

        // (B) — the derivation is genuinely read from
        // journal_entries.reversedByJournalEntryId, not a cached/stored
        // flag: confirm the FK chain directly.
        const originalJe = await fetchJournalEntry(doc.journalEntryId);
        if (!originalJe) throw new Error("expected journal entry");
        expect(originalJe.reversedByJournalEntryId).toBe(
          res.body.data.reversal.journalEntryId,
        );
      });

      it("(N) audit trail: reverse() writes the document-level REVERSE row, the 3 journal-level rows (REVERSE/CREATE/POST), and — for settlements — a per-allocation UPDATE row on the target, each with correct actor/entity/beforeState/afterState", async () => {
        const { doc, target } = await cfg.setup();

        const res = await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);
        const reversalJournalEntryId: string =
          res.body.data.reversal.journalEntryId;

        // --- (i) document-level REVERSE row --------------------------
        const docRows = await fetchAuditRows(cfg.entityType, doc.id);
        const docReverseRows = docRows.filter((r) => r.action === "REVERSE");
        expect(docReverseRows).toHaveLength(1);
        const docRow = docReverseRows[0]!;
        expect(docRow.actorUserId).toBe(posterUserId);
        expect(docRow.tenantId).toBe(tenantId);
        expect(docRow.legalEntityId).toBe(legalEntityId);
        const docBefore = docRow.beforeState as any;
        const docAfter = docRow.afterState as any;
        expect(docBefore.id).toBe(doc.id);
        expect(docBefore.status).toBe("POSTED");
        expect(docBefore.journalEntryId).toBe(doc.journalEntryId);
        expect(docAfter.id).toBe(doc.id);
        expect(docAfter.status).toBe("POSTED");
        expect(docAfter.journalEntryId).toBe(doc.journalEntryId);

        // --- (ii) journal-level rows (completeReversalPosting's own,
        // reused, 3-row contract: REVERSE on the original, CREATE + POST
        // on the new reversal entry) --------------------------------
        const originalJeRows = await fetchAuditRows(
          "journal_entry",
          doc.journalEntryId,
        );
        const originalReverseRows = originalJeRows.filter(
          (r) => r.action === "REVERSE",
        );
        expect(originalReverseRows).toHaveLength(1);
        expect(originalReverseRows[0]!.actorUserId).toBe(posterUserId);
        expect((originalReverseRows[0]!.beforeState as any).id).toBe(
          doc.journalEntryId,
        );
        expect(
          (originalReverseRows[0]!.beforeState as any).reversedByJournalEntryId,
        ).toBeNull();
        expect(
          (originalReverseRows[0]!.afterState as any).reversedByJournalEntryId,
        ).toBe(reversalJournalEntryId);

        const reversalJeRows = await fetchAuditRows(
          "journal_entry",
          reversalJournalEntryId,
        );
        const createRows = reversalJeRows.filter((r) => r.action === "CREATE");
        const postRows = reversalJeRows.filter((r) => r.action === "POST");
        expect(createRows).toHaveLength(1);
        expect(postRows).toHaveLength(1);
        expect(createRows[0]!.actorUserId).toBe(posterUserId);
        expect(createRows[0]!.beforeState).toBeNull();
        expect((createRows[0]!.afterState as any).id).toBe(
          reversalJournalEntryId,
        );
        expect(postRows[0]!.actorUserId).toBe(posterUserId);
        expect(postRows[0]!.beforeState).toBeNull();
        expect((postRows[0]!.afterState as any).id).toBe(
          reversalJournalEntryId,
        );
        expect((postRows[0]!.afterState as any).status).toBe("POSTED");

        // --- (iii) settlement-unwind row on the target ---------------
        if (cfg.kind === "settlement") {
          const targetResource = targetResourceFor(cfg);
          const targetEntityType =
            targetResource === "bills" ? "supplier_bill" : "customer_invoice";
          const targetRows = await fetchAuditRows(targetEntityType, target.id);
          const targetUpdateRows = targetRows.filter(
            (r) => r.action === "UPDATE",
          );
          // The target already has ONE pre-existing UPDATE audit row from
          // the settlement's own post() applying its allocation
          // (paidMinor 0 -> totalMinor) before this test's reverse() ever
          // runs — that is unrelated, correct, pre-existing behavior, not
          // part of what this test verifies. The reversal's own unwind
          // row is therefore the LAST one written (createdAt-ordered) and
          // is identified unambiguously by running in the opposite
          // direction (PAID -> UNPAID) from the post-time row.
          expect(targetUpdateRows.length).toBeGreaterThanOrEqual(1);
          const targetRow = targetUpdateRows[targetUpdateRows.length - 1]!;
          expect(targetRow.actorUserId).toBe(posterUserId);
          const targetBefore = targetRow.beforeState as any;
          const targetAfter = targetRow.afterState as any;
          expect(targetBefore.id).toBe(target.id);
          expect(targetBefore.paidMinor).toBe(target.totalMinor);
          expect(targetBefore.paymentStatus).toBe("PAID");
          expect(targetAfter.id).toBe(target.id);
          expect(targetAfter.paidMinor).toBe(0);
          expect(targetAfter.paymentStatus).toBe("UNPAID");
        }
      });

      it("(C) a posted document cannot be reversed twice (409); the second attempt changes nothing", async () => {
        const { doc } = await cfg.setup();
        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);

        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(409);

        const after = await getDoc(cfg.resource, doc.id);
        expect(after.status).toBe("POSTED");
      });

      it("(D) the posted source document's own business fields are unchanged by reversal (no mutation of the historical document)", async () => {
        const { doc } = await cfg.setup();
        const before = await getDoc(cfg.resource, doc.id);

        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);

        const after = await getDoc(cfg.resource, doc.id);
        expect(after.status).toBe(before.status);
        expect(after.totalMinor).toBe(before.totalMinor);
        expect(after.journalEntryId).toBe(before.journalEntryId);
        expect(after.internalReference).toBe(before.internalReference);
        expect(after.periodId).toBe(before.periodId);
        expect(after.postedAt).toBe(before.postedAt);
      });

      it("(E) accounting polarity: the reversal's journal lines are the exact swapped (debit<->credit) mirror of the original, same accounts, same order", async () => {
        const { doc } = await cfg.setup();
        const res = await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);

        const originalLines = await fetchJournalLines(doc.journalEntryId);
        const reversalLines = await fetchJournalLines(
          res.body.data.reversal.journalEntryId,
        );
        expect(reversalLines).toHaveLength(originalLines.length);
        for (let i = 0; i < originalLines.length; i++) {
          expect(reversalLines[i]!.accountId).toBe(originalLines[i]!.accountId);
          expect(reversalLines[i]!.debitMinor).toBe(
            originalLines[i]!.creditMinor,
          );
          expect(reversalLines[i]!.creditMinor).toBe(
            originalLines[i]!.debitMinor,
          );
        }
        // Every reversal entry must itself balance (sum debit = sum
        // credit) — the same invariant the original posting proves.
        const sumDebit = reversalLines.reduce((s, l) => s + l.debitMinor, 0);
        const sumCredit = reversalLines.reduce((s, l) => s + l.creditMinor, 0);
        expect(sumDebit).toBe(sumCredit);
      });

      if (cfg.hasTax) {
        it("(F) tax/account attributes on the source document's own lines are preserved through reversal (never re-derived or cleared)", async () => {
          const { doc } = await cfg.setup();
          const beforeLines = doc.lines;
          expect(beforeLines.some((l: any) => l.taxAmountMinor > 0)).toBe(true);

          await request(app.getHttpServer())
            .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
            .set(...auth(posterToken))
            .send({})
            .expect(201);

          const after = await getDoc(cfg.resource, doc.id);
          expect(after.lines).toEqual(beforeLines);
        });
      }

      if (cfg.kind === "target") {
        it("(G) target-document allocation safety: reversal is rejected (422) while any payment/receipt allocation exists against it", async () => {
          const { doc } = await cfg.setup();
          if (cfg.resource === "bills") {
            await createPostedPayment(doc.id, doc.totalMinor);
          } else {
            await createPostedReceipt(doc.id, doc.totalMinor);
          }

          await request(app.getHttpServer())
            .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
            .set(...auth(posterToken))
            .send({})
            .expect(422);

          const after = await getDoc(cfg.resource, doc.id);
          expect(after.reversal).toBeNull();
        });
      }

      if (cfg.kind === "settlement") {
        it("(H) settlement-document allocation unwind: reversing it un-applies its own allocation, restoring the target's paidMinor/paymentStatus", async () => {
          const { doc, target } = await cfg.setup();
          const targetResource = targetResourceFor(cfg);

          const targetAfterSettle = await getDoc(targetResource, target.id);
          expect(targetAfterSettle.paidMinor).toBe(target.totalMinor);
          expect(targetAfterSettle.paymentStatus).toBe("PAID");

          await request(app.getHttpServer())
            .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
            .set(...auth(posterToken))
            .send({})
            .expect(201);

          const targetAfterReversal = await getDoc(targetResource, target.id);
          expect(targetAfterReversal.paidMinor).toBe(0);
          expect(targetAfterReversal.paymentStatus).toBe("UNPAID");
          // Unwinding a settlement never touches the target's own
          // journal linkage or status — it was never reversed itself.
          expect(targetAfterReversal.status).toBe("POSTED");
          expect(targetAfterReversal.reversal).toBeNull();
        });

        it("(H) a settlement document is still reversible even though its target remains fully paid/settled by it — settlement reversal is never blocked the way target reversal is", async () => {
          const { doc } = await cfg.setup();
          await request(app.getHttpServer())
            .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
            .set(...auth(posterToken))
            .send({})
            .expect(201);
        });
      }

      it("(J/K) RBAC: finance.poster can reverse; finance.viewer and finance.admin cannot (403); an unauthenticated request is rejected (401)", async () => {
        const { doc } = await cfg.setup();

        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .expect(401);

        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(viewerToken))
          .send({})
          .expect(403);

        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(adminToken))
          .send({})
          .expect(403);

        // Confirmed still reversible by the correct role afterward —
        // proves the 403s above were pure authorization rejections with
        // no side effect, not a masked failure of the operation itself.
        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({})
          .expect(201);
      });

      it("422s when no accounting period covers the reversal's own transactionDate", async () => {
        const { doc } = await cfg.setup();
        await request(app.getHttpServer())
          .post(`/v1/finance/${cfg.resource}/${doc.id}/reverse`)
          .set(...auth(posterToken))
          .send({ transactionDate: "2045-01-01" })
          .expect(422);

        const after = await getDoc(cfg.resource, doc.id);
        expect(after.reversal).toBeNull();
      });
    });
  }

  // ---------------------------------------------------------------------
  // (I) Atomic rollback — representative types only (Supplier Bill,
  // Supplier Payment). The guarantee itself (a failure anywhere in the
  // transaction rolls back everything) is inherited from
  // JournalEntriesService's own already-proven transactional
  // infrastructure (reused directly, not reimplemented), so this proves
  // the reuse is wired correctly rather than re-proving the underlying
  // engine.
  // ---------------------------------------------------------------------
  describe("(I) Atomic rollback on a mid-operation failure", () => {
    it("Supplier Bill: a closed-period reverse() attempt leaves the bill, its journal entry, and the audit trail completely untouched — and a valid retry then succeeds", async () => {
      const bill = await createPostedBill(10000);

      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${bill.id}/reverse`)
        .set(...auth(posterToken))
        .send({ transactionDate: CLOSED_PERIOD_DATE })
        .expect(422);

      const afterFailure = await getDoc("bills", bill.id);
      expect(afterFailure.reversal).toBeNull();
      expect(afterFailure.status).toBe("POSTED");
      const originalJe = await fetchJournalEntry(bill.journalEntryId);
      if (!originalJe) throw new Error("expected journal entry");
      expect(originalJe.reversedByJournalEntryId).toBeNull();

      // Nothing partially applied — a subsequent, valid attempt still
      // succeeds cleanly.
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${bill.id}/reverse`)
        .set(...auth(posterToken))
        .send({})
        .expect(201);
    });

    it("Supplier Payment (two allocations across two bills): a closed-period reverse() attempt leaves BOTH allocated bills' paidMinor/paymentStatus completely untouched — never a partial unwind", async () => {
      const billOne = await createPostedBill(6000);
      const billTwo = await createPostedBill(4000);
      const created = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set(...auth(posterToken))
        .send({
          supplierId,
          paymentDate: "2026-03-05",
          paymentAmountMinor: 10000,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId,
          allocations: [
            { billId: billOne.id, allocatedAmountMinor: 6000 },
            { billId: billTwo.id, allocatedAmountMinor: 4000 },
          ],
        })
        .expect(201);
      const paymentId = created.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentId}/post`)
        .set(...auth(posterToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentId}/reverse`)
        .set(...auth(posterToken))
        .send({ transactionDate: CLOSED_PERIOD_DATE })
        .expect(422);

      const billOneAfter = await getDoc("bills", billOne.id);
      const billTwoAfter = await getDoc("bills", billTwo.id);
      expect(billOneAfter.paidMinor).toBe(6000);
      expect(billOneAfter.paymentStatus).toBe("PAID");
      expect(billTwoAfter.paidMinor).toBe(4000);
      expect(billTwoAfter.paymentStatus).toBe("PAID");

      // Valid retry still succeeds and unwinds both, cleanly.
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentId}/reverse`)
        .set(...auth(posterToken))
        .send({})
        .expect(201);
      const billOneFinal = await getDoc("bills", billOne.id);
      const billTwoFinal = await getDoc("bills", billTwo.id);
      expect(billOneFinal.paidMinor).toBe(0);
      expect(billTwoFinal.paidMinor).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // (L) Concurrent/repeated reversal safety — representative types only,
  // same reasoning as (I): the row-locking mechanism
  // (lockAndValidateOriginalForReversal's SELECT ... FOR UPDATE) is
  // JournalEntriesService's own, reused unchanged.
  // ---------------------------------------------------------------------
  describe("(L) Concurrent reversal safety", () => {
    it("Supplier Bill: two concurrent reverse() requests on the same bill — exactly one succeeds (201), the other is rejected (409), never both", async () => {
      const bill = await createPostedBill(10000);
      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/bills/${bill.id}/reverse`)
          .set(...auth(posterToken))
          .send({}),
        request(app.getHttpServer())
          .post(`/v1/finance/bills/${bill.id}/reverse`)
          .set(...auth(posterToken))
          .send({}),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);

      const originalJe = await fetchJournalEntry(bill.journalEntryId);
      if (!originalJe) throw new Error("expected journal entry");
      expect(originalJe.reversedByJournalEntryId).toBeTruthy();
      // Exactly one reversal journal entry was ever created for it.
      const allJournalLinesForReversal = await fetchJournalLines(
        originalJe.reversedByJournalEntryId!,
      );
      expect(allJournalLinesForReversal.length).toBeGreaterThan(0);
    });

    it("Supplier Payment: two concurrent reverse() requests on the same payment — exactly one succeeds, the allocated bill is unwound exactly once (not double-unwound)", async () => {
      const bill = await createPostedBill(10000);
      const payment = await createPostedPayment(bill.id, bill.totalMinor);

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/finance/payments/${payment.id}/reverse`)
          .set(...auth(posterToken))
          .send({}),
        request(app.getHttpServer())
          .post(`/v1/finance/payments/${payment.id}/reverse`)
          .set(...auth(posterToken))
          .send({}),
      ]);
      const statuses = [resX.status, resY.status].sort();
      expect(statuses).toEqual([201, 409]);

      const billAfter = await getDoc("bills", bill.id);
      // Unwound exactly once: back to 0, never negative (which double-
      // unwinding would produce).
      expect(billAfter.paidMinor).toBe(0);
      expect(billAfter.paymentStatus).toBe("UNPAID");
    });
  });

  // ---------------------------------------------------------------------
  // (M) Banking interaction — representative type (Supplier Payment).
  // Proposal's own finding: no structural FK dependency between a
  // payment/receipt and any bank_cash_accounts/bank_transactions row —
  // bankCashAccountId is a direct chart_of_accounts FK, and the bank
  // account's own GL balance is always LIVE-derived from posted
  // journal_lines. Reversal therefore needs zero special-casing here:
  // posting the swapped reversal journal entry against the SAME account
  // nets it back out automatically. This test proves that live
  // derivation actually holds, rather than asserting the finding as
  // prose.
  // ---------------------------------------------------------------------
  describe("(M) Banking interaction remains consistent through reversal", () => {
    it("Supplier Payment: the bank/cash GL account's balance moves by -paymentAmountMinor on posting, then returns exactly to its prior value on reversal", async () => {
      const balanceBefore = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${bankCashAccountId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      const before = balanceBefore.body.data.closingBalanceMinor;

      const bill = await createPostedBill(7500);
      const payment = await createPostedPayment(bill.id, bill.totalMinor);

      const balanceAfterPayment = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${bankCashAccountId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      expect(balanceAfterPayment.body.data.closingBalanceMinor).toBe(
        before - bill.totalMinor,
      );

      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/reverse`)
        .set(...auth(posterToken))
        .send({})
        .expect(201);

      const balanceAfterReversal = await request(app.getHttpServer())
        .get(`/v1/finance/accounts/${bankCashAccountId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      expect(balanceAfterReversal.body.data.closingBalanceMinor).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // (P) Reporting isolation — proves the disclosed, bounded `asOfTotals()`
  // reversal-awareness (proposal §12 point 5 / completion report "Known
  // Limitations") behaves exactly as documented: the target-document
  // (bill/invoice) side is genuinely reversal- and date-aware; the
  // settlement-allocation side deliberately is not (a real, disclosed
  // gap, reproduced here rather than assumed); and neither one ever
  // leaks into the live/current (non-as-of) totals or AP Ageing, which
  // read the live, already-correct `paidMinor` column instead of
  // reconstructing history. Each test uses a dedicated, freshly created
  // supplier/customer so the aggregate totals asserted below are exact
  // and never contaminated by bills/invoices/payments created by any of
  // this file's other (shared-fixture) tests. AP is exercised in full;
  // AR is exercised for the primary (target-document) fix only, as a
  // symmetry check against the confirmed-identical AR mirror in
  // ar-reports.service.ts — the same representative-testing disclosure
  // this file already uses for (I)/(L)/(M) above.
  // ---------------------------------------------------------------------
  describe("(P) Reporting isolation — asOfTotals() reversal-awareness is bounded exactly as documented", () => {
    it("AP Supplier Balance: total_billed is reversal- and date-aware (reversed after cutoff still counts, at/before cutoff does not); the live/current totals always reflect the live state regardless of any as-of query", async () => {
      const supplier = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(...auth(adminToken))
        .send({ code: uniq("ISO-SUP"), name: "Isolation Test Supplier" })
        .expect(201);
      const isoSupplierId = supplier.body.data.id;

      const billRes = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set(...auth(posterToken))
        .send({
          supplierId: isoSupplierId,
          supplierBillNumber: uniq("ISO-BILL"),
          billDate: "2026-01-01",
          lines: [{ accountId: expenseAccountId, amountMinor: 10000 }],
        })
        .expect(201);
      const billId = billRes.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${billId}/post`)
        .set(...auth(posterToken))
        .expect(200);

      // Baseline — no reversal exists at all yet: an as-of query after
      // the bill date behaves identically to the pre-fix code (the
      // added LEFT JOIN condition's `reversed_by_journal_entry_id IS
      // NULL` branch is a no-op for every never-reversed bill).
      const noReversalYet = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .query({ asOf: "2026-02-01" })
        .set(...auth(posterToken))
        .expect(200);
      expect(noReversalYet.body.data.totalBilledMinor).toBe(10000);
      expect(noReversalYet.body.data.totalOutstandingMinor).toBe(10000);

      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${billId}/reverse`)
        .set(...auth(posterToken))
        .send({ transactionDate: "2026-02-15" })
        .expect(201);

      // As of a cutoff BEFORE the reversal's own transactionDate, the
      // bill genuinely was still outstanding as of that historical
      // date — must still count.
      const beforeReversalDate = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .query({ asOf: "2026-02-10" })
        .set(...auth(posterToken))
        .expect(200);
      expect(beforeReversalDate.body.data.totalBilledMinor).toBe(10000);

      // As of a cutoff AT/AFTER the reversal's own transactionDate, the
      // bill had already been reversed by then — must be excluded.
      const afterReversalDate = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .query({ asOf: "2026-02-20" })
        .set(...auth(posterToken))
        .expect(200);
      expect(afterReversalDate.body.data.totalBilledMinor).toBe(0);

      // Live/current (non-as-of) totals: a completely separate code path
      // (currentTotals()'s unconditional NOT EXISTS, no date involved at
      // all) — always reflects the live state.
      const live = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      expect(live.body.data.totalBilledMinor).toBe(0);
    });

    it("AP Supplier Balance: asOfTotals()'s historical reconstruction correctly excludes a settlement reversed at-or-before the as-of cutoff, matching the live (non-as-of) totals", async () => {
      const supplier = await request(app.getHttpServer())
        .post("/v1/finance/suppliers")
        .set(...auth(adminToken))
        .send({ code: uniq("ISO-SUP2"), name: "Isolation Test Supplier 2" })
        .expect(201);
      const isoSupplierId = supplier.body.data.id;

      const billRes = await request(app.getHttpServer())
        .post("/v1/finance/bills")
        .set(...auth(posterToken))
        .send({
          supplierId: isoSupplierId,
          supplierBillNumber: uniq("ISO-BILL2"),
          billDate: "2026-01-01",
          lines: [{ accountId: expenseAccountId, amountMinor: 10000 }],
        })
        .expect(201);
      const billId = billRes.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/bills/${billId}/post`)
        .set(...auth(posterToken))
        .expect(200);

      const paymentRes = await request(app.getHttpServer())
        .post("/v1/finance/payments")
        .set(...auth(posterToken))
        .send({
          supplierId: isoSupplierId,
          paymentDate: "2026-01-05",
          paymentAmountMinor: 10000,
          paymentMethod: "BANK_TRANSFER",
          bankCashAccountId,
          allocations: [{ billId, allocatedAmountMinor: 10000 }],
        })
        .expect(201);
      const paymentId = paymentRes.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentId}/post`)
        .set(...auth(posterToken))
        .expect(200);

      // Reverse the payment itself with an EARLY transactionDate — the
      // settlement was undone shortly after it was made.
      await request(app.getHttpServer())
        .post(`/v1/finance/payments/${paymentId}/reverse`)
        .set(...auth(posterToken))
        .send({ transactionDate: "2026-01-08" })
        .expect(201);

      // --- Live (non-as-of) totals: always correct, no gap here -------
      // paidMinor is live-mutated by unsettleTarget() at the moment of
      // reversal, so currentTotals() (which reads it directly) needs no
      // reversal-date check of its own to already be correct.
      const live = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      expect(live.body.data.totalBilledMinor).toBe(10000);
      expect(live.body.data.totalPaidMinor).toBe(0);
      expect(live.body.data.totalOutstandingMinor).toBe(10000);

      // --- Historical as-of reconstruction -----------------------------
      // As of 2026-01-10 (AFTER the reversal's own transactionDate,
      // 2026-01-08), a fully correct historical reconstruction shows the
      // payment as no longer applied by then. asOfTotals()'s total_paid
      // subquery DOES carry the same reversal-date check as the
      // total_billed side (rev_je joined on sp.journal_entry_id, in
      // ap-reports.service.ts's own asOfTotals()) — a payment reversed at
      // or before the cutoff no longer counts as a settlement as of that
      // historical date.
      //
      // CTO remediation runtime-verification correction (NORYX SPHERE
      // final runtime quality gate) — this test, and the comment above
      // asOfTotals()'s total_paid subquery, previously described this as
      // a disclosed "known limitation" (expecting the stale/buggy value
      // 10000 here as a deliberate defect-confirmation). Caught only by
      // actually running this suite against real Postgres: the check was
      // already present and correct in the query; only this test's own
      // expectation (and that comment) had not been updated to match.
      const historicalAfterReversal = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .query({ asOf: "2026-01-10" })
        .set(...auth(posterToken))
        .expect(200);
      expect(historicalAfterReversal.body.data.totalBilledMinor).toBe(10000);
      expect(historicalAfterReversal.body.data.totalPaidMinor).toBe(0);

      // An as-of query dated BEFORE the reversal ever happened is
      // unaffected either way — same value, for the ordinary reason
      // (the allocation was genuinely still in effect then).
      const historicalBeforeReversal = await request(app.getHttpServer())
        .get(`/v1/finance/suppliers/${isoSupplierId}/balance`)
        .query({ asOf: "2026-01-06" })
        .set(...auth(posterToken))
        .expect(200);
      expect(historicalBeforeReversal.body.data.totalPaidMinor).toBe(10000);
    });

    it("AR Customer Balance: total_invoiced is reversal- and date-aware, an exact symmetry check against the confirmed-identical AR mirror (ar-reports.service.ts asOfTotals())", async () => {
      const customerRes = await request(app.getHttpServer())
        .post("/v1/finance/customers")
        .set(...auth(adminToken))
        .send({ code: uniq("ISO-CUST"), name: "Isolation Test Customer" })
        .expect(201);
      const isoCustomerId = customerRes.body.data.id;

      const invoiceRes = await request(app.getHttpServer())
        .post("/v1/finance/invoices")
        .set(...auth(posterToken))
        .send({
          customerId: isoCustomerId,
          invoiceDate: "2026-01-01",
          lines: [{ accountId: revenueAccountId, amountMinor: 10000 }],
        })
        .expect(201);
      const invoiceId = invoiceRes.body.data.id;
      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${invoiceId}/post`)
        .set(...auth(posterToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/finance/invoices/${invoiceId}/reverse`)
        .set(...auth(posterToken))
        .send({ transactionDate: "2026-02-15" })
        .expect(201);

      const beforeReversalDate = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${isoCustomerId}/balance`)
        .query({ asOf: "2026-02-10" })
        .set(...auth(posterToken))
        .expect(200);
      expect(beforeReversalDate.body.data.totalInvoicedMinor).toBe(10000);

      const afterReversalDate = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${isoCustomerId}/balance`)
        .query({ asOf: "2026-02-20" })
        .set(...auth(posterToken))
        .expect(200);
      expect(afterReversalDate.body.data.totalInvoicedMinor).toBe(0);

      const live = await request(app.getHttpServer())
        .get(`/v1/finance/customers/${isoCustomerId}/balance`)
        .set(...auth(posterToken))
        .expect(200);
      expect(live.body.data.totalInvoicedMinor).toBe(0);
    });
  });
});
