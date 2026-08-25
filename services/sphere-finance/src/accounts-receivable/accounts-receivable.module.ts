import { Module } from "@nestjs/common";
import { CustomersModule } from "./customers/customers.module";
import { ArSettingsModule } from "./ar-settings/ar-settings.module";

/**
 * AR Foundation's parent module. AR-1a wires Customer Master + AR
 * Settings (docs/finance-work-item-ar-1a-customer-master-ar-foundation-
 * proposal.md) — mirrors AccountsPayableModule's own AP-1a shape. Later
 * AR Work Items (invoices, receipts, allocations, reporting) will add
 * further sibling imports here, the same way AP-1b/1c/1d extended
 * AccountsPayableModule.
 */
@Module({
  imports: [CustomersModule, ArSettingsModule],
})
export class AccountsReceivableModule {}
