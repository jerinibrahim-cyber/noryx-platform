import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateJournalLineDto } from "./create-journal-line.dto";

const VALID_ACCOUNT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateJournalLineDto, input);
  return validate(dto);
}

describe("CreateJournalLineDto", () => {
  it("accepts a well-formed debit-only line", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: 1000,
      creditMinor: 0,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed credit-only line", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: 0,
      creditMinor: 1000,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a line with both debit and credit at zero", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: 0,
      creditMinor: 0,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a line with both debit and credit positive", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: 500,
      creditMinor: 500,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a negative debitMinor", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: -500,
      creditMinor: 0,
    });
    expect(errors.some((e) => e.property === "debitMinor")).toBe(true);
  });

  it("rejects a non-UUID accountId", async () => {
    const errors = await validateDto({
      accountId: "not-a-uuid",
      debitMinor: 500,
      creditMinor: 0,
    });
    expect(errors.some((e) => e.property === "accountId")).toBe(true);
  });

  it("rejects a non-integer debitMinor", async () => {
    const errors = await validateDto({
      accountId: VALID_ACCOUNT_ID,
      debitMinor: 12.5,
      creditMinor: 0,
    });
    expect(errors.some((e) => e.property === "debitMinor")).toBe(true);
  });
});
