import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { TrialBalanceQueryDto } from "./trial-balance-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(TrialBalanceQueryDto, input);
  return validate(dto);
}

describe("TrialBalanceQueryDto", () => {
  it("accepts an empty query — asOf defaults to today, includeZeroBalance defaults false", async () => {
    const dto = plainToInstance(TrialBalanceQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.includeZeroBalance).toBe(false);
  });

  it("accepts asOf alone", async () => {
    expect(await validateDto({ asOf: "2026-08-21" })).toHaveLength(0);
  });

  it("accepts periodId alone", async () => {
    expect(
      await validateDto({
        periodId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toHaveLength(0);
  });

  it("rejects asOf combined with periodId", async () => {
    const errors = await validateDto({
      asOf: "2026-08-21",
      periodId: "11111111-1111-4111-8111-111111111111",
    });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects a malformed periodId (not a UUID)", async () => {
    const errors = await validateDto({ periodId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  it("coerces the string query-param form of includeZeroBalance", async () => {
    const trueDto = plainToInstance(TrialBalanceQueryDto, {
      includeZeroBalance: "true",
    });
    expect(await validate(trueDto)).toHaveLength(0);
    expect(trueDto.includeZeroBalance).toBe(true);

    const falseDto = plainToInstance(TrialBalanceQueryDto, {
      includeZeroBalance: "false",
    });
    expect(await validate(falseDto)).toHaveLength(0);
    expect(falseDto.includeZeroBalance).toBe(false);
  });

  it("rejects a non-boolean includeZeroBalance", async () => {
    const errors = await validateDto({ includeZeroBalance: "not-a-bool" });
    expect(errors.some((e) => e.property === "includeZeroBalance")).toBe(true);
  });
});
