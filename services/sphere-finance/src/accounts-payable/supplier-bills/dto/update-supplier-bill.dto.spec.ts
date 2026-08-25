import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateSupplierBillDto } from "./update-supplier-bill.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateSupplierBillDto, input);
  return validate(dto);
}

describe("UpdateSupplierBillDto", () => {
  it("accepts an empty payload (no fields to change)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a partial payload updating only memo", async () => {
    const errors = await validateDto({ memo: "Updated memo" });
    expect(errors).toHaveLength(0);
  });

  it("accepts a full payload including replacement lines", async () => {
    const errors = await validateDto({
      supplierBillNumber: "INV-2026-002",
      billDate: "2026-01-20",
      dueDate: "2026-02-19",
      memo: "Revised",
      lines: [
        { accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", amountMinor: 500 },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date billDate", async () => {
    const errors = await validateDto({ billDate: "not-a-date" });
    expect(errors.some((e) => e.property === "billDate")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      lines: [{ accountId: "not-a-uuid", amountMinor: 500 }],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects an empty supplierBillNumber when provided", async () => {
    const errors = await validateDto({ supplierBillNumber: "" });
    expect(errors.some((e) => e.property === "supplierBillNumber")).toBe(true);
  });
});
