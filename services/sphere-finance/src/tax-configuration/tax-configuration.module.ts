import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxCodesController } from "./tax-codes.controller";
import { TaxCodesService } from "./tax-codes.service";
import { TaxRatesService } from "./tax-rates.service";

/**
 * Tax / VAT MVP Phase 1 — Tax Configuration Foundation (CTO-approved
 * architecture proposal, CTO decision turn, Phase 1 implementation
 * authorization). A top-level sibling of AccountingPeriodsModule etc.,
 * not nested inside AccountsPayableModule/AccountsReceivableModule —
 * tax codes/rates are shared configuration both AP and AR will
 * reference in Phase 2/3, not owned by either sub-ledger. Reads/writes
 * its own two new tables only (tax_codes, tax_rates); touches no
 * existing module.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [TaxCodesController],
  providers: [TaxCodesService, TaxRatesService],
  exports: [TaxCodesService, TaxRatesService],
})
export class TaxConfigurationModule {}
