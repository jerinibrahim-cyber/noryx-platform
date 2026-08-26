import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { CustomerInvoicesController } from "./customer-invoices.controller";
import { CustomerInvoicesService } from "./customer-invoices.service";

/**
 * AR-1b — docs/finance-work-item-ar-1b-customer-invoicing-proposal.md.
 * Same AuthCoreModule-only import shape as CustomersModule/
 * ArSettingsModule/SupplierBillsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [CustomerInvoicesController],
  providers: [CustomerInvoicesService],
})
export class CustomerInvoicesModule {}
