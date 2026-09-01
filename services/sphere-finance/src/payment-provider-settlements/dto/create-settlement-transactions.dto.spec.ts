import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSettlementTransactionsDto } from "./create-settlement-transactions.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSettlementTransactionsDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_B = "4fa85f64-5717-4562-b3fc-2c963f66afa6";

const BASE = {
  destinationBankCashAccountId: UUID_A,
};

describe("CreateSettlementTransactionsDto", () => {
  it("accepts a well-formed minimal payload", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      ...BASE,
      feeGlAccountId: UUID_B,
      transactionDate: "2026-01-15",
      reference: "SETTLE-000123",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing destinationBankCashAccountId", async () => {
    const errors = await validateDto({});
    expect(
      errors.some((e) => e.property === "destinationBankCashAccountId"),
    ).toBe(true);
  });

  it("rejects a non-UUID destinationBankCashAccountId", async () => {
    const errors = await validateDto({
      ...BASE,
      destinationBankCashAccountId: "nope",
    });
    expect(
      errors.some((e) => e.property === "destinationBankCashAccountId"),
    ).toBe(true);
  });

  it("rejects a non-UUID feeGlAccountId", async () => {
    const errors = await validateDto({ ...BASE, feeGlAccountId: "nope" });
    expect(errors.some((e) => e.property === "feeGlAccountId")).toBe(true);
  });

  it("rejects a non-date transactionDate", async () => {
    const errors = await validateDto({
      ...BASE,
      transactionDate: "not-a-date",
    });
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects a reference above the maxlength bound", async () => {
    const errors = await validateDto({ ...BASE, reference: "R".repeat(101) });
    expect(errors.some((e) => e.property === "reference")).toBe(true);
  });
});
