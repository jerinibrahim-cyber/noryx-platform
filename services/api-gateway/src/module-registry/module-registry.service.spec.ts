import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleRegistryService } from "./module-registry.service";

describe("ModuleRegistryService", () => {
  let dir: string;
  let service: ModuleRegistryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "noryx-modules-"));
    process.env.NORYX_MODULES_MANIFEST_DIR = dir;
    service = new ModuleRegistryService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NORYX_MODULES_MANIFEST_DIR;
  });

  function writeManifest(filename: string, manifest: Record<string, unknown>) {
    writeFileSync(join(dir, filename), JSON.stringify(manifest));
  }

  it("loads every valid manifest in the directory", () => {
    writeManifest("identity.json", {
      key: "platform-identity",
      displayName: "Identity",
      product: "platform",
      version: "0.1.0",
      basePath: "/v1/auth",
      serviceUrl: "http://identity:3001",
      healthCheckPath: "/health/ready",
    });
    writeManifest("finance.json", {
      key: "sphere-finance",
      displayName: "Finance",
      product: "sphere",
      version: "0.1.0",
      basePath: "/v1/finance",
      serviceUrl: "http://sphere-finance:3010",
      healthCheckPath: "/health/ready",
    });

    service.onModuleInit();
    expect(service.getAll()).toHaveLength(2);
    expect(service.resolveByKey("sphere-finance")?.serviceUrl).toBe(
      "http://sphere-finance:3010",
    );
  });

  it("skips a malformed manifest without crashing, and still loads the valid ones", () => {
    writeManifest("broken.json", { key: "broken" }); // missing required fields
    writeManifest("ok.json", {
      key: "platform-identity",
      displayName: "Identity",
      product: "platform",
      version: "0.1.0",
      basePath: "/v1/auth",
      serviceUrl: "http://identity:3001",
      healthCheckPath: "/health/ready",
    });

    service.onModuleInit();
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0]?.key).toBe("platform-identity");
  });

  it("resolves a request path to the module with the longest matching basePath", () => {
    writeManifest("finance.json", {
      key: "sphere-finance",
      displayName: "Finance",
      product: "sphere",
      version: "0.1.0",
      basePath: "/v1/finance",
      serviceUrl: "http://sphere-finance:3010",
      healthCheckPath: "/health/ready",
    });
    writeManifest("finance-reports.json", {
      key: "sphere-finance-reports",
      displayName: "Finance Reports",
      product: "sphere",
      version: "0.1.0",
      basePath: "/v1/finance/reports",
      serviceUrl: "http://sphere-finance-reports:3011",
      healthCheckPath: "/health/ready",
    });

    service.onModuleInit();
    expect(service.resolveByPath("/v1/finance/invoices")?.key).toBe(
      "sphere-finance",
    );
    expect(service.resolveByPath("/v1/finance/reports/monthly")?.key).toBe(
      "sphere-finance-reports",
    );
    expect(service.resolveByPath("/v1/unknown")).toBeUndefined();
  });

  it("logs and continues instead of throwing when the manifest directory doesn't exist", () => {
    process.env.NORYX_MODULES_MANIFEST_DIR = join(dir, "does-not-exist");
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.getAll()).toHaveLength(0);
  });
});
