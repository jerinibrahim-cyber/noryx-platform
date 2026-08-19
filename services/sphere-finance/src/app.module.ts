import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AccountsModule } from "./accounts/accounts.module";
import { HealthController } from "./health/health.controller";
import { TenantContextMiddleware } from "./tenant/tenant-context.middleware";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AccountsModule,
    // Scoped registration so TenantContextMiddleware can inject JwtService
    // without importing AccountsModule's other providers — same pattern as
    // services/identity/src/app.module.ts.
    JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET }),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
