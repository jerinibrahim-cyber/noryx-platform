import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxReportsController } from "./tax-reports.controller";
import { TaxReportsService } from "./tax-reports.service";

/**
 * Tax/VAT Phase 4 — VAT Position Report.
 * docs/finance-work-item-tax-vat-phase-4-discovery.md §6.1 (§11
 * decision 1). A top-level Accounting Core sibling of
 * `GeneralLedgerModule`/`FinancialStatementsModule` — reads tables
 * those modules and AP-1d/AR-1d/Tax-VAT-Phase-2/3 already own, touches
 * none of their files. Same wiring shape as `FinancialStatementsModule`
 * (`AuthCoreModule` only — no `TaxConfigurationModule` dependency: this
 * report only reads already-snapshotted tax data off posted lines, it
 * never resolves a rate itself, so it needs no `TaxRatesService`).
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [TaxReportsController],
  providers: [TaxReportsService],
})
export class TaxReportsModule {}
