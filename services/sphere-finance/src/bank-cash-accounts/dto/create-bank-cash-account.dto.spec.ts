import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateBankCashAccountDto } from "./create-bank-cash-account.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateBankCashAccountDto, input);
  return validate(dto);
}

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("CreateBankCashAccountDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Emirates NBD - Current Account",
      kind: "BANK",
      glAccountId: VALID_UUID,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      code: "BANK-002",
      name: "Emirates NBD - Current Account",
      kind: "BANK",
      glAccountId: VALID_UUID,
      bankName: "Emirates NBD",
      maskedAccountNumber: "****1234",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts kind = CASH", async () => {
    const errors = await validateDto({
      code: "CASH-001",
      name: "Main Till",
      kind: "CASH",
      glAccountId: VALID_UUID,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing code", async () => {
    const errors = await validateDto({
      name: "Main Till",
      kind: "CASH",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects a code with disallowed characters", async () => {
    const errors = await validateDto({
      code: "BANK / 001",
      name: "Main Till",
      kind: "CASH",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects a code above the maxlength bound", async () => {
    const errors = await validateDto({
      code: "B".repeat(33),
      name: "Main Till",
      kind: "CASH",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects a missing name", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      kind: "BANK",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a name above the maxlength bound", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "N".repeat(256),
      kind: "BANK",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a missing kind", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "kind")).toBe(true);
  });

  it("rejects an invalid kind value", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      kind: "SAVINGS",
      glAccountId: VALID_UUID,
    });
    expect(errors.some((e) => e.property === "kind")).toBe(true);
  });

  it("rejects a missing glAccountId", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      kind: "BANK",
    });
    expect(errors.some((e) => e.property === "glAccountId")).toBe(true);
  });

  it("rejects a non-UUID glAccountId", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      kind: "BANK",
      glAccountId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "glAccountId")).toBe(true);
  });

  it("rejects a bankName above the maxlength bound", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      kind: "BANK",
      glAccountId: VALID_UUID,
      bankName: "N".repeat(256),
    });
    expect(errors.some((e) => e.property === "bankName")).toBe(true);
  });

  it("rejects a maskedAccountNumber above the maxlength bound", async () => {
    const errors = await validateDto({
      code: "BANK-001",
      name: "Main Account",
      kind: "BANK",
      glAccountId: VALID_UUID,
      maskedAccountNumber: "1".repeat(51),
    });
    expect(errors.some((e) => e.property === "maskedAccountNumber")).toBe(true);
  });
});
