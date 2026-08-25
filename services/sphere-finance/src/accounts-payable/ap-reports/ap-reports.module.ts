import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { ApReportsController } from "./ap-reports.controller";
import { ApReportsService } from "./ap-reports.service";

/**
 * AP-1d — Supplier Balance, Supplier Statement, AP Ageing, AP/GL
 * Reconciliation. docs/finance-work-item-1d-supplier-balance-statement-
 * ageing-proposal.md §4. The sibling module AccountsPayableModule's own
 * doc comment already anticipated ("AP-1d (AP Reporting) adds its own
 * feature module as a sibling import here").
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [ApReportsController],
  providers: [ApReportsService],
})
export class ApReportsModule {}
