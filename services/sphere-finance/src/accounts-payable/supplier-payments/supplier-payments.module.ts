import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { JournalEntriesService } from "../../journal-entries/journal-entries.service";
import { SupplierPaymentsController } from "./supplier-payments.controller";
import { SupplierPaymentsService } from "./supplier-payments.service";

/**
 * AP-1c — docs/finance-work-item-1c-supplier-payments-proposal.md. Same
 * AuthCoreModule-only import shape as SuppliersModule/ApSettingsModule/
 * SupplierBillsModule.
 *
 * Document-Level Reversal work item
 * (docs/finance-work-item-document-reversal-proposal.md §18, CTO-approved
 * implementation authorization) — registers `JournalEntriesService` as a
 * SECOND DI provider, same pattern as `SupplierBillsModule`/
 * `ScheduledReversalsModule`, for `SupplierPaymentsService.reverse()`.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService, JournalEntriesService],
})
export class SupplierPaymentsModule {}
