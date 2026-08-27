import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateSupplierDebitNoteDto } from "./update-supplier-debit-note.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateSupplierDebitNoteDto, input);
  return validate(dto);
}

describe("UpdateSupplierDebitNoteDto", () => {
  it("accepts an empty payload (no fields to change)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a partial payload updating only memo", async () => {
    const errors = await validateDto({ memo: "Updated memo" });
    expect(errors).toHaveLength(0);
  });

  it("accepts a full payload including replacement lines and allocations", async () => {
    const errors = await validateDto({
      debitNoteDate: "2026-01-20",
      reason: "Pricing correction",
      memo: "Revised",
      lines: [
        {
          accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          amountMinor: 500,
        },
      ],
      allocations: [
        {
          billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          allocatedAmountMinor: 500,
        },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date debitNoteDate", async () => {
    const errors = await validateDto({ debitNoteDate: "not-a-date" });
    expect(errors.some((e) => e.property === "debitNoteDate")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      lines: [{ accountId: "not-a-uuid", amountMinor: 500 }],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      allocations: [{ billId: "not-a-uuid", allocatedAmountMinor: 500 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });
});
