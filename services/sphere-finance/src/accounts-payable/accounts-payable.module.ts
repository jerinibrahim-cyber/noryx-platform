import { Module } from "@nestjs/common";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { ApSettingsModule } from "./ap-settings/ap-settings.module";
import { SupplierBillsModule } from "./supplier-bills/supplier-bills.module";
import { SupplierPaymentsModule } from "./supplier-payments/supplier-payments.module";

/**
 * AP Foundation's parent module. AP-1a wired Supplier Master + AP
 * Settings; AP-1b added Supplier Bills; AP-1c adds Supplier Payments &
 * Allocations below (docs/finance-work-item-1c-supplier-payments-
 * proposal.md). AP-1d (AP Reporting) adds its own feature module as a
 * sibling import here when its own review checkpoint is reached. Not
 * implemented yet — do not add a placeholder module for it ahead of
 * that.
 */
@Module({
  imports: [
    SuppliersModule,
    ApSettingsModule,
    SupplierBillsModule,
    SupplierPaymentsModule,
  ],
})
export class AccountsPayableModule {}
