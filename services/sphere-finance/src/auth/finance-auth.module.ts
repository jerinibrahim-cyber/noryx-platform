import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./strategies/jwt.strategy";

/**
 * Shared auth wiring for 2c-1's two new modules
 * (AccountingPeriodsModule, JournalEntriesModule) — introduced so the
 * same PassportModule import + JwtStrategy provider isn't repeated a
 * third time. AccountsModule (1b/2a) deliberately does NOT import this
 * and is not touched by 2c-1 — it keeps its own existing inline
 * registration exactly as it was reviewed and approved
 * (docs/finance-2c-journal-entry-service-proposal.md §0.1/§2.1). If a
 * real need arises to unify all three later, that's a separate,
 * explicitly-scoped refactor, not part of 2c.
 */
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class FinanceAuthModule {}
