import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AccountsModule } from "./accounts/accounts.module";
import { AccountingPeriodsModule } from "./accounting-periods/accounting-periods.module";
import { JournalEntriesModule } from "./journal-entries/journal-entries.module";
import { HealthController } from "./health/health.controller";
import { TenantContextMiddleware } from "./tenant/tenant-context.middleware";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AccountsModule,
    // 2c-1 — accounting periods + journal entry draft CRUD. No posting
    // or reversal yet (2c-2, a separate, not-yet-approved increment).
    AccountingPeriodsModule,
    JournalEntriesModule,
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
