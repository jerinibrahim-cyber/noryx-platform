import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BankTransactionsService } from "../bank-transactions/bank-transactions.service";
import { PaymentProviderSettlementsController } from "./payment-provider-settlements.controller";
import { PaymentProviderSettlementsService } from "./payment-provider-settlements.service";

/**
 * Banking-1e — registers BankTransactionsService as its own provider (a
 * SECOND DI registration of the same, entirely unmodified class — not
 * importing BankTransactionsModule) solely so
 * PaymentProviderSettlementsService can call its existing `create()`
 * method verbatim for the create-settlement-transactions convenience
 * (§19). Identical reasoning and pattern as
 * BankReconciliationModule (Banking-1c): the CTO's implementation
 * authorization locks "no changes to Banking-1b" as an explicit
 * architectural boundary, and BankTransactionsService has no
 * constructor-injected dependencies (it reaches the DB only through the
 * shared withTenant()/getDb() singletons), so a second registration is
 * safe and behaviorally identical to the one BankTransactionsModule
 * itself creates — zero bytes of bank-transactions.module.ts or
 * bank-transactions.service.ts change as a result.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [PaymentProviderSettlementsController],
  providers: [PaymentProviderSettlementsService, BankTransactionsService],
})
export class PaymentProviderSettlementsModule {}
