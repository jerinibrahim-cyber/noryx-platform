import { Module } from "@nestjs/common";
import { CustomersModule } from "./customers/customers.module";
import { ArSettingsModule } from "./ar-settings/ar-settings.module";
import { CustomerInvoicesModule } from "./customer-invoices/customer-invoices.module";
import { CustomerReceiptsModule } from "./customer-receipts/customer-receipts.module";

/**
 * AR Foundation's parent module. AR-1a wired Customer Master + AR
 * Settings (docs/finance-work-item-ar-1a-customer-master-ar-foundation-
 * proposal.md) — mirroring AccountsPayableModule's own AP-1a shape;
 * AR-1b added Customer Invoicing
 * (docs/finance-work-item-ar-1b-customer-invoicing-proposal.md), the
 * same way AP-1b extended AccountsPayableModule with SupplierBillsModule.
 * AR-1c adds Customer Receipts & Settlement below
 * (docs/finance-work-item-1c-customer-receipts-proposal.md), the same
 * way AP-1c extended AccountsPayableModule with SupplierPaymentsModule.
 * Later AR Work Items (reporting) will add further sibling imports here,
 * the same way AP-1d continued AccountsPayableModule.
 */
@Module({
  imports: [
    CustomersModule,
    ArSettingsModule,
    CustomerInvoicesModule,
    CustomerReceiptsModule,
  ],
})
export class AccountsReceivableModule {}
