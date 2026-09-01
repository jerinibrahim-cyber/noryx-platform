import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ImportPaymentProviderSettlementDto } from "./import-payment-provider-settlement.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ImportPaymentProviderSettlementDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const BASE = {
  bankCashAccountId: UUID_A,
};

describe("ImportPaymentProviderSettlementDto", () => {
  it("accepts a well-formed minimal payload", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      ...BASE,
      providerFormat: "GENERIC_SETTLEMENT_CSV",
      fileName: "settlements-2026-01.csv",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing bankCashAccountId", async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({ ...BASE, bankCashAccountId: "nope" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects an invalid providerFormat value", async () => {
    const errors = await validateDto({
      ...BASE,
      providerFormat: "STRIPE_NATIVE",
    });
    expect(errors.some((e) => e.property === "providerFormat")).toBe(true);
  });

  it("rejects a fileName above the maxlength bound", async () => {
    const errors = await validateDto({ ...BASE, fileName: "f".repeat(256) });
    expect(errors.some((e) => e.property === "fileName")).toBe(true);
  });
});
