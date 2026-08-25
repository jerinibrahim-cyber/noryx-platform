import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpsertArSettingsDto } from "./upsert-ar-settings.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpsertArSettingsDto, input);
  return validate(dto);
}

describe("UpsertArSettingsDto", () => {
  it("accepts a well-formed payload with only the required field", async () => {
    const errors = await validateDto({
      arControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts an optional taxOutputAccountId when it is a UUID", async () => {
    const errors = await validateDto({
      arControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      taxOutputAccountId: "9b2e3c9a-1111-4c2a-9999-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing arControlAccountId", async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === "arControlAccountId")).toBe(true);
  });

  it("rejects a non-UUID arControlAccountId", async () => {
    const errors = await validateDto({ arControlAccountId: "not-a-uuid" });
    expect(errors.some((e) => e.property === "arControlAccountId")).toBe(true);
  });

  it("rejects a non-UUID taxOutputAccountId", async () => {
    const errors = await validateDto({
      arControlAccountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      taxOutputAccountId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "taxOutputAccountId")).toBe(true);
  });
});
