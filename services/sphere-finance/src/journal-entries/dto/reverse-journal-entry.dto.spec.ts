import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ReverseJournalEntryDto } from "./reverse-journal-entry.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ReverseJournalEntryDto, input);
  return validate(dto);
}

describe("ReverseJournalEntryDto", () => {
  it("accepts an empty body — both fields default server-side (§6)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed payload with both fields", async () => {
    const errors = await validateDto({
      transactionDate: "2026-08-20",
      memo: "Correcting entry",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a malformed transactionDate", async () => {
    const errors = await validateDto({ transactionDate: "not-a-date" });
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects a memo over 2000 characters", async () => {
    const errors = await validateDto({ memo: "x".repeat(2001) });
    expect(errors.some((e) => e.property === "memo")).toBe(true);
  });
});
