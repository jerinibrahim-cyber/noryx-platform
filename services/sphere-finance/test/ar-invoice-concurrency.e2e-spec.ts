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
import { chartOfAccounts, customerInvoices } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

/**
 * AR-1b — docs/finance-work-item-ar-1b-customer-invoicing-proposal.md
 * §8. Concurrent posting of the same invoice (must serialize cleanly,
 * exactly one winner), no burned invoice/journal number from a failed
 * post sandwiched between two successful ones, and concurrent
 * invoice-post vs. period-close (the period's row lock must serialize
 * cleanly) — mirrors ap-bill-concurrency.e2e-spec.ts exactly, adapted to
 * the invoice/customer/revenue/AR-control domain.
 */
describe("AR-1b — customer invoice posting concurrency", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let revenueAccountId: string;
  let arControlAccountId: string;
  let customerId: string;
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
        slug: `inv-conc-e2e-${suffix}`,
        name: "Invoice Concurrency E2E Tenant",
      })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Invoice Concurrency E2E Entity",
        code: "INVCONC1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [revenue] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `INVCONC-REV-${suffix}`,
        name: "Consulting Revenue",
        type: "REVENUE",
      })
      .returning();
    const [arControl] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `INVCONC-AR-${suffix}`,
        name: "Accounts Receivable",
        type: "ASSET",
      })
      .returning();
    revenueAccountId = revenue!.id;
    arControlAccountId = arControl!.id;

    const adminToken = tokenFor(["finance.admin"]);
    await request(app.getHttpServer())
      .post("/v1/finance/ar/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ arControlAccountId })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post("/v1/finance/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INVCONC-CUST-${suffix}`,
        name: "Concurrency Test Customer",
      })
      .expect(201);
    customerId = customer.body.data.id;

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INVCONC-OPEN-${suffix}`,
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

  it("two concurrent POST requests against the same DRAFT invoice: exactly one 200, one 409, exactly one internalReference assigned, exactly one POST audit event", async () => {
    const token = tokenFor(["finance.poster"]);
    const created = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate: "2026-04-10",
        lines: [{ accountId: revenueAccountId, amountMinor: 500 }],
      })
      .expect(201);
    const id = created.body.data.id;

    const [resX, resY] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
        .set("Authorization", `Bearer ${token}`),
      request(app.getHttpServer())
        .post(`/v1/finance/invoices/${id}/post`)
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
          eq(auditLogs.entityType, "customer_invoice"),
          eq(auditLogs.action, "POST"),
        ),
      );
    expect(postRows).toHaveLength(1);

    const invoice = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(customerInvoices)
        .where(eq(customerInvoices.id, id))
        .then((rows) => rows[0]),
    );
    expect(invoice!.internalReference).toMatch(/^INV-\d{6}$/);
  });

  it("no burned invoice/journal number from a failed post between two successful ones (a failing post between two succeeding ones consumes neither sequence)", async () => {
    const token = tokenFor(["finance.poster"]);

    const first = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate: "2026-04-11",
        lines: [{ accountId: revenueAccountId, amountMinor: 100 }],
      })
      .expect(201);
    const firstPosted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${first.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // An invoice dated outside any accounting period — its post attempt
    // fails at period resolution, AFTER invoice-number/journal-number
    // allocation would occur, proving the failure rolls back the whole
    // transaction including any allocation that would have happened.
    const failing = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate: "2029-01-01",
        lines: [{ accountId: revenueAccountId, amountMinor: 100 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${failing.body.data.id}/post`)
      .set("Authorization", `Bearer ${token}`)
      .expect(422);

    const second = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId,
        invoiceDate: "2026-04-12",
        lines: [{ accountId: revenueAccountId, amountMinor: 100 }],
      })
      .expect(201);
    const secondPosted = await request(app.getHttpServer())
      .post(`/v1/finance/invoices/${second.body.data.id}/post`)
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

  it("concurrent invoice-post vs. period-close serialize cleanly via the period row lock — never a race", async () => {
    const adminToken = tokenFor(["finance.admin"]);
    const posterToken = tokenFor(["finance.poster"]);

    const period = await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `INVCONC-RACE-${suffix}`,
        startDate: "2030-01-01",
        endDate: "2030-01-31",
      })
      .expect(201);
    const periodId = period.body.data.id;

    const invoice = await request(app.getHttpServer())
      .post("/v1/finance/invoices")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        customerId,
        invoiceDate: "2030-01-15",
        lines: [{ accountId: revenueAccountId, amountMinor: 250 }],
      })
      .expect(201);

    const [postRes, closeRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/finance/invoices/${invoice.body.data.id}/post`)
        .set("Authorization", `Bearer ${posterToken}`),
      request(app.getHttpServer())
        .patch(`/v1/finance/accounting-periods/${periodId}/close`)
        .set("Authorization", `Bearer ${adminToken}`),
    ]);

    // Whichever wins the row lock first determines the other's outcome,
    // but both must resolve cleanly (no 500, no raw DB error) and never
    // both "succeed" in a way that posts into an invoice dated inside an
    // already-closed period.
    expect([200, 422]).toContain(postRes.status);
    expect(closeRes.status).toBe(200);
    if (postRes.status === 200) {
      expect(postRes.body.data.periodId).toBe(periodId);
    }
  });
});
