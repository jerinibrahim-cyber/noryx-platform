import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateJournalEntryDto } from "./create-journal-entry.dto";

const VALID_ACCOUNT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateJournalEntryDto, input);
  return validate(dto);
}

describe("CreateJournalEntryDto", () => {
  it("accepts a well-formed payload with lines", async () => {
    const errors = await validateDto({
      transactionDate: "2026-08-15",
      memo: "Test entry",
      lines: [
        { accountId: VALID_ACCOUNT_ID, debitMinor: 1000, creditMinor: 0 },
        { accountId: VALID_ACCOUNT_ID, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts a bare header with no lines at all — DRAFT is not required to balance or have >=2 lines", async () => {
    const errors = await validateDto({ transactionDate: "2026-08-15" });
    expect(errors).toHaveLength(0);
  });

  it("accepts a header with a single line", async () => {
    const errors = await validateDto({
      transactionDate: "2026-08-15",
      lines: [{ accountId: VALID_ACCOUNT_ID, debitMinor: 500, creditMinor: 0 }],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing transactionDate", async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects a malformed transactionDate", async () => {
    const errors = await validateDto({ transactionDate: "not-a-date" });
    expect(errors.some((e) => e.property === "transactionDate")).toBe(true);
  });

  it("rejects an invalid nested line — the line-level validators still run", async () => {
    const errors = await validateDto({
      transactionDate: "2026-08-15",
      lines: [{ accountId: VALID_ACCOUNT_ID, debitMinor: 0, creditMinor: 0 }],
    });
    expect(errors.some((e) => e.property === "lines")).toBe(true);
  });
});
