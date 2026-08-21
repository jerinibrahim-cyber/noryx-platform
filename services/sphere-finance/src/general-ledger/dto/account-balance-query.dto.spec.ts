import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { AccountBalanceQueryDto } from "./account-balance-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(AccountBalanceQueryDto, input);
  return validate(dto);
}

describe("AccountBalanceQueryDto", () => {
  it("accepts an empty query — asOf defaults to today server-side (§3.1.1/§4.8)", async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it("accepts asOf alone", async () => {
    expect(await validateDto({ asOf: "2026-08-21" })).toHaveLength(0);
  });

  it("accepts dateFrom/dateTo range mode", async () => {
    expect(
      await validateDto({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
    ).toHaveLength(0);
  });

  it("accepts periodId alone", async () => {
    expect(
      await validateDto({
        periodId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toHaveLength(0);
  });

  it("rejects asOf combined with dateFrom", async () => {
    const errors = await validateDto({
      asOf: "2026-08-21",
      dateFrom: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects asOf combined with dateTo", async () => {
    const errors = await validateDto({
      asOf: "2026-08-21",
      dateTo: "2026-01-31",
    });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects asOf combined with periodId", async () => {
    const errors = await validateDto({
      asOf: "2026-08-21",
      periodId: "11111111-1111-4111-8111-111111111111",
    });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects periodId combined with dateFrom, even with no asOf present", async () => {
    const errors = await validateDto({
      periodId: "11111111-1111-4111-8111-111111111111",
      dateFrom: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "periodId")).toBe(true);
  });

  it("rejects dateTo before dateFrom", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-31",
      dateTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });
});
