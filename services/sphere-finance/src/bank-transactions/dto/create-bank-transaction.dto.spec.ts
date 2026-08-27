import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateBankTransactionDto } from "./create-bank-transaction.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateBankTransactionDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_B = "4fa85f64-5717-4562-b3fc-2c963f66afa6";

const TRANSFER_BASE = {
  type: "TRANSFER",
  transactionDate: "2026-01-15",
  amountMinor: 1000,
  bankCashAccountId: UUID_A,
  counterpartyBankCashAccountId: UUID_B,
};

const FEE_BASE = {
  type: "FEE",
  transactionDate: "2026-01-15",
  amountMinor: 500,
  bankCashAccountId: UUID_A,
  glAccountId: UUID_B,
};

describe("CreateBankTransactionDto", () => {
  it("accepts a well-formed TRANSFER payload", async () => {
    const errors = await validateDto(TRANSFER_BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed non-TRANSFER payload (FEE)", async () => {
    const errors = await validateDto(FEE_BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      ...FEE_BASE,
      reference: "BANK-REF-000123",
      memo: "Monthly account fee",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every non-TRANSFER type with the same shape (DEPOSIT/WITHDRAWAL/INTEREST)", async () => {
    for (const type of ["DEPOSIT", "WITHDRAWAL", "INTEREST"]) {
      const errors = await validateDto({ ...FEE_BASE, type });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects a missing required field", async () => {
    const errors = await validateDto({
      type: "FEE",
      transactionDate: "2026-01-15",
      amountMinor: 500,
      bankCashAccountId: UUID_A,
      // glAccountId omitted
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an invalid type value", async () => {
    const errors = await validateDto({ ...FEE_BASE, type: "REFUND" });
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a non-date transactionDate", async () => {
    const errors = await validateDto({
      ...FEE_BASE,
      transactionDate: "not-a-date",
    });
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects a zero amountMinor", async () => {
    const errors = await validateDto({ ...FEE_BASE, amountMinor: 0 });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a negative amountMinor", async () => {
    const errors = await validateDto({ ...FEE_BASE, amountMinor: -100 });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({
      ...FEE_BASE,
      bankCashAccountId: "nope",
    });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a non-UUID counterpartyBankCashAccountId", async () => {
    const errors = await validateDto({
      ...TRANSFER_BASE,
      counterpartyBankCashAccountId: "nope",
    });
    expect(
      errors.some((e) => e.property === "counterpartyBankCashAccountId"),
    ).toBe(true);
  });

  it("rejects a non-UUID glAccountId", async () => {
    const errors = await validateDto({ ...FEE_BASE, glAccountId: "nope" });
    expect(errors.some((e) => e.property === "glAccountId")).toBe(true);
  });

  it("rejects a reference above the maxlength bound", async () => {
    const errors = await validateDto({
      ...FEE_BASE,
      reference: "R".repeat(101),
    });
    expect(errors.some((e) => e.property === "reference")).toBe(true);
  });

  it("rejects a memo above the maxlength bound", async () => {
    const errors = await validateDto({ ...FEE_BASE, memo: "M".repeat(2001) });
    expect(errors.some((e) => e.property === "memo")).toBe(true);
  });

  // ---------------------------------------------------------------------
  // The IsValidBankTransactionAccountShape constraint (the DTO-layer
  // mirror of the bank_transactions_transfer_counterparty_shape DB CHECK).
  // ---------------------------------------------------------------------

  it("rejects a TRANSFER payload missing counterpartyBankCashAccountId", async () => {
    const { counterpartyBankCashAccountId: _drop, ...payload } = TRANSFER_BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a TRANSFER payload that wrongly supplies glAccountId instead of counterpartyBankCashAccountId", async () => {
    const { counterpartyBankCashAccountId: _drop, ...rest } = TRANSFER_BASE;
    const errors = await validateDto({ ...rest, glAccountId: UUID_B });
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a TRANSFER payload that supplies BOTH counterpartyBankCashAccountId and glAccountId", async () => {
    const errors = await validateDto({ ...TRANSFER_BASE, glAccountId: UUID_B });
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a non-TRANSFER payload missing glAccountId", async () => {
    const { glAccountId: _drop, ...payload } = FEE_BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a non-TRANSFER payload that wrongly supplies counterpartyBankCashAccountId instead of glAccountId", async () => {
    const { glAccountId: _drop, ...rest } = FEE_BASE;
    const errors = await validateDto({
      ...rest,
      counterpartyBankCashAccountId: UUID_B,
    });
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });
});
