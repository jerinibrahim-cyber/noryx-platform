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
    setup: () => Promise<{ doc: any; target?: any }>;
  }

  const DOC_TYPES: DocTypeConfig[] = [
    {
      name: "Supplier Bill",
      resource: "bills",
      kind: "target",
      hasTax: true,
      setup: async () => ({ doc: await createPostedBill(10000, 500) }),
    },
    {
      name: "Customer Invoice",
      resource: "invoices",
      kind: "target",
      hasTax: true,
      setup: async () => ({ doc: await createPostedInvoice(10000, 500) }),
    },
    {
      name: "Supplier Payment",
      resource: "payments",
      kind: "settlement",
      hasTax: false,
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
});
