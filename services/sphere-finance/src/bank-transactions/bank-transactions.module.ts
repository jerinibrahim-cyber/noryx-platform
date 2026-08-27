import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BankTransactionsController } from "./bank-transactions.controller";
import { BankTransactionsService } from "./bank-transactions.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [BankTransactionsController],
  providers: [BankTransactionsService],
})
export class BankTransactionsModule {}
