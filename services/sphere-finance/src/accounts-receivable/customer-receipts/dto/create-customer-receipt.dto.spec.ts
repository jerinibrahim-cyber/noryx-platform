import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateCustomerReceiptDto } from "./create-customer-receipt.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateCustomerReceiptDto, input);
  return validate(dto);
}

const ONE_ALLOCATION = [
  {
    invoiceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    allocatedAmountMinor: 1000,
  },
];

describe("CreateCustomerReceiptDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "CHEQUE",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      reference: "CHQ-00417",
      memo: "January settlement",
      allocations: ONE_ALLOCATION,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every payment_method value (reused enum — no receipt-only value set)", async () => {
    for (const method of ["BANK_TRANSFER", "CHEQUE", "CASH", "CARD", "OTHER"]) {
      const errors = await validateDto({
        customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        receiptDate: "2026-01-15",
        receiptAmountMinor: 1000,
        receiptMethod: method,
        bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        allocations: ONE_ALLOCATION,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects a non-UUID customerId", async () => {
    const errors = await validateDto({
      customerId: "not-a-uuid",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "customerId")).toBe(true);
  });

  it("rejects a non-date receiptDate", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "not-a-date",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "receiptDate")).toBe(true);
  });

  it("rejects a zero/missing receiptAmountMinor", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 0,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "receiptAmountMinor")).toBe(true);
  });

  it("rejects an invalid receiptMethod", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "CRYPTO",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "receiptMethod")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "not-a-uuid",
      allocations: ONE_ALLOCATION,
    });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects an empty allocations array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: [],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a missing allocations array", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      receiptDate: "2026-01-15",
      receiptAmountMinor: 1000,
      receiptMethod: "BANK_TRANSFER",
      bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      allocations: [{ invoiceId: "not-a-uuid", allocatedAmountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });
});
