import { Controller, Get } from "@nestjs/common";
import { sql } from "@noryx/db-core";
import { getDb } from "../db/db";

/**
 * Liveness (/health) vs readiness (/health/ready) split — the API Gateway
 * polls readiness (noryx.module.json's healthCheckPath) before routing
 * traffic to a newly deployed instance, same pattern as services/identity.
 */
@Controller("health")
export class HealthController {
  @Get()
  liveness() {
    return { status: "ok", service: "sphere-finance" };
  }

  @Get("ready")
  async readiness() {
    try {
      await getDb().execute(sql`SELECT 1`);
      return { status: "ok", service: "sphere-finance", db: "connected" };
    } catch {
      return {
        status: "degraded",
        service: "sphere-finance",
        db: "unreachable",
      };
    }
  }
}
