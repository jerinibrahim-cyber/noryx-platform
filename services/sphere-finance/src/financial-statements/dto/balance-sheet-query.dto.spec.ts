import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { BalanceSheetQueryDto } from "./balance-sheet-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(BalanceSheetQueryDto, input);
  return validate(dto);
}

describe("BalanceSheetQueryDto", () => {
  it("accepts an empty query — asOf defaults to today in the service", async () => {
    expect(await validateDto({})).toHaveLength(0);
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

  it("rejects a malformed asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects a malformed periodId (not a UUID)", async () => {
    const errors = await validateDto({ periodId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  // The DTO class deliberately declares no `dateFrom`/`dateTo` fields at
  // all — Balance Sheet is a point-in-time snapshot, never a range
  // (§5.2 of the proposal). Same reasoning as `ProfitAndLossQueryDto`'s
  // own doc comment on its missing `asOf` field: the real runtime proof
  // is the e2e suite's whitelist-rejection test, not a `plainToInstance`
  // assertion here (that tool doesn't strip unrecognized keys on its
  // own — `ValidationPipe({ whitelist: true })` does, at the HTTP
  // layer).

  it("accepts an empty query — includeZeroBalance defaults false", async () => {
    const dto = plainToInstance(BalanceSheetQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.includeZeroBalance).toBe(false);
  });

  it("coerces the string query-param form of includeZeroBalance", async () => {
    const trueDto = plainToInstance(BalanceSheetQueryDto, {
      includeZeroBalance: "true",
    });
    expect(await validate(trueDto)).toHaveLength(0);
    expect(trueDto.includeZeroBalance).toBe(true);

    const falseDto = plainToInstance(BalanceSheetQueryDto, {
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
