import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateTaxRateDto } from "./create-tax-rate.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateTaxRateDto, input);
  return validate(dto);
}

describe("CreateTaxRateDto", () => {
  it("accepts a well-formed payload with an open-ended effectiveTo", async () => {
    const errors = await validateDto({
      rateBasisPoints: 500,
      effectiveFrom: "2026-01-01",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed payload with an explicit effectiveTo", async () => {
    const errors = await validateDto({
      rateBasisPoints: 500,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a negative rateBasisPoints", async () => {
    const errors = await validateDto({
      rateBasisPoints: -1,
      effectiveFrom: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "rateBasisPoints")).toBe(true);
  });

  it("rejects a rateBasisPoints above the sanity bound (>100%)", async () => {
    const errors = await validateDto({
      rateBasisPoints: 10001,
      effectiveFrom: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "rateBasisPoints")).toBe(true);
  });

  it("rejects a missing effectiveFrom", async () => {
    const errors = await validateDto({ rateBasisPoints: 500 });
    expect(errors.some((e) => e.property === "effectiveFrom")).toBe(true);
  });

  it("rejects a malformed effectiveFrom", async () => {
    const errors = await validateDto({
      rateBasisPoints: 500,
      effectiveFrom: "not-a-date",
    });
    expect(errors.some((e) => e.property === "effectiveFrom")).toBe(true);
  });

  it("rejects effectiveTo equal to effectiveFrom", async () => {
    const errors = await validateDto({
      rateBasisPoints: 500,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "effectiveTo")).toBe(true);
  });

  it("rejects effectiveTo before effectiveFrom", async () => {
    const errors = await validateDto({
      rateBasisPoints: 500,
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "effectiveTo")).toBe(true);
  });
});
