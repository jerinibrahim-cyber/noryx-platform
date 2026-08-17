import { Controller, Get } from "@nestjs/common";
import { ModuleRegistryService } from "../module-registry/module-registry.service";

@Controller("health")
export class HealthController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get()
  liveness() {
    return { status: "ok", service: "api-gateway" };
  }

  @Get("ready")
  readiness() {
    const modules = this.registry.getAll();
    return {
      status: modules.length > 0 ? "ok" : "degraded",
      service: "api-gateway",
      registeredModules: modules.map((m) => m.key),
    };
  }

  @Get("modules")
  modules() {
    // Introspection endpoint — useful for a future admin UI listing what's
    // currently routable, and for CI smoke tests after a deploy.
    return this.registry
      .getAll()
      .map(({ key, displayName, product, version, basePath }) => ({
        key,
        displayName,
        product,
        version,
        basePath,
      }));
  }
}
