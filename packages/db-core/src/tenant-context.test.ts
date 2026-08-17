import {
  getTenantContext,
  runWithTenantContext,
  tryGetTenantContext,
} from "./tenant-context";

describe("tenant-context", () => {
  it("throws when no context has been set", () => {
    expect(() => getTenantContext()).toThrow(/No tenant context set/);
  });

  it("returns undefined from tryGetTenantContext when unset", () => {
    expect(tryGetTenantContext()).toBeUndefined();
  });

  it("makes the tenant context available inside runWithTenantContext", () => {
    const result = runWithTenantContext(
      { tenantId: "tenant-1", userId: "user-1" },
      () => {
        return getTenantContext();
      },
    );
    expect(result).toEqual({ tenantId: "tenant-1", userId: "user-1" });
  });

  it("allows a null tenantId for platform-operator context", () => {
    const result = runWithTenantContext({ tenantId: null }, () =>
      getTenantContext(),
    );
    expect(result.tenantId).toBeNull();
  });

  it("isolates context between separate runWithTenantContext calls", () => {
    const a = runWithTenantContext(
      { tenantId: "tenant-a" },
      () => getTenantContext().tenantId,
    );
    const b = runWithTenantContext(
      { tenantId: "tenant-b" },
      () => getTenantContext().tenantId,
    );
    expect(a).toBe("tenant-a");
    expect(b).toBe("tenant-b");
  });
});
