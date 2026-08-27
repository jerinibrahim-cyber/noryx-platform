import { Module } from "@nestjs/common";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { ApSettingsModule } from "./ap-settings/ap-settings.module";
import { SupplierBillsModule } from "./supplier-bills/supplier-bills.module";
import { SupplierPaymentsModule } from "./supplier-payments/supplier-payments.module";
import { ApReportsModule } from "./ap-reports/ap-reports.module";
import { SupplierDebitNotesModule } from "./supplier-debit-notes/supplier-debit-notes.module";

/**
 * AP Foundation's parent module. AP-1a wired Supplier Master + AP
 * Settings; AP-1b added Supplier Bills; AP-1c added Supplier Payments &
 * Allocations (docs/finance-work-item-1c-supplier-payments-proposal.md);
 * AP-1d added AP Reporting — Supplier Balance, Supplier Statement, AP
 * Ageing, AP/GL Reconciliation (docs/finance-work-item-1d-supplier-
 * balance-statement-ageing-proposal.md). The Credit/Debit Notes work
 * item now adds Supplier Debit Notes below
 * (docs/finance-work-item-credit-debit-notes-proposal.md, CTO-approved)
 * — a correction document against POSTED supplier bills, the AP mirror
 * of AccountsReceivableModule's CustomerCreditNotesModule.
 */
@Module({
  imports: [
    SuppliersModule,
    ApSettingsModule,
    SupplierBillsModule,
    SupplierPaymentsModule,
    ApReportsModule,
    SupplierDebitNotesModule,
  ],
})
export class AccountsPayableModule {}
