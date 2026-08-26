import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateCustomerReceiptDto } from "./update-customer-receipt.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateCustomerReceiptDto, input);
  return validate(dto);
}

describe("UpdateCustomerReceiptDto", () => {
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
      receiptDate: "2026-01-20",
      receiptAmountMinor: 500,
      receiptMethod: "CASH",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      reference: "Updated ref",
      memo: "Revised",
      allocations: [
        {
          invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          allocatedAmountMinor: 500,
        },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date receiptDate", async () => {
    const errors = await validateDto({ receiptDate: "not-a-date" });
    expect(errors.some((e) => e.property === "receiptDate")).toBe(true);
  });

  it("rejects an invalid receiptMethod", async () => {
    const errors = await validateDto({ receiptMethod: "CRYPTO" });
    expect(errors.some((e) => e.property === "receiptMethod")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      allocations: [{ invoiceId: "not-a-uuid", allocatedAmountMinor: 500 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });
});
