import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { JournalEntriesService } from "../journal-entries/journal-entries.service";
import { ScheduledReversalsController } from "./scheduled-reversals.controller";
import { ScheduledReversalsService } from "./scheduled-reversals.service";

/**
 * Scheduled Reversal for Accruals and Other Timing Adjustments — Final
 * Implementation Specification (Revision 2), §19. Registers
 * `JournalEntriesService` as a SECOND DI provider (not importing
 * `JournalEntriesModule`) solely so `ScheduledReversalsService` can call
 * its `lockAndValidateOriginalForReversal()`, `resolvePeriodForDate()`
 * and `completeReversalPosting()` methods directly — the exact same
 * pattern `PaymentProviderSettlementsModule` already established for
 * `BankTransactionsService` (Banking-1e). Safe for the identical
 * reason: `JournalEntriesService` has no constructor-injected
 * dependencies of its own (it reaches the DB only through the shared
 * `withTenant()`/`getDb()` singletons in `../db/db`), so a second
 * registration is behaviorally identical to the one
 * `JournalEntriesModule` itself creates. Zero bytes of
 * journal-entries.module.ts change as a result.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [ScheduledReversalsController],
  providers: [ScheduledReversalsService, JournalEntriesService],
})
export class ScheduledReversalsModule {}
