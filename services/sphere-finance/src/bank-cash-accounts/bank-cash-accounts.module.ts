import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BankCashAccountsController } from "./bank-cash-accounts.controller";
import { BankCashAccountsService } from "./bank-cash-accounts.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [BankCashAccountsController],
  providers: [BankCashAccountsService],
})
export class BankCashAccountsModule {}
