import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ClearingReconciliationQueryDto } from "./clearing-reconciliation-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ClearingReconciliationQueryDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const BASE = {
  bankCashAccountId: UUID_A,
};

describe("ClearingReconciliationQueryDto", () => {
  it("accepts a well-formed minimal payload", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed date range", async () => {
    const errors = await validateDto({
      ...BASE,
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts dateFrom equal to dateTo", async () => {
    const errors = await validateDto({
      ...BASE,
      dateFrom: "2026-01-15",
      dateTo: "2026-01-15",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing bankCashAccountId", async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({ bankCashAccountId: "nope" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a non-date dateFrom", async () => {
    const errors = await validateDto({ ...BASE, dateFrom: "not-a-date" });
    expect(errors.some((e) => e.property === "dateFrom")).toBe(true);
  });

  it("rejects a non-date dateTo", async () => {
    const errors = await validateDto({ ...BASE, dateTo: "not-a-date" });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });

  it("rejects dateTo before dateFrom", async () => {
    const errors = await validateDto({
      ...BASE,
      dateFrom: "2026-01-31",
      dateTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });
});
