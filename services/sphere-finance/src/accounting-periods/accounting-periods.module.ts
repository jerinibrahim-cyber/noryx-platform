import { Module } from "@nestjs/common";
import { FinanceAuthModule } from "../auth/finance-auth.module";
import { AccountingPeriodsController } from "./accounting-periods.controller";
import { AccountingPeriodsService } from "./accounting-periods.service";

@Module({
  imports: [FinanceAuthModule],
  controllers: [AccountingPeriodsController],
  providers: [AccountingPeriodsService],
})
export class AccountingPeriodsModule {}
