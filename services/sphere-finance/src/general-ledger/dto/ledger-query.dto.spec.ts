import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { LedgerQueryDto } from "./ledger-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(LedgerQueryDto, input);
  return validate(dto);
}

describe("LedgerQueryDto", () => {
  it("accepts an empty query — page/pageSize default, no date filter", async () => {
    const dto = plainToInstance(LedgerQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(50);
  });

  it("accepts dateFrom/dateTo alone, or together", async () => {
    expect(await validateDto({ dateFrom: "2026-01-01" })).toHaveLength(0);
    expect(await validateDto({ dateTo: "2026-01-31" })).toHaveLength(0);
    expect(
      await validateDto({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
    ).toHaveLength(0);
  });

  it("accepts dateFrom === dateTo (a single-day range)", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-15",
      dateTo: "2026-01-15",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects dateTo before dateFrom", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-31",
      dateTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });

  it("accepts periodId alone", async () => {
    const errors = await validateDto({
      periodId: "11111111-1111-4111-8111-111111111111",
    });
    expect(errors).toHaveLength(0);
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

  it("rejects pageSize outside [1, 200]", async () => {
    expect(
      (await validateDto({ pageSize: 0 })).some(
        (e) => e.property === "pageSize",
      ),
    ).toBe(true);
    expect(
      (await validateDto({ pageSize: 201 })).some(
        (e) => e.property === "pageSize",
      ),
    ).toBe(true);
  });

  it("rejects page < 1", async () => {
    const errors = await validateDto({ page: 0 });
    expect(errors.some((e) => e.property === "page")).toBe(true);
  });
});
