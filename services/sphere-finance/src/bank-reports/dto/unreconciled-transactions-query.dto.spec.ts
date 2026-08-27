import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UnreconciledTransactionsQueryDto } from "./unreconciled-transactions-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UnreconciledTransactionsQueryDto, input);
  return validate(dto);
}

describe("UnreconciledTransactionsQueryDto", () => {
  it("accepts an empty query — legal-entity-wide, asOf defaults to today", async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it("accepts bankCashAccountId alone", async () => {
    expect(
      await validateDto({
        bankCashAccountId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toHaveLength(0);
  });

  it("accepts asOf alone", async () => {
    expect(await validateDto({ asOf: "2026-08-21" })).toHaveLength(0);
  });

  it("rejects a malformed bankCashAccountId (not a UUID)", async () => {
    const errors = await validateDto({ bankCashAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "bankCashAccountId")).toBe(true);
  });

  it("rejects a malformed asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });
});
