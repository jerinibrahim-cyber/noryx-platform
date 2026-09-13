import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxConfigurationModule } from "../../tax-configuration/tax-configuration.module";
import { JournalEntriesService } from "../../journal-entries/journal-entries.service";
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
 *
 * Document-Level Reversal work item
 * (docs/finance-work-item-document-reversal-proposal.md §18, CTO-approved
 * implementation authorization) — registers `JournalEntriesService` as a
 * SECOND DI provider, same pattern as `SupplierDebitNotesModule`, for
 * `CustomerCreditNotesService.reverse()`.
 */
@Module({
  imports: [AuthCoreModule, TaxConfigurationModule],
  controllers: [CustomerCreditNotesController],
  providers: [CustomerCreditNotesService, JournalEntriesService],
})
export class CustomerCreditNotesModule {}
