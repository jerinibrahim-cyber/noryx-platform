import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpsertApSettingsDto } from "./upsert-ap-settings.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpsertApSettingsDto, input);
  return validate(dto);
}

describe("UpsertApSettingsDto", () => {
  it("accepts a well-formed payload with only the required field", async () => {
    const errors = await validateDto({
      apControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts an optional taxInputAccountId when it is a UUID", async () => {
    const errors = await validateDto({
      apControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      taxInputAccountId: "9b2e3c9a-1111-4c2a-9999-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing apControlAccountId", async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === "apControlAccountId")).toBe(true);
  });

  it("rejects a non-UUID apControlAccountId", async () => {
    const errors = await validateDto({ apControlAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "apControlAccountId")).toBe(true);
  });

  it("rejects a non-UUID taxInputAccountId", async () => {
    const errors = await validateDto({
      apControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      taxInputAccountId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "taxInputAccountId")).toBe(true);
  });
});
