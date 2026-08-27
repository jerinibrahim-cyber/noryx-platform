import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateBankTransactionDto } from "./update-bank-transaction.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateBankTransactionDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("UpdateBankTransactionDto", () => {
  it("accepts an empty payload — every field is optional", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a single-field partial update (memo only)", async () => {
    const errors = await validateDto({ memo: "Corrected memo" });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      transactionDate: "2026-02-01",
      amountMinor: 2000,
      bankCashAccountId: UUID_A,
      glAccountId: UUID_A,
      reference: "BANK-REF-000456",
      memo: "Updated",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date transactionDate", async () => {
    const errors = await validateDto({ transactionDate: "not-a-date" });
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects a zero amountMinor", async () => {
    const errors = await validateDto({ amountMinor: 0 });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({ bankCashAccountId: "nope" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a non-UUID counterpartyBankCashAccountId", async () => {
    const errors = await validateDto({ counterpartyBankCashAccountId: "nope" });
    expect(
      errors.some((e) => e.property === "counterpartyBankCashAccountId"),
    ).toBe(true);
  });

  it("rejects a non-UUID glAccountId", async () => {
    const errors = await validateDto({ glAccountId: "nope" });
    expect(errors.some((e) => e.property === "glAccountId")).toBe(true);
  });

  it("rejects a reference above the maxlength bound", async () => {
    const errors = await validateDto({ reference: "R".repeat(101) });
    expect(errors.some((e) => e.property === "reference")).toBe(true);
  });

  it("rejects a memo above the maxlength bound", async () => {
    const errors = await validateDto({ memo: "M".repeat(2001) });
    expect(errors.some((e) => e.property === "memo")).toBe(true);
  });
});
