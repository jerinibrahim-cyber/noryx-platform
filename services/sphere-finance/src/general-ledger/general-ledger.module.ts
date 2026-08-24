import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { GeneralLedgerController } from "./general-ledger.controller";
import { GeneralLedgerService } from "./general-ledger.service";

// 2d — General Ledger read layer. Milestone 3.2 Stage 1 — FinanceAuthModule
// (formerly ../auth/finance-auth.module) was replaced by the shared
// @noryx/auth-core package's AuthCoreModule; identical wiring, now shared
// platform-wide (including AccountsModule, which previously had its own
// separate inline registration) rather than Finance-only.
@Module({
  imports: [AuthCoreModule],
  controllers: [GeneralLedgerController],
  providers: [GeneralLedgerService],
})
export class GeneralLedgerModule {}
