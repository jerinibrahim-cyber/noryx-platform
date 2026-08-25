import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSupplierPaymentDto } from "./create-supplier-payment.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupplierPaymentDto, input);
  return validate(dto);
}

const ONE_ALLOCATION = [
  {
    billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    allocatedAmountMinor: 1000,
  },
];

const BASE = {
  supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  paymentDate: "2026-01-15",
  paymentAmountMinor: 1000,
  paymentMethod: "BANK_TRANSFER",
  bankCashAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  allocations: ONE_ALLOCATION,
};

describe("CreateSupplierPaymentDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      ...BASE,
      reference: "CHQ-000123",
      memo: "January settlement",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID supplierId", async () => {
    const errors = await validateDto({ ...BASE, supplierId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "supplierId")).toBe(true);
  });

  it("rejects a non-date paymentDate", async () => {
    const errors = await validateDto({ ...BASE, paymentDate: "not-a-date" });
    expect(errors.some((e) => e.property === "paymentDate")).toBe(true);
  });

  it("rejects a zero paymentAmountMinor", async () => {
    const errors = await validateDto({ ...BASE, paymentAmountMinor: 0 });
    expect(errors.some((e) => e.property === "paymentAmountMinor")).toBe(true);
  });

  it("rejects a negative paymentAmountMinor", async () => {
    const errors = await validateDto({ ...BASE, paymentAmountMinor: -100 });
    expect(errors.some((e) => e.property === "paymentAmountMinor")).toBe(true);
  });

  it("rejects an unrecognized paymentMethod", async () => {
    const errors = await validateDto({ ...BASE, paymentMethod: "CRYPTO" });
    expect(errors.some((e) => e.property === "paymentMethod")).toBe(true);
  });

  it("accepts every documented paymentMethod value", async () => {
    for (const method of ["BANK_TRANSFER", "CHEQUE", "CASH", "CARD", "OTHER"]) {
      const errors = await validateDto({ ...BASE, paymentMethod: method });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({
      ...BASE,
      bankCashAccountId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("accepts a reference containing characters that would fail an internal-code charset check", async () => {
    const errors = await validateDto({
      ...BASE,
      reference: "Chq #001 (voided/reissued)",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty allocations array", async () => {
    const errors = await validateDto({ ...BASE, allocations: [] });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects a missing allocations array", async () => {
    const { allocations: _allocations, ...withoutAllocations } = BASE;
    void _allocations;
    const errors = await validateDto(withoutAllocations);
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects an allocations array containing an invalid allocation", async () => {
    const errors = await validateDto({
      ...BASE,
      allocations: [{ billId: "not-a-uuid", allocatedAmountMinor: 1000 }],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("rejects an allocation with a zero allocatedAmountMinor", async () => {
    const errors = await validateDto({
      ...BASE,
      allocations: [
        {
          billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          allocatedAmountMinor: 0,
        },
      ],
    });
    expect(errors.some((e) => e.property === "allocations")).toBe(true);
  });

  it("accepts multiple allocations in one payment", async () => {
    const errors = await validateDto({
      ...BASE,
      allocations: [
        {
          billId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          allocatedAmountMinor: 400,
        },
        {
          billId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          allocatedAmountMinor: 600,
        },
      ],
    });
    expect(errors).toHaveLength(0);
  });
});
