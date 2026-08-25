import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateSupplierPaymentDto } from "./update-supplier-payment.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateSupplierPaymentDto, input);
  return validate(dto);
}

describe("UpdateSupplierPaymentDto", () => {
  it("accepts an empty payload (no fields to change)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a partial payload updating only memo", async () => {
    const errors = await validateDto({ memo: "Updated memo" });
    expect(errors).toHaveLength(0);
  });

  it("accepts a full payload including replacement allocations", async () => {
    const errors = await validateDto({
      paymentDate: "2026-01-20",
      paymentAmountMinor: 500,
      paymentMethod: "CHEQUE",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      reference: "CHQ-000456",
      memo: "Revised",
      allocations: [
        {
          billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          allocatedAmountMinor: 500,
        },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date paymentDate", async () => {
    const errors = await validateDto({ paymentDate: "not-a-date" });
    expect(errors.some((e) => e.property === "paymentDate")).toBe(true);
  });

  it("rejects a zero paymentAmountMinor when provided", async () => {
    const errors = await validateDto({ paymentAmountMinor: 0 });
    expect(errors.some((e) => e.property === "paymentAmountMinor")).toBe(true);
  });

  it("rejects an unrecognized paymentMethod", async () => {
    const errors = await validateDto({ paymentMethod: "CRYPTO" });
    expect(errors.some((e) => e.property === "paymentMethod")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId when provided", async () => {
    const errors = await validateDto({ bankCashAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      allocations: [{ billId: "not-a-uuid", allocatedAmountMinor: 500 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("accepts an empty allocations array (full replacement with none)", async () => {
    // Unlike CreateSupplierPaymentDto, no ArrayMinSize on update — the
    // >=1 requirement is enforced at posting time, not edit time, same
    // convention as UpdateSupplierBillDto.lines.
    const errors = await validateDto({ allocations: [] });
    expect(errors).toHaveLength(0);
  });
});
