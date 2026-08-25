import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateSupplierDto } from "./update-supplier.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateSupplierDto, input);
  return validate(dto);
}

describe("UpdateSupplierDto", () => {
  it("accepts an empty payload — every field is optional", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a single-field partial update", async () => {
    const errors = await validateDto({ name: "New Name" });
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const errors = await validateDto({ name: "" });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a non-UUID defaultExpenseAccountId", async () => {
    const errors = await validateDto({ defaultExpenseAccountId: "nope" });
    expect(errors.some((e) => e.property === "defaultExpenseAccountId")).toBe(
      true,
    );
  });

  it("rejects a negative paymentTermsDays", async () => {
    const errors = await validateDto({ paymentTermsDays: -5 });
    expect(errors.some((e) => e.property === "paymentTermsDays")).toBe(true);
  });
});
