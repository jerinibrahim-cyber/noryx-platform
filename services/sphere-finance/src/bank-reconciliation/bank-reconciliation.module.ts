import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { BankTransactionsService } from "../bank-transactions/bank-transactions.service";
import { BankReconciliationController } from "./bank-reconciliation.controller";
import { BankReconciliationService } from "./bank-reconciliation.service";

/**
 * Banking-1c — registers BankTransactionsService as its own provider
 * (a SECOND DI registration of the same, entirely unmodified class —
 * not importing BankTransactionsModule) solely so
 * BankReconciliationService can call its existing `create()` method
 * verbatim for the create-from-line convenience (§10). Deliberately
 * does NOT import BankTransactionsModule or add an `exports` array to
 * it — the CTO's implementation authorization locks "no changes to
 * Banking-1b" as an explicit architectural boundary, and
 * BankTransactionsService has no constructor-injected dependencies (it
 * reaches the DB only through the shared withTenant()/getDb()
 * singletons), so a second registration is safe and behaviorally
 * identical to the one BankTransactionsModule itself creates — zero
 * bytes of bank-transactions.module.ts or bank-transactions.service.ts
 * change as a result.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [BankReconciliationController],
  providers: [BankReconciliationService, BankTransactionsService],
})
export class BankReconciliationModule {}
