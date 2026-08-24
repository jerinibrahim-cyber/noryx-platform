import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Milestone 3.2 — Route → Required-Role Matrix Hardening
 * (docs/hardening/milestone-3.2-route-role-matrix-proposal.md §4b).
 *
 * Reads the actual noryx.module.json files off disk — the same files
 * ModuleRegistryService consumes in production (module-registry.service.ts)
 * — and asserts each explicitly declares `requiredRoles` and `public`,
 * not merely that they're truthy. This closes the detection gap the
 * approved proposal's §3 item 2 identified: `ModuleRegistryService
 * .validate()`'s required-field list does not include either field, so a
 * manifest that omits them loads successfully in production and
 * `hasRequiredRole()`/`ProxyController` both silently treat the absence
 * as "no restriction" / "not public" respectively — i.e. a manifest
 * missing `requiredRoles` grants unrestricted module-level access with
 * no load-time error.
 *
 * Deliberately kept as a static file-read test, independent of
 * ModuleRegistryService's own (looser) load-time validation and of
 * ProxyController's dynamic per-request module resolution — this work
 * item does not redesign the Gateway's module-level authorization
 * mechanism, only adds a correctness check for the manifest files
 * themselves (per approved scope).
 */

interface DiscoveredManifest {
  file: string;
  key: string;
  requiredRolesDeclared: boolean;
  publicDeclared: boolean;
  requiredRoles: string[] | undefined;
  public: boolean | undefined;
}

/** Walks services/*\/noryx.module.json off disk — the same discovery shape as ModuleRegistryService, applied to source files rather than a deployed manifest directory. */
function discoverManifests(): DiscoveredManifest[] {
  const servicesDir = join(__dirname, "..", "..");
  const found: DiscoveredManifest[] = [];
  for (const entry of readdirSync(servicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(servicesDir, entry.name, "noryx.module.json");
    if (!existsSync(manifestPath)) continue;
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      unknown
    >;
    found.push({
      file: `services/${entry.name}/noryx.module.json`,
      key: raw.key as string,
      requiredRolesDeclared: Object.prototype.hasOwnProperty.call(
        raw,
        "requiredRoles",
      ),
      publicDeclared: Object.prototype.hasOwnProperty.call(raw, "public"),
      requiredRoles: raw.requiredRoles as string[] | undefined,
      public: raw.public as boolean | undefined,
    });
  }
  return found;
}

/**
 * Single source of truth. Every noryx.module.json in the repo
 * (re-verified live for this work item — matches
 * docs/hardening/milestone-3.2-route-role-matrix-proposal.md §2 exactly).
 */
const EXPECTED = [
  { key: "platform-identity", public: true, requiredRoles: [] as string[] },
  {
    key: "sphere-finance",
    public: false,
    requiredRoles: ["finance.viewer", "finance.poster", "finance.admin"],
  },
];

describe("Module-manifest required-role matrix (api-gateway)", () => {
  const discovered = discoverManifests();
  const discoveredByKey = new Map(discovered.map((m) => [m.key, m]));
  const expectedByKey = new Map(EXPECTED.map((m) => [m.key, m]));

  it("discovers exactly the expected number of module manifests on disk", () => {
    expect(discovered).toHaveLength(EXPECTED.length);
  });

  it("has no manifest on disk missing from the expected matrix (completeness)", () => {
    const missing = discovered
      .filter((m) => !expectedByKey.has(m.key))
      .map((m) => m.key);
    expect(missing).toEqual([]);
  });

  it("has no expected-matrix entry for a manifest that no longer exists on disk (staleness)", () => {
    const stale = EXPECTED.filter((m) => !discoveredByKey.has(m.key)).map(
      (m) => m.key,
    );
    expect(stale).toEqual([]);
  });

  it.each(EXPECTED)(
    "$key explicitly declares requiredRoles and public (not merely truthy)",
    ({ key }) => {
      const manifest = discoveredByKey.get(key);
      expect(manifest).toBeDefined();
      expect(manifest!.requiredRolesDeclared).toBe(true);
      expect(manifest!.publicDeclared).toBe(true);
    },
  );

  it.each(EXPECTED)(
    "$key has public=$public and requiredRoles=$requiredRoles",
    ({ key, public: expectedPublic, requiredRoles: expectedRoles }) => {
      const manifest = discoveredByKey.get(key);
      expect(manifest).toBeDefined();
      expect(manifest!.public).toBe(expectedPublic);
      expect([...(manifest!.requiredRoles ?? [])].sort()).toEqual(
        [...expectedRoles].sort(),
      );
    },
  );
});
