import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BudgetsController } from "./budgets.controller";
import { BudgetsService } from "./budgets.service";
import { BudgetLinesController } from "./budget-lines.controller";
import { BudgetLinesService } from "./budget-lines.service";

/**
 * Budgeting / Planning — Phase 1 Foundation (CTO-approved implementation
 * authorization, v6). docs/work-items/budgeting-phase-1-foundation/
 * CONTRACT.md §5/§8. A top-level sibling of TaxConfigurationModule/
 * ScheduledReversalsModule etc. in app.module.ts, not nested inside
 * AccountsPayableModule/AccountsReceivableModule — a budget is owned by
 * a legal entity, not by AP/AR/Tax. Reads/writes its own two new tables
 * only (budgets, budget_lines); touches no existing module. No UI in
 * this repository (backend API foundation phase only, contract §8).
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [BudgetsController, BudgetLinesController],
  providers: [BudgetsService, BudgetLinesService],
  exports: [BudgetsService, BudgetLinesService],
})
export class BudgetingModule {}
