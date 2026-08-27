import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateBankCashAccountDto } from "./update-bank-cash-account.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateBankCashAccountDto, input);
  return validate(dto);
}

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("UpdateBankCashAccountDto", () => {
  it("accepts an empty payload — every field is optional", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a single-field partial update (name only)", async () => {
    const errors = await validateDto({ name: "New Name" });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      name: "New Name",
      kind: "CASH",
      glAccountId: VALID_UUID,
      bankName: "New Bank",
      maskedAccountNumber: "****9999",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const errors = await validateDto({ name: "" });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a name above the maxlength bound", async () => {
    const errors = await validateDto({ name: "N".repeat(256) });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects an invalid kind value", async () => {
    const errors = await validateDto({ kind: "SAVINGS" });
    expect(errors.some((e) => e.property === "kind")).toBe(true);
  });

  it("rejects a non-UUID glAccountId", async () => {
    const errors = await validateDto({ glAccountId: "nope" });
    expect(errors.some((e) => e.property === "glAccountId")).toBe(true);
  });

  it("rejects a bankName above the maxlength bound", async () => {
    const errors = await validateDto({ bankName: "N".repeat(256) });
    expect(errors.some((e) => e.property === "bankName")).toBe(true);
  });

  it("rejects a maskedAccountNumber above the maxlength bound", async () => {
    const errors = await validateDto({
      maskedAccountNumber: "1".repeat(51),
    });
    expect(errors.some((e) => e.property === "maskedAccountNumber")).toBe(true);
  });
});
