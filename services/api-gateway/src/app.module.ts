import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import { ModuleRegistryService } from "./module-registry/module-registry.service";
import { ProxyController } from "./proxy/proxy.controller";
import { ProxyService } from "./proxy/proxy.service";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Gateway-wide rate limit, in front of every module (defense-in-depth
    // on top of any per-route limits a downstream service applies itself —
    // Readiness Review §7.6).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET }),
  ],
  controllers: [HealthController, ProxyController],
  providers: [ModuleRegistryService, ProxyService],
})
export class AppModule {}
