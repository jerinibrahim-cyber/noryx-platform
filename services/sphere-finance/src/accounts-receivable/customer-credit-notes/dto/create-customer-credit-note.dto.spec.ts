import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateCustomerCreditNoteDto } from "./create-customer-credit-note.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateCustomerCreditNoteDto, input);
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
    invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    allocatedAmountMinor: 1000,
  },
];

describe("CreateCustomerCreditNoteDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      reason: "Return",
      memo: "Customer returned goods",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID customerId", async () => {
    const errors = await validateDto({
      customerId: "not-a-uuid",
      creditNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "customerId")).toBe(true);
  });

  it("rejects a non-date creditNoteDate", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "not-a-date",
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "creditNoteDate")).toBe(true);
  });

  it("rejects an empty lines array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: [],
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a missing lines array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: [{ accountId: "not-a-uuid", amountMinor: 1000 }],
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects an empty allocations array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: [],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a missing allocations array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      lines: ONE_LINE,
      allocations: [{ invoiceId: "not-a-uuid", allocatedAmountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a reason exceeding 500 characters", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      creditNoteDate: "2026-01-15",
      reason: "x".repeat(501),
      lines: ONE_LINE,
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });
});
