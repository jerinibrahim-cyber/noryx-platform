import { Controller, Get } from "@nestjs/common";
import { getDb, sql } from "@noryx/db-core";

/**
 * Liveness (/health) vs readiness (/health/ready) split — the API Gateway
 * polls readiness before routing traffic to a newly deployed instance
 * (see @noryx/shared-types ModuleManifest.healthCheckPath), so this can't
 * report healthy while the DB connection is still cold or broken.
 */
@Controller("health")
export class HealthController {
  @Get()
  liveness() {
    return { status: "ok", service: "identity" };
  }

  @Get("ready")
  async readiness() {
    try {
      await getDb().execute(sql`SELECT 1`);
      return { status: "ok", service: "identity", db: "connected" };
    } catch {
      return { status: "degraded", service: "identity", db: "unreachable" };
    }
  }
}
