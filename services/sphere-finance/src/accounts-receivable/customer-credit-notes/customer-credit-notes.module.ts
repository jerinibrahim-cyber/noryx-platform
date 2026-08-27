import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { CustomerCreditNotesController } from "./customer-credit-notes.controller";
import { CustomerCreditNotesService } from "./customer-credit-notes.service";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md. Same
 * AuthCoreModule-only import shape as CustomersModule/ArSettingsModule/
 * CustomerInvoicesModule/CustomerReceiptsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [CustomerCreditNotesController],
  providers: [CustomerCreditNotesService],
})
export class CustomerCreditNotesModule {}
