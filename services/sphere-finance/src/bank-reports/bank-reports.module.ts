import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BankReportsController } from "./bank-reports.controller";
import { BankReportsService } from "./bank-reports.service";

/**
 * Banking-1d — Cash Position, Bank/Cash Account Statement, Unreconciled
 * Transactions. docs/finance-work-item-banking-1d-proposal.md §4. Reads
 * bank_cash_accounts/bank_transactions/bank_reconciliation_matches/
 * bank_statement_lines/supplier_payments/customer_receipts/journal_lines
 * — all owned by other modules — but writes nothing; no cross-module DI
 * dependency exists here (unlike BankReconciliationModule's second
 * BankTransactionsService registration), since every query in this
 * module is a plain read against tables already reachable via the shared
 * db client. Registered as a top-level sibling of the other three
 * Banking modules in AppModule, not nested under a wrapper — Banking has
 * no wrapper module (unlike AP/AR's ApReportsModule/ArReportsModule,
 * which nest inside AccountsPayableModule/AccountsReceivableModule).
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [BankReportsController],
  providers: [BankReportsService],
})
export class BankReportsModule {}
