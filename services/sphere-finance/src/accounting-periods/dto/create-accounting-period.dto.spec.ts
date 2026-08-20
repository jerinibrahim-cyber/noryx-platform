import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateAccountingPeriodDto } from "./create-accounting-period.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateAccountingPeriodDto, input);
  return validate(dto);
}

describe("CreateAccountingPeriodDto", () => {
  it("accepts a well-formed payload", async () => {
    const errors = await validateDto({
      code: "2026-08",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects endDate equal to startDate", async () => {
    const errors = await validateDto({
      code: "2026-08",
      startDate: "2026-08-01",
      endDate: "2026-08-01",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe("endDate");
  });

  it("rejects endDate before startDate", async () => {
    const errors = await validateDto({
      code: "2026-08",
      startDate: "2026-09-01",
      endDate: "2026-08-01",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe("endDate");
  });

  it("rejects a malformed startDate", async () => {
    const errors = await validateDto({
      code: "2026-08",
      startDate: "not-a-date",
      endDate: "2026-08-31",
    });
    expect(errors.some((e) => e.property === "startDate")).toBe(true);
  });

  it("rejects a missing code", async () => {
    const errors = await validateDto({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });
});
