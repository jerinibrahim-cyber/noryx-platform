import { Module } from "@nestjs/common";
import { FinanceAuthModule } from "../auth/finance-auth.module";
import { GeneralLedgerController } from "./general-ledger.controller";
import { GeneralLedgerService } from "./general-ledger.service";

// 2d — General Ledger read layer. Same FinanceAuthModule wiring as
// AccountingPeriodsModule/JournalEntriesModule (2c-1) — see
// FinanceAuthModule's own doc comment for why AccountsModule alone is
// exempt from this pattern.
@Module({
  imports: [FinanceAuthModule],
  controllers: [GeneralLedgerController],
  providers: [GeneralLedgerService],
})
export class GeneralLedgerModule {}
