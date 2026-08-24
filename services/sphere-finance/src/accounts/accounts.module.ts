import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";

// Milestone 3.2 Stage 1 — replaces the direct PassportModule import + local
// JwtStrategy provider with the shared AuthCoreModule
// (docs/hardening/milestone-3.2-proposal.md §9 item 1). Behavior is
// unchanged: AuthCoreModule registers the identical "jwt" Passport
// strategy. This also folds AccountsModule into the same shared-wiring
// pattern AccountingPeriodsModule/JournalEntriesModule/GeneralLedgerModule
// already used via FinanceAuthModule (see that file's own former doc
// comment, which explicitly deferred this exact unification to a later,
// separately-scoped refactor).
@Module({
  imports: [AuthCoreModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
