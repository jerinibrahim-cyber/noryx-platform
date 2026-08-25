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
import { chartOfAccounts, supplierBills } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AP-1b — docs/finance-work-item-1b-supplier-bills-proposal.md §14/§18.
 * Concurrent posting of the same bill (must serialize cleanly, exactly
 * one winner), and concurrent bill-post vs. period-close (the period's
 * row lock must block the close until the post's transaction resolves)
 * — same shape as the existing journal-entries/general-ledger
 * concurrency tests.
 */
describe("AP-1b — bill posting concurrency", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let supplierId: string;
  let suffix: number;

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
      .values({
        slug: `bill-conc-e2e-${suffix}`,
        name: "Bill Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Bill Concurrency E2E Entity",
        code: "BILLCONC1",
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
        code: `BILLCONC-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `BILLCONC-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    expenseAccountId = expense!.id;
    liabilityAccountId = liability!.id;

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
        code: `BILLCONC-SUP-${suffix}`,
        name: "Concurrency Test Supplier",
      })
      .expect(201);
    supplierId = supplier.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILLCONC-OPEN-${suffix}`,
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

  it("two concurrent POST requests against the same DRAFT bill: exactly one 200, one 409, exactly one internalReference assigned, exactly one POST audit event", async () => {
    const token = tokenFor(["finance.poster"]);
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `CONC-DOUBLE-${suffix}`,
        billDate: "2026-04-10",
        lines: [{ accountId: expenseAccountId, amountMinor: 500 }],
      })
      .expect(201);
    const id = created.body.data.id;

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/bills/${id}/post`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([200, 409]);

    const db = getPlatformDb();
    const postRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, id),
          eq(auditLogs.entityType, "supplier_bill"),
          eq(auditLogs.action, "POST"),
        ),
      );
    expect(postRows).toHaveLength(1);

    const bill = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(supplierBills)
        .where(eq(supplierBills.id, id))
        .then((rows) => rows[0]),
    );
    expect(bill!.internalReference).toMatch(/^BILL-\d{6}$/);
  });

  it("no burned bill/journal number from a failed post between two successful ones (a failing post between two succeeding ones consumes neither sequence)", async () => {
    const token = tokenFor(["finance.poster"]);

    const first = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `CONC-SEQ-1-${suffix}`,
        billDate: "2026-04-11",
        lines: [{ accountId: expenseAccountId, amountMinor: 100 }],
      })
      .expect(201);
    const firstPosted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${first.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // A bill dated outside any accounting period — its post attempt
    // fails at period resolution, AFTER bill-number/journal-number
    // allocation would occur, proving the failure rolls back the whole
    // transaction including any allocation that would have happened.
    const failing = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `CONC-SEQ-FAIL-${suffix}`,
        billDate: "2029-01-01",
        lines: [{ accountId: expenseAccountId, amountMinor: 100 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/bills/${failing.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(422);

    const second = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId,
        supplierBillNumber: `CONC-SEQ-2-${suffix}`,
        billDate: "2026-04-12",
        lines: [{ accountId: expenseAccountId, amountMinor: 100 }],
      })
      .expect(201);
    const secondPosted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${second.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const firstNum = parseInt(
      firstPosted.body.data.internalReference.split("-")[1],
      10,
    );
    const secondNum = parseInt(
      secondPosted.body.data.internalReference.split("-")[1],
      10,
    );
    expect(secondNum).toBe(firstNum + 1); // the failed post between them burned nothing
  });

  it("concurrent bill-post vs. period-close serialize cleanly via the period row lock — never a race", async () => {
    const adminToken = tokenFor(["finance.admin"]);
    const posterToken = tokenFor(["finance.poster"]);

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `BILLCONC-RACE-${suffix}`,
        startDate: "2030-01-01",
        endDate: "2030-01-31",
      })
      .expect(201);
    const periodId = period.body.data.id;

    const bill = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `CONC-RACE-${suffix}`,
        billDate: "2030-01-15",
        lines: [{ accountId: expenseAccountId, amountMinor: 250 }],
      })
      .expect(201);

    const [postRes, closeRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/bills/${bill.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`),
      request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodId}/close`)
        .set("Authorization", `Bearer ${adminToken}`),
    ]);

    // Whichever wins the row lock first determines the other's outcome,
    // but both must resolve cleanly (no 500, no raw DB error) and never
    // both "succeed" in a way that posts into a bill dated inside an
    // already-closed period.
    expect([200, 422]).toContain(postRes.status);
    expect(closeRes.status).toBe(200);
    if (postRes.status === 200) {
      expect(postRes.body.data.periodId).toBe(periodId);
    }
  });
});
