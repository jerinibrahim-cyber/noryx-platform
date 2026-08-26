import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CustomerStatementQueryDto } from "./customer-statement-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CustomerStatementQueryDto, input);
  return validate(dto);
}

describe("CustomerStatementQueryDto", () => {
  it("accepts an empty payload (full history)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed dateFrom/dateTo range", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts dateFrom === dateTo (single-day range)", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-15",
      dateTo: "2026-01-15",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts dateFrom with no dateTo", async () => {
    const errors = await validateDto({ dateFrom: "2026-01-01" });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date dateFrom", async () => {
    const errors = await validateDto({ dateFrom: "not-a-date" });
    expect(errors.some((e) => e.property === "dateFrom")).toBe(true);
  });

  it("rejects a non-date dateTo", async () => {
    const errors = await validateDto({ dateTo: "not-a-date" });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });

  it("rejects dateTo before dateFrom", async () => {
    const errors = await validateDto({
      dateFrom: "2026-01-31",
      dateTo: "2026-01-01",
    });
    expect(errors.some((e) => e.property === "dateTo")).toBe(true);
  });
});
