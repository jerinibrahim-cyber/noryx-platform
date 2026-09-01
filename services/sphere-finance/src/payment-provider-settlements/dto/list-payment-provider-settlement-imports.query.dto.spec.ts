import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ListPaymentProviderSettlementImportsQueryDto } from "./list-payment-provider-settlement-imports.query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(
    ListPaymentProviderSettlementImportsQueryDto,
    input,
  );
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("ListPaymentProviderSettlementImportsQueryDto", () => {
  it("accepts an empty payload (all fields optional)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts every field when well-formed", async () => {
    const errors = await validateDto({
      bankCashAccountId: UUID_A,
      status: "VALIDATED",
      reconciliationStatus: "OPEN",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID bankCashAccountId", async () => {
    const errors = await validateDto({ bankCashAccountId: "nope" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects an invalid status value", async () => {
    const errors = await validateDto({ status: "PROCESSING" });
    expect(errors.some((e) => e.property === "status")).toBe(true);
  });

  it("rejects an invalid reconciliationStatus value", async () => {
    const errors = await validateDto({ reconciliationStatus: "PENDING" });
    expect(errors.some((e) => e.property === "reconciliationStatus")).toBe(
      true,
    );
  });
});
