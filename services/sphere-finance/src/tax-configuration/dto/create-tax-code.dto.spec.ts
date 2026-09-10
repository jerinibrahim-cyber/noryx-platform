import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateTaxCodeDto } from "./create-tax-code.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateTaxCodeDto, input);
  return validate(dto);
}

describe("CreateTaxCodeDto", () => {
  it("accepts a well-formed payload", async () => {
    const errors = await validateDto({
      code: "VAT-STD",
      name: "Standard Rate VAT",
      treatment: "STANDARD",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts every valid treatment value", async () => {
    for (const treatment of ["STANDARD", "ZERO_RATED", "EXEMPT"]) {
      const errors = await validateDto({
        code: "VAT-X",
        name: "X",
        treatment,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects a code with disallowed characters", async () => {
    const errors = await validateDto({
      code: "VAT / STD",
      name: "Standard Rate VAT",
      treatment: "STANDARD",
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects a missing name", async () => {
    const errors = await validateDto({
      code: "VAT-STD",
      treatment: "STANDARD",
    });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a missing treatment", async () => {
    const errors = await validateDto({ code: "VAT-STD", name: "Standard" });
    expect(errors.some((e) => e.property === "treatment")).toBe(true);
  });

  it("rejects an invalid treatment value (no reverse charge in MVP)", async () => {
    const errors = await validateDto({
      code: "VAT-STD",
      name: "Standard",
      treatment: "REVERSE_CHARGE",
    });
    expect(errors.some((e) => e.property === "treatment")).toBe(true);
  });
});
