import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSupplierDto } from "./create-supplier.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupplierDto, input);
  return validate(dto);
}

describe("CreateSupplierDto", () => {
  it("accepts a well-formed payload with only required fields", async () => {
    const errors = await validateDto({ code: "SUP-001", name: "Acme Co" });
    expect(errors).toHaveLength(0);
  });

  it("accepts every optional field when well-formed", async () => {
    const errors = await validateDto({
      code: "SUP-002",
      name: "Acme Co",
      paymentTermsDays: 30,
      taxRegistrationNo: "AE-VAT-123456",
      defaultExpenseAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a code with disallowed characters", async () => {
    const errors = await validateDto({ code: "SUP / 001", name: "Acme Co" });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects a missing name", async () => {
    const errors = await validateDto({ code: "SUP-001" });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });

  it("rejects a negative paymentTermsDays", async () => {
    const errors = await validateDto({
      code: "SUP-001",
      name: "Acme Co",
      paymentTermsDays: -1,
    });
    expect(errors.some((e) => e.property === "paymentTermsDays")).toBe(true);
  });

  it("rejects a paymentTermsDays above the sanity bound", async () => {
    const errors = await validateDto({
      code: "SUP-001",
      name: "Acme Co",
      paymentTermsDays: 999999,
    });
    expect(errors.some((e) => e.property === "paymentTermsDays")).toBe(true);
  });

  it("rejects a non-UUID defaultExpenseAccountId", async () => {
    const errors = await validateDto({
      code: "SUP-001",
      name: "Acme Co",
      defaultExpenseAccountId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "defaultExpenseAccountId")).toBe(
      true,
    );
  });
});
