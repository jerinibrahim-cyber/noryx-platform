import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CashPositionQueryDto } from "./cash-position-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CashPositionQueryDto, input);
  return validate(dto);
}

describe("CashPositionQueryDto", () => {
  it("accepts an empty query — asOf defaults to today, includeInactive defaults false", async () => {
    const dto = plainToInstance(CashPositionQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.includeInactive).toBe(false);
  });

  it("accepts asOf alone", async () => {
    expect(await validateDto({ asOf: "2026-08-21" })).toHaveLength(0);
  });

  it("rejects a malformed asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("coerces the string query-param form of includeInactive", async () => {
    const trueDto = plainToInstance(CashPositionQueryDto, {
      includeInactive: "true",
    });
    expect(await validate(trueDto)).toHaveLength(0);
    expect(trueDto.includeInactive).toBe(true);

    const falseDto = plainToInstance(CashPositionQueryDto, {
      includeInactive: "false",
    });
    expect(await validate(falseDto)).toHaveLength(0);
    expect(falseDto.includeInactive).toBe(false);
  });

  it("rejects a non-boolean includeInactive", async () => {
    const errors = await validateDto({ includeInactive: "not-a-bool" });
    expect(errors.some((e) => e.property === "includeInactive")).toBe(true);
  });
});
