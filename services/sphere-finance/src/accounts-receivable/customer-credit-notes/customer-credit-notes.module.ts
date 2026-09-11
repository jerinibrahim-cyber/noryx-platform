import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxConfigurationModule } from "../../tax-configuration/tax-configuration.module";
import { CustomerCreditNotesController } from "./customer-credit-notes.controller";
import { CustomerCreditNotesService } from "./customer-credit-notes.service";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md. Same
 * AuthCoreModule-only import shape as CustomersModule/ArSettingsModule/
 * CustomerInvoicesModule/CustomerReceiptsModule.
 *
 * TaxConfigurationModule imported for Tax/VAT Phase 3
 * (docs/finance-work-item-tax-vat-phase-3-discovery.md §3) —
 * CustomerCreditNotesService injects TaxRatesService to resolve/
 * snapshot line-level tax independently per line, identical shape to
 * SupplierDebitNotesModule's own Phase 2 addition.
 */
@Module({
  imports: [AuthCoreModule, TaxConfigurationModule],
  controllers: [CustomerCreditNotesController],
  providers: [CustomerCreditNotesService],
})
export class CustomerCreditNotesModule {}
