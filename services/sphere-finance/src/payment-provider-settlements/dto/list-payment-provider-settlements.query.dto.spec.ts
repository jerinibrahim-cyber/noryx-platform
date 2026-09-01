import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ListPaymentProviderSettlementsQueryDto } from "./list-payment-provider-settlements.query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ListPaymentProviderSettlementsQueryDto, input);
  return validate(dto);
}

describe("ListPaymentProviderSettlementsQueryDto", () => {
  it("accepts an empty payload (matchStatus optional)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts every valid matchStatus value", async () => {
    for (const matchStatus of [
      "UNMATCHED",
      "PARTIALLY_MATCHED",
      "MATCHED",
      "IGNORED",
    ]) {
      const errors = await validateDto({ matchStatus });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects an invalid matchStatus value", async () => {
    const errors = await validateDto({ matchStatus: "PENDING" });
    expect(errors.some((e) => e.property === "matchStatus")).toBe(true);
  });
});
