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
import { closeDb as closeFinanceDb, getDb as getFinanceDb } from "../src/db/db";
import { chartOfAccounts } from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";

const ASOF = "2026-06-15";

/** Returns a due date `days` days before ASOF (as a plain YYYY-MM-DD
 * string), so `daysPastDue` relative to ASOF is exactly `days` — negative
 * `days` gives a due date in the future (not yet due). */
function dueDateAt(days: number): string {
  const d = new Date(`${ASOF}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * AP-1d — AP Ageing (`GET /ap/ageing`).
 * docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.3, §9.
 */
describe("AP Reports — AP Ageing (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  let tenantId: string;
  let legalEntityId: string;
  let expenseAccountId: string;
  let liabilityAccountId: string;
  let bankAccountId: string;
  let posterToken: string;
  let adminToken: string;
  let suffix: number;

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

  async function newSupplier(code: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/finance/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `${code}-${suffix}`, name: code })
      .expect(201);
    return res.body.data.id;
  }

  async function createAndPostBill(
    supplierId: string,
    billDate: string,
    dueDate: string,
    amountMinor: number,
  ): Promise<{ id: string; totalMinor: number }> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `AGE-BILL-${randomUUID()}`,
        billDate,
        dueDate,
        lines: [{ accountId: expenseAccountId, amountMinor }],
      })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    return { id: posted.body.data.id, totalMinor: posted.body.data.totalMinor };
  }

  async function createAndPostPayment(
    supplierId: string,
    paymentDate: string,
    amountMinor: number,
    allocations: { billId: string; allocatedAmountMinor: number }[],
  ): Promise<void> {
    const created = await request(app.getHttpServer())
      .post("/v1/finance/payments")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        paymentDate,
        paymentAmountMinor: amountMinor,
        paymentMethod: "BANK_TRANSFER",
        bankCashAccountId: bankAccountId,
        allocations,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/payments/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
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
      .values({ slug: `age-e2e-${suffix}`, name: "Ageing E2E Tenant" })
      .returning();
    tenantId = tenant!.id;

    const [entity] = await platformDb
      .insert(legalEntities)
      .values({
        tenantId,
        name: "Ageing E2E Entity",
        code: "AGE1",
        countryCode: "AE",
        currencyCode: "AED",
        isDefault: true,
      })
      .returning();
    legalEntityId = entity!.id;

    const financeDb = getFinanceDb();
    const [exp] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `AGE-EXP-${suffix}`,
        name: "Office Supplies",
        type: "EXPENSE",
      })
      .returning();
    const [liability] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `AGE-AP-${suffix}`,
        name: "Accounts Payable",
        type: "LIABILITY",
      })
      .returning();
    const [bank] = await financeDb
      .insert(chartOfAccounts)
      .values({
        tenantId,
        legalEntityId,
        code: `AGE-BANK-${suffix}`,
        name: "Main Bank",
        type: "ASSET",
      })
      .returning();
    expenseAccountId = exp!.id;
    liabilityAccountId = liability!.id;
    bankAccountId = bank!.id;

    adminToken = tokenFor(["finance.admin"]);
    posterToken = tokenFor(["finance.poster"]);

    await request(app.getHttpServer())
      .post("/v1/finance/ap/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ apControlAccountId: liabilityAccountId })
      .expect(201);

    await request(app.getHttpServer())
      .post("/v1/finance/accounting-periods")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: `AGE-OPEN-${suffix}`,
        startDate: "2025-01-01",
        endDate: "2027-12-31",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await closeFinanceDb();
    await closePlatformDb();
  });

  it("every bucket — one bill per bucket lands in the correct bucket, as of a fixed date", async () => {
    const supplierId = await newSupplier("Buckets");

    const notDue = await createAndPostBill(
      supplierId,
      "2026-05-01",
      dueDateAt(-10),
      100,
    ); // due in the future
    const current = await createAndPostBill(
      supplierId,
      "2026-05-01",
      dueDateAt(0),
      110,
    ); // due exactly today
    const b1to30 = await createAndPostBill(
      supplierId,
      "2026-05-01",
      dueDateAt(15),
      200,
    );
    const b31to60 = await createAndPostBill(
      supplierId,
      "2026-04-01",
      dueDateAt(45),
      300,
    );
    const b61to90 = await createAndPostBill(
      supplierId,
      "2026-03-01",
      dueDateAt(75),
      400,
    );
    const b91to120 = await createAndPostBill(
      supplierId,
      "2026-02-01",
      dueDateAt(105),
      500,
    );
    const b120plus = await createAndPostBill(
      supplierId,
      "2026-01-01",
      dueDateAt(200),
      600,
    );
    void notDue;
    void current;
    void b1to30;
    void b31to60;
    void b61to90;
    void b91to120;
    void b120plus;

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    // notDue + current both fall in the "current" bucket (daysPastDue <= 0).
    expect(row.currentMinor).toBe(100 + 110);
    expect(row.days1to30Minor).toBe(200);
    expect(row.days31to60Minor).toBe(300);
    expect(row.days61to90Minor).toBe(400);
    expect(row.days91to120Minor).toBe(500);
    expect(row.days120PlusMinor).toBe(600);
    expect(row.totalOutstandingMinor).toBe(
      100 + 110 + 200 + 300 + 400 + 500 + 600,
    );
  });

  it("a bill with no due date is bucketed as current", async () => {
    const supplierId = await newSupplier("NoDueDate");
    const created = await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `AGE-NODUE-${randomUUID()}`,
        billDate: "2026-01-01",
        lines: [{ accountId: expenseAccountId, amountMinor: 250 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/finance/bills/${created.body.data.id}/post`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data[0].currentMinor).toBe(250);
    expect(res.body.data[0].totalOutstandingMinor).toBe(250);
  });

  it("partial payment — the bill appears only for its remaining balance, in its due-date bucket", async () => {
    const supplierId = await newSupplier("PartialAgeing");
    const bill = await createAndPostBill(
      supplierId,
      "2026-04-01",
      dueDateAt(45),
      1000,
    );
    await createAndPostPayment(supplierId, "2026-05-01", 300, [
      { billId: bill.id, allocatedAmountMinor: 300 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data[0].days31to60Minor).toBe(700);
    expect(res.body.data[0].totalOutstandingMinor).toBe(700);
  });

  it("a fully paid bill is excluded entirely — the supplier does not appear as a row", async () => {
    const supplierId = await newSupplier("FullyPaidAgeing");
    const bill = await createAndPostBill(
      supplierId,
      "2026-04-01",
      dueDateAt(45),
      500,
    );
    await createAndPostPayment(supplierId, "2026-05-01", 500, [
      { billId: bill.id, allocatedAmountMinor: 500 },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("a DRAFT bill never appears in the ageing report", async () => {
    const supplierId = await newSupplier("DraftAgeing");
    await request(app.getHttpServer())
      .post("/v1/finance/bills")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({
        supplierId,
        supplierBillNumber: `AGE-DRAFT-${randomUUID()}`,
        billDate: "2026-04-01",
        dueDate: dueDateAt(45),
        lines: [{ accountId: expenseAccountId, amountMinor: 999 }],
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("multiple suppliers — each supplier's row reflects only its own bills", async () => {
    const supplierX = await newSupplier("AgeMultiX");
    const supplierY = await newSupplier("AgeMultiY");
    await createAndPostBill(supplierX, "2026-05-01", dueDateAt(15), 111);
    await createAndPostBill(supplierY, "2026-05-01", dueDateAt(15), 222);

    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const rowX = res.body.data.find(
      (r: { supplierId: string }) => r.supplierId === supplierX,
    );
    const rowY = res.body.data.find(
      (r: { supplierId: string }) => r.supplierId === supplierY,
    );
    expect(rowX.days1to30Minor).toBe(111);
    expect(rowY.days1to30Minor).toBe(222);
  });

  it("as-of date — the same bill lands in a different bucket depending on asOf", async () => {
    const supplierId = await newSupplier("AsOfShift");
    await createAndPostBill(supplierId, "2026-01-01", "2026-01-15", 800);

    const early = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=2026-01-20&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    expect(early.body.data[0].days1to30Minor).toBe(800);

    const later = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=2026-03-01&supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    // 2026-01-15 to 2026-03-01 is 45 days past due.
    expect(later.body.data[0].days31to60Minor).toBe(800);
  });

  it("report totals — meta totals equal the sum of the visible per-supplier rows", async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?asOf=${ASOF}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    const rows: Array<{
      currentMinor: number;
      days1to30Minor: number;
      days31to60Minor: number;
      days61to90Minor: number;
      days91to120Minor: number;
      days120PlusMinor: number;
      totalOutstandingMinor: number;
    }> = res.body.data;

    const sum = (key: keyof (typeof rows)[number]) =>
      rows.reduce((acc, r) => acc + r[key], 0);

    expect(res.body.meta.totalCurrentMinor).toBe(sum("currentMinor"));
    expect(res.body.meta.total1to30Minor).toBe(sum("days1to30Minor"));
    expect(res.body.meta.total31to60Minor).toBe(sum("days31to60Minor"));
    expect(res.body.meta.total61to90Minor).toBe(sum("days61to90Minor"));
    expect(res.body.meta.total91to120Minor).toBe(sum("days91to120Minor"));
    expect(res.body.meta.total120PlusMinor).toBe(sum("days120PlusMinor"));
    expect(res.body.meta.totalOutstandingMinor).toBe(
      sum("totalOutstandingMinor"),
    );
    expect(res.body.meta.supplierCount).toBe(rows.length);
  });

  it("reconciliation to supplier balances — a supplier's ageing totalOutstandingMinor equals its /balance totalOutstandingMinor", async () => {
    const supplierId = await newSupplier("AgeingReconcile");
    const bill = await createAndPostBill(
      supplierId,
      "2026-05-01",
      dueDateAt(15),
      900,
    );
    await createAndPostPayment(supplierId, "2026-05-10", 300, [
      { billId: bill.id, allocatedAmountMinor: 300 },
    ]);

    const ageing = await request(app.getHttpServer())
      .get(`/v1/finance/ap/ageing?supplierId=${supplierId}`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);
    const balance = await request(app.getHttpServer())
      .get(`/v1/finance/suppliers/${supplierId}/balance`)
      .set("Authorization", `Bearer ${posterToken}`)
      .expect(200);

    expect(ageing.body.data[0].totalOutstandingMinor).toBe(
      balance.body.data.totalOutstandingMinor,
    );
    expect(ageing.body.data[0].totalOutstandingMinor).toBe(600);
  });
});
