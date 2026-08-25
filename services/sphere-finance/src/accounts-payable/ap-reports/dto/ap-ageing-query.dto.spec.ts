import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ApAgeingQueryDto } from "./ap-ageing-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ApAgeingQueryDto, input);
  return validate(dto);
}

describe("ApAgeingQueryDto", () => {
  it("accepts an empty payload (asOf defaults to today, all suppliers)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed asOf", async () => {
    const errors = await validateDto({ asOf: "2026-01-15" });
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed supplierId", async () => {
    const errors = await validateDto({
      supplierId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects a non-UUID supplierId", async () => {
    const errors = await validateDto({ supplierId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "supplierId")).toBe(true);
  });
});
