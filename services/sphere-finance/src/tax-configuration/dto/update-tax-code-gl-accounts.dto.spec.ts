import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateTaxCodeGlAccountsDto } from "./update-tax-code-gl-accounts.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateTaxCodeGlAccountsDto, input);
  return validate(dto);
}

describe("UpdateTaxCodeGlAccountsDto", () => {
  it("accepts an empty payload — both fields are independently optional", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed apTaxAccountId alone", async () => {
    const errors = await validateDto({
      apTaxAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed arTaxAccountId alone", async () => {
    const errors = await validateDto({
      arTaxAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts both fields set together", async () => {
    const errors = await validateDto({
      apTaxAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      arTaxAccountId: "9b2e3c9a-1111-4c2a-9999-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts an explicit null on either field — clears the override", async () => {
    const errors = await validateDto({
      apTaxAccountId: null,
      arTaxAccountId: null,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID apTaxAccountId", async () => {
    const errors = await validateDto({ apTaxAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "apTaxAccountId")).toBe(true);
  });

  it("rejects a non-UUID arTaxAccountId", async () => {
    const errors = await validateDto({ arTaxAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "arTaxAccountId")).toBe(true);
  });
});
