import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CustomerBalanceQueryDto } from "./customer-balance-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CustomerBalanceQueryDto, input);
  return validate(dto);
}

describe("CustomerBalanceQueryDto", () => {
  it("accepts an empty payload (current mode)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed asOf", async () => {
    const errors = await validateDto({ asOf: "2026-01-15" });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });
});
