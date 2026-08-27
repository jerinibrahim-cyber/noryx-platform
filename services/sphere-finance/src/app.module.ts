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
