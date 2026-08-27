import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateCustomerCreditNoteAllocationDto } from "./create-customer-credit-note-allocation.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateCustomerCreditNoteAllocationDto, input);
  return validate(dto);
}

describe("CreateCustomerCreditNoteAllocationDto", () => {
  it("accepts a well-formed payload", async () => {
    const errors = await validateDto({
      invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocatedAmountMinor: 1000,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID invoiceId", async () => {
    const errors = await validateDto({
      invoiceId: "not-a-uuid",
      allocatedAmountMinor: 1000,
    });
    expect(errors.some((e) => e.property === "invoiceId")).toBe(true);
  });

  it("rejects a missing allocatedAmountMinor", async () => {
    const errors = await validateDto({
      invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors.some((e) => e.property === "allocatedAmountMinor")).toBe(
      true,
    );
  });

  it("rejects a zero allocatedAmountMinor", async () => {
    const errors = await validateDto({
      invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocatedAmountMinor: 0,
    });
    expect(errors.some((e) => e.property === "allocatedAmountMinor")).toBe(
      true,
    );
  });

  it("rejects a negative allocatedAmountMinor", async () => {
    const errors = await validateDto({
      invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocatedAmountMinor: -100,
    });
    expect(errors.some((e) => e.property === "allocatedAmountMinor")).toBe(
      true,
    );
  });
});
