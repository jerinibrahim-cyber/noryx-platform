import { Module } from "@nestjs/common";
import { CustomersModule } from "./customers/customers.module";
import { ArSettingsModule } from "./ar-settings/ar-settings.module";
import { CustomerInvoicesModule } from "./customer-invoices/customer-invoices.module";

/**
 * AR Foundation's parent module. AR-1a wired Customer Master + AR
 * Settings (docs/finance-work-item-ar-1a-customer-master-ar-foundation-
 * proposal.md) — mirroring AccountsPayableModule's own AP-1a shape;
 * AR-1b adds Customer Invoicing below
 * (docs/finance-work-item-ar-1b-customer-invoicing-proposal.md), the
 * same way AP-1b extended AccountsPayableModule with SupplierBillsModule.
 * Later AR Work Items (receipts, allocations, reporting) will add
 * further sibling imports here, the same way AP-1c/1d continued
 * AccountsPayableModule.
 */
@Module({
  imports: [CustomersModule, ArSettingsModule, CustomerInvoicesModule],
})
export class AccountsReceivableModule {}
