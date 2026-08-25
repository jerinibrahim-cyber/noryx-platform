import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSupplierBillDto } from "./create-supplier-bill.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupplierBillDto, input);
  return validate(dto);
}

const ONE_LINE = [
  { accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", amountMinor: 1000 },
];

describe("CreateSupplierBillDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      dueDate: "2026-02-14",
      memo: "January office supplies",
      lines: ONE_LINE,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID supplierId", async () => {
    const errors = await validateDto({
      supplierId: "not-a-uuid",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "supplierId")).toBe(true);
  });

  it("rejects a missing supplierBillNumber", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      billDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "supplierBillNumber")).toBe(true);
  });

  it("accepts a supplierBillNumber containing characters that would fail an internal-code charset check", async () => {
    // Deliberately proves the "no @Matches charset restriction" design
    // decision from the proposal — this is the supplier's own external
    // reference text, not an internal identifier.
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV/2026 #001 (copy)",
      billDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date billDate", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "not-a-date",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "billDate")).toBe(true);
  });

  it("rejects a non-date dueDate", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      dueDate: "not-a-date",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "dueDate")).toBe(true);
  });

  it("rejects an empty lines array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      lines: [],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a missing lines array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      supplierBillNumber: "INV-2026-001",
      billDate: "2026-01-15",
      lines: [{ accountId: "not-a-uuid", amountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });
});
