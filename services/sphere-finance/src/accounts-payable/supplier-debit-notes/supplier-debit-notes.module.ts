import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { TaxConfigurationModule } from "../../tax-configuration/tax-configuration.module";
import { SupplierDebitNotesController } from "./supplier-debit-notes.controller";
import { SupplierDebitNotesService } from "./supplier-debit-notes.service";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md. Same
 * AuthCoreModule-only import shape as SuppliersModule/ApSettingsModule/
 * SupplierBillsModule/SupplierPaymentsModule.
 *
 * TaxConfigurationModule imported for Tax/VAT Phase 2
 * (docs/finance-work-item-tax-vat-phase-2-discovery.md §3/§4) — same
 * reasoning as SupplierBillsModule. Debit-note lines resolve tax
 * INDEPENDENTLY of any allocated bill, by this document's own
 * debitNoteDate — see SupplierDebitNotesService's own doc comment.
 */
@Module({
  imports: [AuthCoreModule, TaxConfigurationModule],
  controllers: [SupplierDebitNotesController],
  providers: [SupplierDebitNotesService],
})
export class SupplierDebitNotesModule {}
