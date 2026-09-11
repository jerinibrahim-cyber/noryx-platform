import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { VatPositionQueryDto } from "./vat-position-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(VatPositionQueryDto, input);
  return validate(dto);
}

describe("VatPositionQueryDto", () => {
  it("accepts an empty query — the service requires an explicit window at request time, not this DTO", async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it("accepts dateFrom and dateTo together", async () => {
    expect(
      await validateDto({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
    ).toHaveLength(0);
  });

  it("accepts dateFrom alone", async () => {
    expect(await validateDto({ dateFrom: "2026-01-01" })).toHaveLength(0);
  });

  it("accepts dateTo alone", async () => {
    expect(await validateDto({ dateTo: "2026-01-31" })).toHaveLength(0);
  });

  it("accepts dateFrom === dateTo (a single-day window)", async () => {
    expect(
      await validateDto({ dateFrom: "2026-01-15", dateTo: "2026-01-15" }),
    ).toHaveLength(0);
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

  it("rejects a malformed dateTo", async () => {
    const errors = await validateDto({ dateTo: "not-a-date" });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });

  // The DTO class deliberately declares no `asOf` field — VAT position is
  // movement-only, never a single point in time (discovery §3.4). The real
  // runtime proof that an unknown `asOf` is rejected is the e2e suite's
  // whitelist-rejection test, the same distinction ProfitAndLossQueryDto's
  // own spec documents.
});
