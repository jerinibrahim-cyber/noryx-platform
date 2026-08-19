import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateAccountDto } from "./create-account.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateAccountDto, input);
  return validate(dto);
}

describe("CreateAccountDto", () => {
  it("accepts a well-formed payload", async () => {
    const errors = await validateDto({
      code: "1000",
      name: "Assets",
      type: "ASSET",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts an optional parentId when it is a UUID", async () => {
    const errors = await validateDto({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      parentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects a code with disallowed characters", async () => {
    const errors = await validateDto({
      code: "1000 / GL",
      name: "Assets",
      type: "ASSET",
    });
    expect(errors.some((e) => e.property === "code")).toBe(true);
  });

  it("rejects an invalid account type", async () => {
    const errors = await validateDto({
      code: "1000",
      name: "Assets",
      type: "NOT_A_REAL_TYPE",
    });
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a non-UUID parentId", async () => {
    const errors = await validateDto({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      parentId: "not-a-uuid",
    });
    expect(errors.some((e) => e.property === "parentId")).toBe(true);
  });

  it("rejects a missing name", async () => {
    const errors = await validateDto({ code: "1000", type: "ASSET" });
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });
});
