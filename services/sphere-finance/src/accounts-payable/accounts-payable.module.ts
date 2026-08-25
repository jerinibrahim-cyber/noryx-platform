import { Module } from "@nestjs/common";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { ApSettingsModule } from "./ap-settings/ap-settings.module";
import { SupplierBillsModule } from "./supplier-bills/supplier-bills.module";

/**
 * AP Foundation's parent module. AP-1a wired Supplier Master + AP
 * Settings; AP-1b adds Supplier Bills below
 * (docs/finance-work-item-1b-supplier-bills-proposal.md). AP-1c
 * (Supplier Payments + Allocations) and AP-1d (AP Reporting) each add
 * their own feature module as a sibling import here when their own
 * review checkpoint is reached. Not implemented yet — do not add
 * placeholder modules for them ahead of that.
 */
@Module({
  imports: [SuppliersModule, ApSettingsModule, SupplierBillsModule],
})
export class AccountsPayableModule {}
