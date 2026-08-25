import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSupplierBillLineDto } from "./create-supplier-bill-line.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupplierBillLineDto, input);
  return validate(dto);
}

describe("CreateSupplierBillLineDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      amountMinor: 1000,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      description: "Office supplies",
      amountMinor: 1000,
      taxAmountMinor: 50,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID accountId", async () => {
    const errors = await validateDto({
      accountId: "not-a-uuid",
      amountMinor: 1000,
    });
    expect(errors.some((e) => e.property === "accountId")).toBe(true);
  });

  it("rejects a missing amountMinor", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a zero amountMinor", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      amountMinor: 0,
    });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a negative amountMinor", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      amountMinor: -100,
    });
    expect(errors.some((e) => e.property === "amountMinor")).toBe(true);
  });

  it("rejects a negative taxAmountMinor", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      amountMinor: 1000,
      taxAmountMinor: -1,
    });
    expect(errors.some((e) => e.property === "taxAmountMinor")).toBe(true);
  });

  it("accepts a zero taxAmountMinor", async () => {
    const errors = await validateDto({
      accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      amountMinor: 1000,
      taxAmountMinor: 0,
    });
    expect(errors).toHaveLength(0);
  });
});
