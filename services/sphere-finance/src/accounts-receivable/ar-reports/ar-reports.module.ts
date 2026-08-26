import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { ArReportsController } from "./ar-reports.controller";
import { ArReportsService } from "./ar-reports.service";

/**
 * AR-1d — Customer Balance, Customer Statement, AR Ageing, AR/GL
 * Reconciliation. docs/finance-work-item-1d-ar-reports-proposal.md §11.
 * The sibling module AccountsReceivableModule's own doc comment already
 * anticipated this ("Later AR Work Items (reporting) will add further
 * sibling imports here, the same way AP-1d continued
 * AccountsPayableModule").
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [ArReportsController],
  providers: [ArReportsService],
})
export class ArReportsModule {}
