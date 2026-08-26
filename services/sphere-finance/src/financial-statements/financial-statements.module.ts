import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { FinancialStatementsController } from "./financial-statements.controller";
import { FinancialStatementsService } from "./financial-statements.service";

/**
 * Financial Statements — Profit & Loss, Balance Sheet.
 * docs/finance-work-item-financial-statements-proposal.md §13. A
 * top-level Accounting Core sibling of `GeneralLedgerModule` — reads the
 * same tables that module and AP-1d/AR-1d already own, touches none of
 * their files. Same wiring shape as `GeneralLedgerModule`/`ApReportsModule`.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [FinancialStatementsController],
  providers: [FinancialStatementsService],
})
export class FinancialStatementsModule {}
