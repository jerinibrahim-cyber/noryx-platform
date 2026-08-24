import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { AccountingPeriodsController } from "./accounting-periods.controller";
import { AccountingPeriodsService } from "./accounting-periods.service";

// Milestone 3.2 Stage 1 — FinanceAuthModule (formerly ../auth/finance-auth.module)
// was replaced by the shared @noryx/auth-core package's AuthCoreModule;
// identical wiring, now shared platform-wide rather than Finance-only.
@Module({
  imports: [AuthCoreModule],
  controllers: [AccountingPeriodsController],
  providers: [AccountingPeriodsService],
})
export class AccountingPeriodsModule {}
