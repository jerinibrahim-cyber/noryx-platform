import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { SupplierBillsController } from "./supplier-bills.controller";
import { SupplierBillsService } from "./supplier-bills.service";

/**
 * AP-1b — docs/finance-work-item-1b-supplier-bills-proposal.md.
 * Same AuthCoreModule-only import shape as SuppliersModule/
 * ApSettingsModule.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [SupplierBillsController],
  providers: [SupplierBillsService],
})
export class SupplierBillsModule {}
