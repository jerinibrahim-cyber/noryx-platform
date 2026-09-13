import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { JournalEntriesService } from "../../journal-entries/journal-entries.service";
import { CustomerReceiptsController } from "./customer-receipts.controller";
import { CustomerReceiptsService } from "./customer-receipts.service";

/**
 * AR-1c — docs/finance-work-item-1c-customer-receipts-proposal.md. Same
 * AuthCoreModule-only import shape as CustomersModule/ArSettingsModule/
 * CustomerInvoicesModule/SupplierPaymentsModule.
 *
 * Document-Level Reversal work item
 * (docs/finance-work-item-document-reversal-proposal.md §18, CTO-approved
 * implementation authorization) — registers `JournalEntriesService` as a
 * SECOND DI provider, same pattern as `SupplierPaymentsModule`, for
 * `CustomerReceiptsService.reverse()`.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [CustomerReceiptsController],
  providers: [CustomerReceiptsService, JournalEntriesService],
})
export class CustomerReceiptsModule {}
