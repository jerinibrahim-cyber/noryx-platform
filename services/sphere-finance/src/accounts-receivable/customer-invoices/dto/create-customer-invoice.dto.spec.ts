import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateCustomerInvoiceDto } from "./create-customer-invoice.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateCustomerInvoiceDto, input);
  return validate(dto);
}

const ONE_LINE = [
  { accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", amountMinor: 1000 },
];

describe("CreateCustomerInvoiceDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
      dueDate: "2026-02-14",
      memo: "January consulting services",
      lines: ONE_LINE,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID customerId", async () => {
    const errors = await validateDto({
      customerId: "not-a-uuid",
      invoiceDate: "2026-01-15",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "customerId")).toBe(true);
  });

  it("rejects a non-date invoiceDate", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "not-a-date",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "invoiceDate")).toBe(true);
  });

  it("rejects a non-date dueDate", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
      dueDate: "not-a-date",
      lines: ONE_LINE,
    });
    expect(errors.some((e) => e.property === "dueDate")).toBe(true);
  });

  it("rejects an empty lines array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
      lines: [],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a missing lines array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });

  it("rejects a lines array containing an invalid line", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      invoiceDate: "2026-01-15",
      lines: [{ accountId: "not-a-uuid", amountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });
});
