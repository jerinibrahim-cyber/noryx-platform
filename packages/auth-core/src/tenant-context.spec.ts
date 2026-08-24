import { ForbiddenException } from "@nestjs/common";
import { requireTenantContext } from "./tenant-context";

describe("requireTenantContext", () => {
  it("returns the narrowed { tenantId, legalEntityId } when both are present", () => {
    const result = requireTenantContext(
      { tenantId: "tenant-1", legalEntityId: "entity-1" },
      "the widget service requires",
    );
    expect(result).toEqual({ tenantId: "tenant-1", legalEntityId: "entity-1" });
  });

  it("throws ForbiddenException with the tenant-context message when tenantId is missing", () => {
    expect(() =>
      requireTenantContext(
        { tenantId: null, legalEntityId: "entity-1" },
        "Chart of Accounts requires",
      ),
    ).toThrow(ForbiddenException);

    try {
      requireTenantContext(
        { tenantId: null, legalEntityId: "entity-1" },
        "Chart of Accounts requires",
      );
      fail("expected requireTenantContext to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe(
        "This token has no tenant context; Chart of Accounts requires a tenant-scoped token.",
      );
    }
  });

  it("throws ForbiddenException with the legal-entity-context message when only legalEntityId is missing", () => {
    try {
      requireTenantContext(
        { tenantId: "tenant-1", legalEntityId: null },
        "accounting periods require",
      );
      fail("expected requireTenantContext to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe(
        "This token has no legal-entity context; accounting periods require a legal-entity-scoped token.",
      );
    }
  });

  it("throws the tenant-context error (not the legal-entity one) when both are missing — preserves the prior tenant-first evaluation order", () => {
    try {
      requireTenantContext(
        { tenantId: null, legalEntityId: null },
        "journal entries require",
      );
      fail("expected requireTenantContext to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe(
        "This token has no tenant context; journal entries require a tenant-scoped token.",
      );
    }
  });

  it("preserves singular verb agreement for a singular resource phrase", () => {
    try {
      requireTenantContext(
        { tenantId: null, legalEntityId: "entity-1" },
        "the general ledger requires",
      );
      fail("expected requireTenantContext to throw");
    } catch (err) {
      expect((err as ForbiddenException).message).toBe(
        "This token has no tenant context; the general ledger requires a tenant-scoped token.",
      );
    }
  });
});
