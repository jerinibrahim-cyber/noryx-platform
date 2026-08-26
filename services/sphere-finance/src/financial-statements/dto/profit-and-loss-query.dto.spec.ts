import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ProfitAndLossQueryDto } from "./profit-and-loss-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ProfitAndLossQueryDto, input);
  return validate(dto);
}

describe("ProfitAndLossQueryDto", () => {
  it("accepts an empty query — dateFrom/dateTo default open-ended/today in the service", async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it("accepts dateFrom and dateTo together", async () => {
    expect(
      await validateDto({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
    ).toHaveLength(0);
  });

  it("accepts dateFrom alone (open-ended dateTo)", async () => {
    expect(await validateDto({ dateFrom: "2026-01-01" })).toHaveLength(0);
  });

  it("accepts dateTo alone (open-ended dateFrom)", async () => {
    expect(await validateDto({ dateTo: "2026-01-31" })).toHaveLength(0);
  });

  it("rejects dateTo before dateFrom", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-31",
      dateTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });

  it("accepts periodId alone", async () => {
    expect(
      await validateDto({
        periodId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toHaveLength(0);
  });

  it("rejects periodId combined with dateFrom", async () => {
    const errors = await validateDto({
      periodId: "11111111-1111-4111-8111-111111111111",
      dateFrom: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  it("rejects periodId combined with dateTo", async () => {
    const errors = await validateDto({
      periodId: "11111111-1111-4111-8111-111111111111",
      dateTo: "2026-01-31",
    });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  it("rejects a malformed periodId (not a UUID)", async () => {
    const errors = await validateDto({ periodId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  it("rejects a malformed dateFrom", async () => {
    const errors = await validateDto({ dateFrom: "not-a-date" });
    expect(errors.some((e) => e.property === "dateFrom")).toBe(true);
  });

  // The DTO class deliberately declares no `asOf` field at all — P&L is
  // movement-only, never a single point in time (§5.1 of the proposal).
  // `plainToInstance` alone doesn't strip an unrecognized input key
  // (that's `ValidationPipe({ whitelist: true })` at the HTTP layer),
  // and TypeScript itself already refuses `new ProfitAndLossQueryDto().
  // asOf` at compile time since no such property is typed — the real
  // runtime proof is the e2e suite's whitelist-rejection test (400 on an
  // unknown `asOf` query param), the same distinction AR-1d's own
  // reconciliation DTO spec documented for `customerId`. Nothing further
  // to assert here at the unit level.

  it("accepts an empty query — includeZeroBalance defaults false", async () => {
    const dto = plainToInstance(ProfitAndLossQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.includeZeroBalance).toBe(false);
  });

  it("coerces the string query-param form of includeZeroBalance", async () => {
    const trueDto = plainToInstance(ProfitAndLossQueryDto, {
      includeZeroBalance: "true",
    });
    expect(await validate(trueDto)).toHaveLength(0);
    expect(trueDto.includeZeroBalance).toBe(true);

    const falseDto = plainToInstance(ProfitAndLossQueryDto, {
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
