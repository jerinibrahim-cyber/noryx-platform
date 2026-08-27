import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { SupplierDebitNotesController } from "./supplier-debit-notes.controller";
import { SupplierDebitNotesService } from "./supplier-debit-notes.service";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md. Same
 * AuthCoreModule-only import shape as SuppliersModule/ApSettingsModule/
 * SupplierBillsModule/SupplierPaymentsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [SupplierDebitNotesController],
  providers: [SupplierDebitNotesService],
})
export class SupplierDebitNotesModule {}
