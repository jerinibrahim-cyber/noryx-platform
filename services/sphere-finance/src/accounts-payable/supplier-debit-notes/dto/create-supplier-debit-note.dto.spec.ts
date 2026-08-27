import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSupplierDebitNoteDto } from "./create-supplier-debit-note.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupplierDebitNoteDto, input);
  return validate(dto);
}

const ONE_LINE = [
  {
    accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    amountMinor: 1000,
  },
];

const ONE_ALLOCATION = [
  {
    billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    allocatedAmountMinor: 1000,
  },
];

describe("CreateSupplierDebitNoteDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      reason: "Return",
      memo: "Returned goods to supplier",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID supplierId", async () => {
    const errors = await validateDto({
      supplierId: "not-a-uuid",
      debitNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "supplierId")).toBe(true);
  });

  it("rejects a non-date debitNoteDate", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "not-a-date",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "debitNoteDate")).toBe(true);
  });

  it("rejects an empty lines array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: [],
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a missing lines array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: [{ accountId: "not-a-uuid", amountMinor: 1000 }],
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects an empty allocations array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: [],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a missing allocations array", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: [{ billId: "not-a-uuid", allocatedAmountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a reason exceeding 500 characters", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      debitNoteDate: "2026-01-15",
      reason: "x".repeat(501),
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });
});
