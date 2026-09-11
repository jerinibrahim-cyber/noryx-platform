import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxConfigurationModule } from "../../tax-configuration/tax-configuration.module";
import { SupplierBillsController } from "./supplier-bills.controller";
import { SupplierBillsService } from "./supplier-bills.service";

/**
 * AP-1b — docs/finance-work-item-1b-supplier-bills-proposal.md.
 * Same AuthCoreModule-only import shape as SuppliersModule/
 * ApSettingsModule.
 *
 * TaxConfigurationModule imported for Tax/VAT Phase 2
 * (docs/finance-work-item-tax-vat-phase-2-discovery.md §3) —
 * SupplierBillsService injects TaxCodesService/TaxRatesService to
 * resolve/snapshot line-level tax. A deliberate departure from this
 * codebase's usual "duplicate the trivial single-table lookup locally"
 * convention (see resolveCurrency/allocateJournalNumber elsewhere):
 * tax resolution is non-trivial, evolving business logic owned by its
 * own module, so it's consumed via DI here exactly as TaxRatesService
 * itself already consumes TaxCodesService.
 */
@Module({
  imports: [AuthCoreModule, TaxConfigurationModule],
  controllers: [SupplierBillsController],
  providers: [SupplierBillsService],
})
export class SupplierBillsModule {}
