import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { JournalEntriesService } from "../journal-entries/journal-entries.service";
import { DeferralRecognitionController } from "./deferral-recognition.controller";
import { DeferralRecognitionService } from "./deferral-recognition.service";

/**
 * Generic Deferral Recognition Engine — Phase 2 Implementation Contract
 * (docs/work-items/deferral-recognition-engine/CONTRACT.md), CTO-
 * authorized implementation. Registers `JournalEntriesService` as a
 * SECOND DI provider (not importing `JournalEntriesModule`) solely so
 * `DeferralRecognitionService` can call its new
 * `postSystemGeneratedEntry()` method directly — the exact same pattern
 * `ScheduledReversalsModule` already established for the same service.
 * Safe for the identical reason: `JournalEntriesService` has no
 * constructor-injected dependencies of its own, so a second
 * registration is behaviorally identical to the one
 * `JournalEntriesModule` itself creates. Zero bytes of
 * journal-entries.module.ts change as a result.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [DeferralRecognitionController],
  providers: [DeferralRecognitionService, JournalEntriesService],
})
export class DeferralRecognitionModule {}
