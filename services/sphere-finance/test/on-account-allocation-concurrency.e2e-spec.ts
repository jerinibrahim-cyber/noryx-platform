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
  supplierBills,
  supplierPaymentAllocations,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { SupplierPaymentsService } from "../src/accounts-payable/supplier-payments/supplier-payments.service";
import { SupplierPaymentsModule } from "../src/accounts-payable/supplier-payments/supplier-payments.module";
import { JournalEntriesService } from "../src/journal-entries/journal-entries.service";

/**
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md §14.2/§14.2a,
 * Table 19.1 scenarios 42-43, CTO Architecture Gate, approved). Proves
 * the concurrency invariant (`SUM(allocatedAmountMinor) <=
 * paymentAmountMinor`) is a genuine DB-backed, lock-order-enforced
 * property — two real HTTP requests issued concurrently against the
 * same fixture row, asserting the database's final state directly, not
 * merely that one returned 200 and one returned 422 (the CTO's explicit
 * requirement, §19.2). AR's concurrency behavior is structurally
 * identical (byte-mirror service code, same lock order) and is not
 * re-proven here — proposal §14.2's own reasoning explicitly treats AP
 * and AR as symmetric for this property.
 */
describe("On-Account — applyAllocation() concurrency invariant (§14.2a)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let supplierId: string;
  let suffix: number;
  let paymentsService: SupplierPaymentsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let paymentsServicePrivate: any;
  let journalEntriesService: JournalEntriesService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let journalEntriesServicePrivate: any;

  function tokenFor(roles: string[]) {
    return jwt.sign({
      sub: randomUUID(),
      tenantId,
      legalEntityId,
      tier: "TENANT_INTERNAL",
      roles,
      modules: ["sphere-finance"],
    });
  }

  async function postBill(
    token: string,
    amountMinor: number,
    billDate: string,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `OAACONC-BILL-${randomUUID()}`,
        billDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string; totalMinor: number };
  }

  async function createAndPostPayment(
    token: string,
    paymentAmountMinor: number,
    paymentDate: string,
  ) {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate,
        paymentAmountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return posted.body.data as { id: string };
  }

  /** Typed helpers for the #44a/#44b deterministic-ordering tests below
   * — giving the in-flight "other" request a concrete, correctly
   * inferred `supertest.Test` type (via ReturnType) rather than the
   * agent type `typeof request` itself resolves to, which is not
   * awaitable the same way. */
  function postReverse(paymentId: string, token: string) {
    return request(app.getHttpServer())
      .post(`/v1/finance/payments/${paymentId}/reverse`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
  }

  function postAllocation(
    paymentId: string,
    token: string,
    billId: string,
    allocatedAmountMinor: number,
    allocationDate: string,
  ) {
    return request(app.getHttpServer())
      .post(`/v1/finance/payments/${paymentId}/allocations`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        allocations: [{ billId, allocatedAmountMinor }],
        allocationDate,
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
    // CTO remediation runtime-verification correction (NORYX SPHERE final
    // runtime quality gate) — the #44a/#44b tests below fire a SECOND,
    // genuinely overlapping (not sequentially-awaited) HTTP request from
    // inside a jest.spyOn seam while the FIRST request's own transaction
    // is still open, relying on real Postgres row-lock contention between
    // the two live connections. With only app.init() (no persistent
    // listener), each `request(app.getHttpServer())` call must lazily
    // .listen(0) the underlying server on first use; caught only by
    // actually running these tests against real Postgres, two calls that
    // both begin before that lazy listen has completed race on binding
    // the same http.Server, which manifested as an intermittent
    // ECONNREFUSED on the second (fired-but-unawaited) request. Binding a
    // real, persistent listener up front — the standard fix for e2e
    // suites that need truly concurrent supertest requests against a
    // NestJS app — removes the race entirely; every other test in this
    // file already goes through the same listener without incident.
    await app.listen(0);

    paymentsService = app.get(SupplierPaymentsService);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paymentsServicePrivate = paymentsService as any;
    // CTO remediation runtime-verification correction (NORYX SPHERE final
    // runtime quality gate) — `journal-entries.module.ts` does not export
    // JournalEntriesService, so (per an established, pervasive,
    // pre-existing pattern used identically across 8 other modules in
    // this codebase — supplier-bills, supplier-payments,
    // supplier-debit-notes, customer-invoices, customer-receipts,
    // customer-credit-notes, scheduled-reversals, and app.module.ts
    // itself) supplier-payments.module.ts registers its OWN separate
    // JournalEntriesService provider rather than importing a shared one.
    // JournalEntriesService is stateless with respect to instance
    // identity (every business method takes the transaction client `tx`
    // explicitly), so this has no behavioral effect on real requests —
    // but it does mean `app.get(JournalEntriesService)` (the
    // module-tree-root/global-context resolution) returns a DIFFERENT
    // object than the one actually injected into SupplierPaymentsService,
    // so a jest.spyOn against the former never intercepts calls made by
    // the latter — caught only by actually running #44b against real
    // Postgres (the spy silently never fired, leaving `allocPromise`
    // undefined). `app.select(SupplierPaymentsModule)` resolves the
    // service within that module's own DI sub-tree, returning the exact
    // instance SupplierPaymentsService holds as `this.journalEntries`.
    // This is a test-instrumentation correction only — no source/module
    // wiring changed; the identical, working, 8-module-wide pattern is
    // left exactly as-is, since altering it would be an unrelated,
    // cross-cutting architecture change far outside this work item's
    // scope.
    journalEntriesService = app
      .select(SupplierPaymentsModule)
      .get(JournalEntriesService, { strict: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journalEntriesServicePrivate = journalEntriesService as any;

    jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

    const platformDb = getPlatformDb();
    suffix = Date.now();
    const [tenant] = await platformDb
      .insert(tenants)
      .values({
        slug: `oaa-conc-e2e-${suffix}`,
        name: "On-Account Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "On-Account Concurrency E2E Entity",
        code: "OAACONC1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [expense] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAACONC-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAACONC-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `OAACONC-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = expense!.id;
    liabilityAccountId = liability!.id;
    bankAccountId = bank!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountId })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAACONC-SUP-${suffix}`,
        name: "Concurrency Test Supplier",
      })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `OAACONC-OPEN-${suffix}`,
        startDate: "2024-01-01",
        endDate: "2028-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("#43 — two concurrent applyAllocation() calls that TOGETHER exceed the payment amount: exactly one 200, one 422; appliedMinor never exceeds paymentAmountMinor", async () => {
    const token = tokenFor(["finance.poster"]);
    const billOne = await postBill(token, 700, "2026-04-10");
    const billTwo = await postBill(token, 700, "2026-04-10");
    // A zero-allocation payment for 1000 — two concurrent applyAllocation()
    // calls each requesting 700 (together 1400 > 1000).
    const payment = await createAndPostPayment(token, 1000, "2026-04-11");

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 700 }],
          allocationDate: "2026-04-12",
        }),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 700 }],
          allocationDate: "2026-04-12",
        }),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 422]);

    // Assert the DATABASE's final state directly (§19.2's explicit
    // requirement) — not merely the HTTP status pair.
    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    const totalApplied = allocationRows.reduce(
      (s, a) => s + a.allocatedAmountMinor,
      0,
    );
    expect(totalApplied).toBeLessThanOrEqual(1000);
    expect(totalApplied).toBe(700); // only the winner's allocation committed
    expect(allocationRows).toHaveLength(1);
  });

  it("#42 — two concurrent applyAllocation() calls that BOTH fit within the payment's remaining amount both succeed", async () => {
    const token = tokenFor(["finance.poster"]);
    const billOne = await postBill(token, 400, "2026-04-13");
    const billTwo = await postBill(token, 500, "2026-04-13");
    const payment = await createAndPostPayment(token, 1000, "2026-04-14");

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billOne.id, allocatedAmountMinor: 400 }],
          allocationDate: "2026-04-15",
        }),
      request(app.getHttpServer())
        .post(`/v1/finance/payments/${payment.id}/allocations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          allocations: [{ billId: billTwo.id, allocatedAmountMinor: 500 }],
          allocationDate: "2026-04-15",
        }),
    ]);
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    const totalApplied = allocationRows.reduce(
      (s, a) => s + a.allocatedAmountMinor,
      0,
    );
    expect(totalApplied).toBe(900);
    expect(allocationRows).toHaveLength(2);
  });

  // -------------------------------------------------------------------
  // Table 19.1 #44 — applyAllocation() racing reverse() on the same
  // payment, BOTH orderings, made deterministic rather than left to
  // Promise.all()'s own scheduling (the original "scenario 43" test
  // below this comment exercised only whichever ordering the Node
  // event loop happened to produce on a given run — the CTO
  // Architecture Gate calls for the general-ledger-concurrency.e2e-
  // spec.ts jest.spyOn-private-seam technique specifically so both
  // orderings are provably covered, not just "one of the two, we don't
  // know which"). The header row's own `SELECT ... FOR UPDATE` lock
  // (findByIdInTx, the first statement in both applyAllocation() and
  // reverse()) is unchanged — these tests inject the second HTTP call
  // from inside a spied private seam that only fires AFTER the first
  // call has already acquired that lock, so the second call's own lock
  // acquisition is what actually blocks on Postgres until the first
  // call's transaction commits. No mechanism-level change, only
  // deterministic sequencing of which real HTTP request starts first.
  // -------------------------------------------------------------------
  it("#44a — applyAllocation() acquires the header lock FIRST: it succeeds, and the concurrent reverse() (which must wait) then correctly unwinds it", async () => {
    const token = tokenFor(["finance.poster"]);
    const bill = await postBill(token, 500, "2026-04-19");
    const payment = await createAndPostPayment(token, 500, "2026-04-20");

    let reversePromise: ReturnType<typeof postReverse> | undefined;
    const original =
      paymentsServicePrivate.validateAllocationsShapeOrThrow.bind(
        paymentsService,
      );
    jest
      .spyOn(paymentsServicePrivate, "validateAllocationsShapeOrThrow")
      .mockImplementation((...args: unknown[]) => {
        // Fired from inside applyAllocation()'s own transaction, AFTER
        // its FOR UPDATE lock on the payment row is already held (Step
        // 1-2) and BEFORE that transaction commits — reverse()'s own
        // FOR UPDATE on the same row (its first statement) can only
        // proceed once this transaction ends, so firing (not awaiting)
        // it here deterministically pins applyAllocation() as the
        // lock-acquisition winner.
        reversePromise = postReverse(payment.id, token);
        return original(...args);
      });

    const allocRes = await postAllocation(
      payment.id,
      token,
      bill.id,
      500,
      "2026-04-21",
    );
    expect(allocRes.status).toBe(200);

    const reverseRes = await reversePromise!;
    // CTO remediation runtime-verification correction (NORYX SPHERE final
    // runtime quality gate) — /reverse has no @HttpCode(200) override and
    // correctly defaults to Nest's standard 201 for a POST that creates a
    // new reversing journal entry (confirmed against the pre-existing
    // document-reversal.e2e-spec.ts's own consistent .expect(201) usage,
    // and against this same fix already applied to on-account-
    // allocation.e2e-spec.ts and on-account-allocation-ar.e2e-spec.ts).
    expect(reverseRes.status).toBe(201);

    const [billRow] = await withTenant(tenantId, (tx) =>
      tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
    );
    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    // applyAllocation() landed, then reverse() unwound it — no orphaned
    // allocation row, no double-unwind, bill back to fully unpaid.
    expect(billRow!.paidMinor).toBe(0);
    expect(allocationRows).toHaveLength(1); // append-only — the row itself remains as history
  });

  it("#44b — reverse() acquires the header lock FIRST: it succeeds, and the concurrent applyAllocation() (which must wait) is then rejected 409", async () => {
    const token = tokenFor(["finance.poster"]);
    const bill = await postBill(token, 500, "2026-04-22");
    const payment = await createAndPostPayment(token, 500, "2026-04-23");

    let allocPromise: ReturnType<typeof postAllocation> | undefined;
    const original =
      journalEntriesServicePrivate.lockAndValidateOriginalForReversal.bind(
        journalEntriesService,
      );
    jest
      .spyOn(journalEntriesServicePrivate, "lockAndValidateOriginalForReversal")
      .mockImplementation((...args: unknown[]) => {
        // Fired from inside reverse()'s own transaction, AFTER its FOR
        // UPDATE lock on the payment row is already held — same seam
        // technique as #44a, mirrored to pin reverse() as the winner
        // this time.
        allocPromise = postAllocation(
          payment.id,
          token,
          bill.id,
          500,
          "2026-04-24",
        );
        return original(...args);
      });

    const reverseRes = await postReverse(payment.id, token);
    // Same /reverse status-code correction as #44a above — 201, not 200.
    expect(reverseRes.status).toBe(201);

    const allocRes = await allocPromise!;
    // By the time applyAllocation()'s own transaction finally acquires
    // the lock, the payment's journal entry is already reversed — Step
    // 5's application-layer check (§9.1) rejects it with 409, the same
    // outcome Table 19.1 #17 proves for a non-concurrent reversed
    // payment.
    expect(allocRes.status).toBe(409);

    const [billRow] = await withTenant(tenantId, (tx) =>
      tx.select().from(supplierBills).where(eq(supplierBills.id, bill.id)),
    );
    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    // The allocation never landed at all — bill untouched, zero rows.
    expect(billRow!.paidMinor).toBe(0);
    expect(allocationRows).toHaveLength(0);
  });

  it("#50 — Invariant 2 (appliedMinor <= paymentAmountMinor) holds when a post()-time (create-time) allocation and two later concurrent applyAllocation() calls all combine against the same payment", async () => {
    // NORYX SPHERE finalization round — newly written to close a
    // previously-disclosed NOT EXECUTED gap. Distinct from #42/#43
    // above: those two start from a ZERO-allocation payment, so a
    // ceiling bug that only miscounts a post()-time-seeded starting
    // balance (as opposed to a starting balance built entirely from
    // prior applyAllocation() calls) would not be caught by either.
    // This payment's own SUM(allocatedAmountMinor) starts at 400 —
    // written by post() itself, in the payment's own creation
    // transaction, via the ordinary create()-time allocation path —
    // before either concurrent applyAllocation() call ever runs.
    const token = tokenFor(["finance.poster"]);
    const billSeed = await postBill(token, 400, "2026-04-25");
    const billTwo = await postBill(token, 400, "2026-04-25");
    const billThree = await postBill(token, 400, "2026-04-25");

    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        paymentDate: "2026-04-25",
        paymentAmountMinor: 1000,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations: [{ billId: billSeed.id, allocatedAmountMinor: 400 }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const payment = posted.body.data as { id: string };

    // Remaining balance is 1000 - 400 = 600. Two concurrent
    // applyAllocation() calls each request 400 (together 800 > 600
    // remaining, and 400 + 800 = 1200 > 1000 total) — the same
    // exactly-one-wins shape as #43, but starting from a nonzero,
    // create-time-seeded balance instead of zero.
    const [resX, resY] = await Promise.all([
      postAllocation(payment.id, token, billTwo.id, 400, "2026-04-26"),
      postAllocation(payment.id, token, billThree.id, 400, "2026-04-26"),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 422]);

    const allocationRows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierPaymentAllocations)
        .where(eq(supplierPaymentAllocations.paymentId, payment.id)),
    );
    const totalApplied = allocationRows.reduce(
      (s, a) => s + a.allocatedAmountMinor,
      0,
    );
    // Invariant 2 holds at the final state: never exceeds the header
    // amount, and correctly accounts for the post()-time seed (400)
    // plus exactly one winning concurrent call (400) — never both.
    expect(totalApplied).toBeLessThanOrEqual(1000);
    expect(totalApplied).toBe(800);
    expect(allocationRows).toHaveLength(2); // the seed row + the one winner
  });
});
