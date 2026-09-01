import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CancelScheduledReversalDto } from "./cancel-scheduled-reversal.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CancelScheduledReversalDto, input);
  return validate(dto);
}

describe("CancelScheduledReversalDto", () => {
  it("accepts an empty payload", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a reason string", async () => {
    const errors = await validateDto({ reason: "duplicate entry" });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-string reason", async () => {
    const errors = await validateDto({ reason: 12345 });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });

  it("rejects a reason over 2000 characters", async () => {
    const errors = await validateDto({ reason: "x".repeat(2001) });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });
});
