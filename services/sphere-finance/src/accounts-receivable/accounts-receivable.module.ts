import { Module } from "@nestjs/common";
import { CustomersModule } from "./customers/customers.module";
import { ArSettingsModule } from "./ar-settings/ar-settings.module";
import { CustomerInvoicesModule } from "./customer-invoices/customer-invoices.module";
import { CustomerReceiptsModule } from "./customer-receipts/customer-receipts.module";
import { ArReportsModule } from "./ar-reports/ar-reports.module";
import { CustomerCreditNotesModule } from "./customer-credit-notes/customer-credit-notes.module";

/**
 * AR Foundation's parent module. AR-1a wired Customer Master + AR
 * Settings (docs/finance-work-item-ar-1a-customer-master-ar-foundation-
 * proposal.md) — mirroring AccountsPayableModule's own AP-1a shape;
 * AR-1b added Customer Invoicing
 * (docs/finance-work-item-ar-1b-customer-invoicing-proposal.md), the
 * same way AP-1b extended AccountsPayableModule with SupplierBillsModule.
 * AR-1c added Customer Receipts & Settlement
 * (docs/finance-work-item-1c-customer-receipts-proposal.md), the same
 * way AP-1c extended AccountsPayableModule with SupplierPaymentsModule.
 * AR-1d added AR Reporting
 * (docs/finance-work-item-1d-ar-reports-proposal.md), the same way
 * AP-1d extended AccountsPayableModule with ApReportsModule. The Credit/
 * Debit Notes work item now adds Customer Credit Notes below
 * (docs/finance-work-item-credit-debit-notes-proposal.md, CTO-approved)
 * — a correction document against POSTED customer invoices, the AR
 * mirror of AccountsPayableModule's SupplierDebitNotesModule.
 */
@Module({
  imports: [
    CustomersModule,
    ArSettingsModule,
    CustomerInvoicesModule,
    CustomerReceiptsModule,
    ArReportsModule,
    CustomerCreditNotesModule,
  ],
})
export class AccountsReceivableModule {}
