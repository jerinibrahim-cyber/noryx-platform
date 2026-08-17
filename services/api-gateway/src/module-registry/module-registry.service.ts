import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ModuleManifest } from "@noryx/shared-types";

/**
 * The plug-and-play core of the gateway. On startup (and on-demand via
 * reload()), reads every *.json file in NORYX_MODULES_MANIFEST_DIR — one
 * per deployed service, each copied from that service's own
 * noryx.module.json at build/deploy time (see docs/plug-and-play-modules.md
 * and infra/k8s's manifest-sync init-container) — and builds a route
 * table keyed by basePath.
 *
 * Adding a new module to the platform means: build the service, ship its
 * noryx.module.json into this directory, and it's routable — no code
 * change or redeploy of the gateway itself.
 */
@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModuleRegistryService.name);
  private manifests: ModuleManifest[] = [];

  onModuleInit() {
    this.reload();
  }

  reload(): void {
    const dir =
      process.env.NORYX_MODULES_MANIFEST_DIR ??
      join(__dirname, "..", "..", "modules");
    if (!existsSync(dir)) {
      this.logger.warn(
        `Module manifest directory not found: ${dir} — gateway will route nothing until it exists.`,
      );
      this.manifests = [];
      return;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const loaded: ModuleManifest[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const manifest = JSON.parse(raw) as ModuleManifest;
        this.validate(manifest, file);
        loaded.push(manifest);
      } catch (err) {
        this.logger.error(
          `Failed to load module manifest ${file}: ${(err as Error).message}`,
        );
      }
    }
    this.manifests = loaded;
    this.logger.log(
      `Loaded ${loaded.length} module manifest(s): ${loaded.map((m) => m.key).join(", ") || "(none)"}`,
    );
  }

  private validate(
    m: Partial<ModuleManifest>,
    file: string,
  ): asserts m is ModuleManifest {
    const required: (keyof ModuleManifest)[] = [
      "key",
      "displayName",
      "product",
      "version",
      "basePath",
      "serviceUrl",
      "healthCheckPath",
    ];
    const missing = required.filter((k) => !m[k]);
    if (missing.length > 0) {
      throw new Error(
        `${file} is missing required field(s): ${missing.join(", ")}`,
      );
    }
  }

  getAll(): ModuleManifest[] {
    return this.manifests;
  }

  /** Longest-prefix match, so "/v1/finance/invoices" resolves to a module mounted at "/v1/finance". */
  resolveByPath(path: string): ModuleManifest | undefined {
    const candidates = this.manifests
      .filter((m) => path === m.basePath || path.startsWith(`${m.basePath}/`))
      .sort((a, b) => b.basePath.length - a.basePath.length);
    return candidates[0];
  }

  resolveByKey(key: string): ModuleManifest | undefined {
    return this.manifests.find((m) => m.key === key);
  }
}
