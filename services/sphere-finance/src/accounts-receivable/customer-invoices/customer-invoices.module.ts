import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxConfigurationModule } from "../../tax-configuration/tax-configuration.module";
import { CustomerInvoicesController } from "./customer-invoices.controller";
import { CustomerInvoicesService } from "./customer-invoices.service";

/**
 * AR-1b — docs/finance-work-item-ar-1b-customer-invoicing-proposal.md.
 * Same AuthCoreModule-only import shape as CustomersModule/
 * ArSettingsModule/SupplierBillsModule.
 *
 * TaxConfigurationModule imported for Tax/VAT Phase 3
 * (docs/finance-work-item-tax-vat-phase-3-discovery.md §3) —
 * CustomerInvoicesService injects TaxRatesService to resolve/snapshot
 * line-level tax, identical DI-departure reasoning and shape as
 * SupplierBillsModule's own Phase 2 addition (tax resolution is
 * non-trivial, evolving business logic owned by its own module).
 */
@Module({
  imports: [AuthCoreModule, TaxConfigurationModule],
  controllers: [CustomerInvoicesController],
  providers: [CustomerInvoicesService],
})
export class CustomerInvoicesModule {}
