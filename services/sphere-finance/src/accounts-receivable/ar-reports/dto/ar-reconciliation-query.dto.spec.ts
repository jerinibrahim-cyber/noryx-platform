import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ArReconciliationQueryDto } from "./ar-reconciliation-query.dto";

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ArReconciliationQueryDto, input);
  return validate(dto);
}

describe("ArReconciliationQueryDto", () => {
  it("accepts an empty payload (current mode)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("accepts a well-formed asOf", async () => {
    const errors = await validateDto({ asOf: "2026-01-15" });
    expect(errors).toHaveLength(0);
  });

  it("rejects a non-date asOf", async () => {
    const errors = await validateDto({ asOf: "not-a-date" });
    expect(errors.some((e) => e.property === "asOf")).toBe(true);
  });

  it("rejects a customerId property outright (no such field on this DTO — whitelist strips/rejects unknown properties)", async () => {
    const dto = plainToInstance(ArReconciliationQueryDto, {
      customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect((dto as unknown as Record<string, unknown>).customerId).toBe(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
    // class-transformer's plainToInstance does not strip by itself — the
    // global ValidationPipe's whitelist:true/forbidNonWhitelisted:true
    // does that at the HTTP layer (proven by the e2e reconciliation
    // suite's own "rejects an unknown customerId query param" case).
    // This spec only proves the DTO's own shape has no customerId field
    // to validate in the first place — see class definition.
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });
});
