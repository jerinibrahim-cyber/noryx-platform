import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreatePaymentSettlementMatchDto } from "./create-payment-settlement-match.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreatePaymentSettlementMatchDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const BASE = {
  bankStatementLineId: UUID_A,
  matchedAmountMinor: 1000,
};

describe("CreatePaymentSettlementMatchDto", () => {
  it("accepts a well-formed minimal payload", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("accepts an explicit matchType", async () => {
    const errors = await validateDto({
      ...BASE,
      matchType: "DETERMINISTIC_MATCH",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing bankStatementLineId", async () => {
    const { bankStatementLineId: _drop, ...payload } = BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "bankStatementLineId")).toBe(true);
  });

  it("rejects a non-UUID bankStatementLineId", async () => {
    const errors = await validateDto({ ...BASE, bankStatementLineId: "nope" });
    expect(errors.some((e) => e.property === "bankStatementLineId")).toBe(true);
  });

  it("rejects a missing matchedAmountMinor", async () => {
    const { matchedAmountMinor: _drop, ...payload } = BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "matchedAmountMinor")).toBe(true);
  });

  it("rejects a zero matchedAmountMinor", async () => {
    const errors = await validateDto({ ...BASE, matchedAmountMinor: 0 });
    expect(errors.some((e) => e.property === "matchedAmountMinor")).toBe(true);
  });

  it("rejects a negative matchedAmountMinor", async () => {
    const errors = await validateDto({ ...BASE, matchedAmountMinor: -100 });
    expect(errors.some((e) => e.property === "matchedAmountMinor")).toBe(true);
  });

  it("rejects a non-integer matchedAmountMinor", async () => {
    const errors = await validateDto({ ...BASE, matchedAmountMinor: 10.5 });
    expect(errors.some((e) => e.property === "matchedAmountMinor")).toBe(true);
  });

  it("rejects an invalid matchType value", async () => {
    const errors = await validateDto({ ...BASE, matchType: "AUTO" });
    expect(errors.some((e) => e.property === "matchType")).toBe(true);
  });
});
