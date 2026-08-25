import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { SupplierPaymentsController } from "./supplier-payments.controller";
import { SupplierPaymentsService } from "./supplier-payments.service";

/**
 * AP-1c — docs/finance-work-item-1c-supplier-payments-proposal.md. Same
 * AuthCoreModule-only import shape as SuppliersModule/ApSettingsModule/
 * SupplierBillsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService],
})
export class SupplierPaymentsModule {}
