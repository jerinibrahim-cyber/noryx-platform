import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AccountsModule } from "./accounts/accounts.module";
import { AccountingPeriodsModule } from "./accounting-periods/accounting-periods.module";
import { JournalEntriesModule } from "./journal-entries/journal-entries.module";
import { GeneralLedgerModule } from "./general-ledger/general-ledger.module";
import { FinancialStatementsModule } from "./financial-statements/financial-statements.module";
import { AccountsPayableModule } from "./accounts-payable/accounts-payable.module";
import { AccountsReceivableModule } from "./accounts-receivable/accounts-receivable.module";
import { BankCashAccountsModule } from "./bank-cash-accounts/bank-cash-accounts.module";
import { BankTransactionsModule } from "./bank-transactions/bank-transactions.module";
import { BankReconciliationModule } from "./bank-reconciliation/bank-reconciliation.module";
import { BankReportsModule } from "./bank-reports/bank-reports.module";
import { HealthController } from "./health/health.controller";
import { TenantContextMiddleware } from "./tenant/tenant-context.middleware";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AccountsModule,
    // 2c-1 — accounting periods + journal entry draft CRUD.
    AccountingPeriodsModule,
    // 2c-2 — posting, numbering, reversal (routes added to
    // JournalEntriesModule's existing controller/service).
    JournalEntriesModule,
    // 2d — General Ledger read layer: Account Ledger, Account Balance,
    // Trial Balance. Read-only; queries the tables the three modules
    // above already own, touches none of their files.
    GeneralLedgerModule,
    // Financial Statements — Profit & Loss, Balance Sheet.
    // docs/finance-work-item-financial-statements-proposal.md §13/§14. A
    // top-level Accounting Core sibling of GeneralLedgerModule; pure read
    // layer over the same tables, touches none of the modules above.
    FinancialStatementsModule,
    // AP-1a — Supplier Master + AP Settings (Accounts Payable Foundation).
    // docs/finance-work-item-1-ap-foundation-proposal.md §22. Reads/writes
    // its own new tables only; touches none of the four modules above.
    AccountsPayableModule,
    // AR-1a — Customer Master + AR Settings (Accounts Receivable
    // Foundation). docs/finance-work-item-ar-1a-customer-master-ar-
    // foundation-proposal.md §6. Reads/writes its own new tables only;
    // touches none of the modules above — sibling of AccountsPayableModule,
    // not nested inside it.
    AccountsReceivableModule,
    // Banking-1a — Bank/Cash Account Master.
    // docs/finance-work-item-banking-cash-management-proposal.md §13,
    // CTO-approved (Banking-1a scope only). A top-level sibling of
    // AccountsPayableModule/AccountsReceivableModule, NOT nested inside
    // either — Banking is its own domain that both will eventually read
    // from (a Bank/Cash Account is resolved for an existing payment/
    // receipt via a read-side join, not a dependency in either
    // direction). Reads/writes its own new table only; touches none of
    // the modules above.
    BankCashAccountsModule,
    // Banking-1b — Bank Transactions.
    // docs/finance-work-item-banking-1b-proposal.md §13, CTO-approved
    // (Banking-1b scope only — Banking-1c/statement import/reconciliation
    // are not implemented here). A top-level sibling of
    // BankCashAccountsModule, not nested inside it — mirrors how
    // AccountsPayableModule/AccountsReceivableModule are siblings of the
    // Accounting Core modules, not children of one another. Reads/writes
    // its own new table only (bank_transactions), plus the shared
    // journal_entries/journal_lines/journal_number_counters tables every
    // posting sub-ledger already writes into; touches none of the
    // modules above.
    BankTransactionsModule,
    // Banking-1c — Bank Statement Import & Bank Reconciliation.
    // docs/finance-work-item-banking-1c-proposal.md §13/§20, CTO-approved
    // (implementation-authorization turn, amended proposal, locked
    // semantics). A top-level sibling of BankTransactionsModule, not
    // nested inside it — reads Banking-1a/1b's tables (bank_cash_accounts,
    // bank_transactions) and the shared journal_entries/journal_lines
    // tables read-only for its BOOK BALANCE computation (§17), and calls
    // BankTransactionsService.create() verbatim for the create-from-line
    // convenience (§10, its own module registers a second DI instance of
    // that dependency-free service rather than importing
    // BankTransactionsModule — zero changes to any Banking-1b file).
    // Reads/writes its own three new tables only
    // (bank_statement_imports/bank_statement_lines/
    // bank_reconciliation_matches); touches none of the modules above.
    BankReconciliationModule,
    // Banking-1d — Cash Position, Bank/Cash Account Statement,
    // Unreconciled Transactions. docs/finance-work-item-banking-1d-
    // proposal.md §4/§6. A top-level sibling of BankReconciliationModule,
    // not nested inside it — a pure read layer over bank_cash_accounts/
    // bank_transactions/bank_reconciliation_matches/
    // bank_statement_lines/supplier_payments/customer_receipts/
    // journal_lines, all owned by other modules; writes nothing and
    // touches none of the modules above. No new table, no migration.
    BankReportsModule,
    // Scoped registration so TenantContextMiddleware can inject JwtService
    // without importing AccountsModule's other providers — same pattern as
    // services/identity/src/app.module.ts.
    JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET }),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
