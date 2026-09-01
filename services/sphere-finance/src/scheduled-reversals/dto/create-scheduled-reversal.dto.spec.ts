import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateScheduledReversalDto } from "./create-scheduled-reversal.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateScheduledReversalDto, input);
  return validate(dto);
}

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const BASE = {
  originalJournalEntryId: UUID_A,
  targetDate: "2027-01-15",
};

describe("CreateScheduledReversalDto", () => {
  it("accepts a well-formed payload", async () => {
    const errors = await validateDto(BASE);
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing originalJournalEntryId", async () => {
    const { originalJournalEntryId: _drop, ...payload } = BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "originalJournalEntryId")).toBe(
      true,
    );
  });

  it("rejects a non-UUID originalJournalEntryId", async () => {
    const errors = await validateDto({
      ...BASE,
      originalJournalEntryId: "nope",
    });
    expect(errors.some((e) => e.property === "originalJournalEntryId")).toBe(
      true,
    );
  });

  it("rejects a missing targetDate", async () => {
    const { targetDate: _drop, ...payload } = BASE;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === "targetDate")).toBe(true);
  });

  it("rejects a non-date targetDate", async () => {
    const errors = await validateDto({ ...BASE, targetDate: "not-a-date" });
    expect(errors.some((e) => e.property === "targetDate")).toBe(true);
  });
});
