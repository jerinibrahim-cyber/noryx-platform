import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { CustomerReceiptsController } from "./customer-receipts.controller";
import { CustomerReceiptsService } from "./customer-receipts.service";

/**
 * AR-1c — docs/finance-work-item-1c-customer-receipts-proposal.md. Same
 * AuthCoreModule-only import shape as CustomersModule/ArSettingsModule/
 * CustomerInvoicesModule/SupplierPaymentsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [CustomerReceiptsController],
  providers: [CustomerReceiptsService],
})
export class CustomerReceiptsModule {}
