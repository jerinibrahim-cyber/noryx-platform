import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  and,
  asc,
  auditLogs,
  eq,
  inArray,
  legalEntities,
  lte,
} from "@noryx/db-core";
import {
  chartOfAccounts,
  deferralRecognitions,
  deferralSchedules,
  type DeferralRecognition,
  type DeferralSchedule,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { JournalEntriesService } from "../journal-entries/journal-entries.service";
import type { CreateJournalLineDto } from "../journal-entries/dto/create-journal-line.dto";
import type { CreateDeferralScheduleDto } from "./dto/create-deferral-schedule.dto";
import type { CancelDeferralScheduleDto } from "./dto/cancel-deferral-schedule.dto";

/** Same batching rationale as ScheduledReversalsService's
 * CANDIDATE_BATCH_SIZE (CONTRACT.md §6, §9 — no queue/worker
 * infrastructure exists in this codebase to page through the remainder
 * automatically; a caller with more than this many due occurrences
 * calls `process-due` again). */
const CANDIDATE_BATCH_SIZE = 100;

export interface ListDeferralSchedulesFilters {
  status?: "ACTIVE" | "COMPLETED" | "CANCELLED";
}

export type DeferralScheduleWithRecognitions = DeferralSchedule & {
  recognitions: DeferralRecognition[];
  /** Derived, never stored: totalAmountMinor minus the sum of every
   * EXECUTED occurrence's amountMinor (CONTRACT.md §1's aggregate
   * invariant, read from the EXECUTED subset rather than a separate
   * counter — DEFER-027). */
  remainingBalanceMinor: number;
};

export interface ProcessDueResult {
  claimed: number;
  executed: number;
  failed: number;
}

type ClaimOutcome = "executed" | "failed" | "skipped";

/**
 * Generic Deferral Recognition Engine — Phase 2 Implementation Contract
 * (docs/work-items/deferral-recognition-engine/CONTRACT.md), CTO-
 * authorized implementation. Orchestrates JournalEntriesService's new
 * `postSystemGeneratedEntry()` (CONTRACT.md §5) on a schedule of future
 * dates; this service never builds or posts a journal entry itself —
 * `postSystemGeneratedEntry()` is the only place that happens for
 * system-generated entries (journal-entries.service.ts doc comment).
 *
 * One combined service for both schedule management (create/cancel/
 * list/findOne) and occurrence execution (processDue/claimAndExecuteOne)
 * — the same shape as ScheduledReversalsService, not split into two
 * services; CONTRACT.md §5's "RecognitionExecutionsService" naming was
 * provisional Phase 2 language, not a mandated split, and a split here
 * would be unjustified complexity for a capability whose full mutation
 * surface (CONTRACT.md §4) is five operations total.
 *
 * Lock order, on the one path that touches more than one row-locked
 * resource in a transaction (`claimAndExecuteOne`, CONTRACT.md §6):
 *   (1) deferral_recognitions row (`FOR UPDATE SKIP LOCKED`)
 *       -> (2) accounting_periods row (`resolvePeriodForDate()`).
 * Simpler than ScheduledReversalsService's three-resource order — there
 * is no "original entry" to lock first (this is fresh recognition, not
 * a reversal of something already posted).
 */
@Injectable()
export class DeferralRecognitionService {
  constructor(private readonly journalEntries: JournalEntriesService) {}

  /**
   * CONTRACT.md §4: validates accounts/currency/amount-sum, inserts the
   * header + all N occurrence rows (explicit dates/amounts from the
   * request — never computed by even division), all in one transaction.
   * The deferred `deferral_recognitions_reconciled_check` trigger
   * (030_...) independently re-proves the amount-sum invariant at
   * commit time regardless of this application-level check.
   */
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateDeferralScheduleDto,
  ): Promise<DeferralScheduleWithRecognitions> {
    return withTenant(tenantId, async (tx: TxClient) => {
      if (dto.deferredAccountId === dto.recognitionAccountId) {
        throw new UnprocessableEntityException(
          "deferredAccountId and recognitionAccountId must be different accounts.",
        );
      }

      await this.validateAccountsOrThrow(tx, tenantId, legalEntityId, [
        dto.deferredAccountId,
        dto.recognitionAccountId,
      ]);

      const occurrenceSum = dto.occurrences.reduce(
        (sum, o) => sum + o.amountMinor,
        0,
      );
      if (occurrenceSum !== dto.totalAmountMinor) {
        throw new UnprocessableEntityException(
          `Occurrence amounts sum to ${occurrenceSum}, which does not equal totalAmountMinor (${dto.totalAmountMinor}).`,
        );
      }

      const targetDates = new Set<string>();
      for (const occurrence of dto.occurrences) {
        if (targetDates.has(occurrence.targetDate)) {
          throw new UnprocessableEntityException(
            `Two occurrences cannot share the same targetDate (${occurrence.targetDate}).`,
          );
        }
        targetDates.add(occurrence.targetDate);
      }

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );

      const [createdSchedule] = await tx
        .insert(deferralSchedules)
        .values({
          tenantId,
          legalEntityId,
          memo: dto.memo,
          currencyCode,
          totalAmountMinor: dto.totalAmountMinor,
          deferralType: dto.deferralType,
          deferredAccountId: dto.deferredAccountId,
          recognitionAccountId: dto.recognitionAccountId,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const sortedOccurrences = [...dto.occurrences].sort((a, b) =>
        a.targetDate.localeCompare(b.targetDate),
      );

      const insertedRecognitions = await tx
        .insert(deferralRecognitions)
        .values(
          sortedOccurrences.map((occurrence, index) => ({
            scheduleId: createdSchedule!.id,
            tenantId,
            legalEntityId,
            sequenceNumber: index + 1,
            targetDate: occurrence.targetDate,
            amountMinor: occurrence.amountMinor,
          })),
        )
        .returning();

      const full: DeferralScheduleWithRecognitions = {
        ...createdSchedule!,
        recognitions: insertedRecognitions,
        remainingBalanceMinor: createdSchedule!.totalAmountMinor,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "deferral_schedule",
        entityId: createdSchedule!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  /** CONTRACT.md §4: bulk-transitions remaining SCHEDULED occurrences
   * to CANCELLED + header ACTIVE -> CANCELLED, one transaction. Not
   * reversible (no "uncancel" exists for any entity in this codebase).
   * The terminal-immutability trigger (028_...) permits this — it only
   * blocks mutation once a row is ALREADY terminal. */
  async cancel(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: CancelDeferralScheduleDto,
  ): Promise<DeferralScheduleWithRecognitions> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [existing] = await tx
        .select()
        .from(deferralSchedules)
        .where(
          and(
            eq(deferralSchedules.id, id),
            eq(deferralSchedules.tenantId, tenantId),
            eq(deferralSchedules.legalEntityId, legalEntityId),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) {
        throw new NotFoundException(
          `No deferral schedule found with id ${id}.`,
        );
      }
      if (existing.status !== "ACTIVE") {
        throw new ConflictException(
          `This deferral schedule is already ${existing.status} and cannot be cancelled.`,
        );
      }

      await tx
        .update(deferralRecognitions)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(deferralRecognitions.scheduleId, id),
            eq(deferralRecognitions.tenantId, tenantId),
            eq(deferralRecognitions.legalEntityId, legalEntityId),
            eq(deferralRecognitions.status, "SCHEDULED"),
          ),
        );

      const [updatedSchedule] = await tx
        .update(deferralSchedules)
        .set({
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledBy: actorUserId ?? null,
          cancellationReason: dto.reason ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deferralSchedules.id, id),
            eq(deferralSchedules.tenantId, tenantId),
            eq(deferralSchedules.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      const recognitions = await tx
        .select()
        .from(deferralRecognitions)
        .where(eq(deferralRecognitions.scheduleId, id))
        .orderBy(asc(deferralRecognitions.sequenceNumber));

      const full = this.withRemainingBalance(updatedSchedule!, recognitions);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CANCEL",
        entityType: "deferral_schedule",
        entityId: id,
        beforeState: existing as unknown as Record<string, unknown>,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListDeferralSchedulesFilters,
  ): Promise<DeferralSchedule[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(deferralSchedules.tenantId, tenantId),
        eq(deferralSchedules.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(deferralSchedules.status, filters.status));
      }
      return tx
        .select()
        .from(deferralSchedules)
        .where(and(...conditions))
        .orderBy(asc(deferralSchedules.createdAt), asc(deferralSchedules.id));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<DeferralScheduleWithRecognitions> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const schedule = await this.findScheduleOrThrow(
        tx,
        tenantId,
        legalEntityId,
        id,
      );
      const recognitions = await tx
        .select()
        .from(deferralRecognitions)
        .where(eq(deferralRecognitions.scheduleId, id))
        .orderBy(asc(deferralRecognitions.sequenceNumber));
      return this.withRemainingBalance(schedule, recognitions);
    });
  }

  /** Forward drill-down (DEFER-027): a schedule's own occurrences,
   * without the schedule header — the same data findOne() returns
   * nested, exposed as its own route for a caller that already has the
   * schedule and only wants the occurrence list. */
  async listRecognitions(
    tenantId: string,
    legalEntityId: string,
    scheduleId: string,
  ): Promise<DeferralRecognition[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.findScheduleOrThrow(tx, tenantId, legalEntityId, scheduleId);
      return tx
        .select()
        .from(deferralRecognitions)
        .where(eq(deferralRecognitions.scheduleId, scheduleId))
        .orderBy(asc(deferralRecognitions.sequenceNumber));
    });
  }

  /** Reverse drill-down (DEFER-018/DEFER-027): journal entry ->
   * occurrence -> schedule, the other direction of the same
   * `deferral_recognitions.resulting_journal_entry_id` chain findOne()
   * exposes forward. */
  async findRecognitionByJournalEntryId(
    tenantId: string,
    legalEntityId: string,
    journalEntryId: string,
  ): Promise<DeferralRecognition> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [row] = await tx
        .select()
        .from(deferralRecognitions)
        .where(
          and(
            eq(deferralRecognitions.resultingJournalEntryId, journalEntryId),
            eq(deferralRecognitions.tenantId, tenantId),
            eq(deferralRecognitions.legalEntityId, legalEntityId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new NotFoundException(
          `No deferral recognition found resulting in journal entry ${journalEntryId}.`,
        );
      }
      return row;
    });
  }

  /** CONTRACT.md §6: candidate selection is a lock-free read in its own
   * short transaction; each candidate is then claimed and executed in a
   * SEPARATE subsequent transaction (`claimAndExecuteOne`), one at a
   * time — never batched together, so one candidate's work/locks can
   * never block or extend another's. Direct structural mirror of
   * ScheduledReversalsService.processDue(). */
  async processDue(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    asOfDate?: string,
  ): Promise<ProcessDueResult> {
    const cutoff = asOfDate ?? new Date().toISOString().slice(0, 10);
    const result: ProcessDueResult = { claimed: 0, executed: 0, failed: 0 };

    const candidates = await withTenant(tenantId, (tx: TxClient) =>
      tx
        .select({ id: deferralRecognitions.id })
        .from(deferralRecognitions)
        .where(
          and(
            eq(deferralRecognitions.tenantId, tenantId),
            eq(deferralRecognitions.legalEntityId, legalEntityId),
            eq(deferralRecognitions.status, "SCHEDULED"),
            lte(deferralRecognitions.targetDate, cutoff),
          ),
        )
        .orderBy(
          asc(deferralRecognitions.targetDate),
          asc(deferralRecognitions.id),
        )
        .limit(CANDIDATE_BATCH_SIZE),
    );

    for (const { id } of candidates) {
      const outcome = await this.claimAndExecuteOne(
        tenantId,
        legalEntityId,
        actorUserId,
        id,
      );
      if (outcome === "skipped") continue;
      result.claimed += 1;
      result[outcome] += 1;
    }

    return result;
  }

  /**
   * CONTRACT.md §6, the core algorithm. Runs entirely inside ONE
   * transaction:
   *   (1) `deferral_recognitions` row — `FOR UPDATE SKIP LOCKED`, so a
   *       concurrent claim of the SAME row never blocks — it just skips.
   *   (2) `accounting_periods` row — via `resolvePeriodForDate()`.
   * No `PROCESSING` intermediate state (CONTRACT.md §2) — a claim that
   * never commits simply leaves the row SCHEDULED, safely retried by
   * the next `process-due` call.
   */
  private async claimAndExecuteOne(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    recognitionId: string,
  ): Promise<ClaimOutcome> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [claimed] = await tx
        .select()
        .from(deferralRecognitions)
        .where(
          and(
            eq(deferralRecognitions.id, recognitionId),
            eq(deferralRecognitions.tenantId, tenantId),
            eq(deferralRecognitions.legalEntityId, legalEntityId),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);

      if (!claimed || claimed.status !== "SCHEDULED") {
        // Either a concurrent caller already holds/held this row (SKIP
        // LOCKED returned nothing), the owning schedule was cancelled
        // concurrently (bulk UPDATE in cancel() takes the same row
        // lock), or it was already resolved since candidate selection
        // ran — either way, not this call's problem; a no-op.
        return "skipped";
      }

      const [schedule] = await tx
        .select()
        .from(deferralSchedules)
        .where(eq(deferralSchedules.id, claimed.scheduleId))
        .limit(1);
      // Defensive only — a deferral_recognitions row's schedule_id FK
      // guarantees the parent row exists and is never deleted (no
      // delete path for either table).
      if (!schedule) {
        await this.transitionToFailed(
          tx,
          tenantId,
          legalEntityId,
          actorUserId,
          claimed,
          "The owning deferral schedule could not be found.",
        );
        return "failed";
      }

      const resolution = await this.journalEntries.resolvePeriodForDate(
        tx,
        tenantId,
        legalEntityId,
        claimed.targetDate,
      );

      if (resolution.kind === "NOT_FOUND") {
        // Mirrors scheduled_reversals' identical precedent: accounting
        // periods are "create, list, close only", so a period covering
        // this date may still be created later. Stays SCHEDULED;
        // retried on a future process-due call. Not a failure.
        return "skipped";
      }

      if (resolution.kind === "CLOSED") {
        await this.transitionToFailed(
          tx,
          tenantId,
          legalEntityId,
          actorUserId,
          claimed,
          `Accounting period "${resolution.period.code}" covering ${claimed.targetDate} is closed.`,
        );
        return "failed";
      }

      // OPEN — re-validate both accounts independently of whatever
      // passed at schedule-creation time (CONTRACT.md §3's account
      // re-validation row) before ever calling
      // postSystemGeneratedEntry(). An account can be archived between
      // schedule creation and this occurrence's execution date.
      try {
        await this.validateAccountsOrThrow(tx, tenantId, legalEntityId, [
          schedule.deferredAccountId,
          schedule.recognitionAccountId,
        ]);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Unable to validate the schedule's accounts.";
        await this.transitionToFailed(
          tx,
          tenantId,
          legalEntityId,
          actorUserId,
          claimed,
          message,
        );
        return "failed";
      }

      const lines: CreateJournalLineDto[] =
        schedule.deferralType === "EXPENSE_RECOGNITION"
          ? [
              {
                accountId: schedule.recognitionAccountId,
                debitMinor: claimed.amountMinor,
                creditMinor: 0,
              },
              {
                accountId: schedule.deferredAccountId,
                debitMinor: 0,
                creditMinor: claimed.amountMinor,
              },
            ]
          : [
              {
                accountId: schedule.deferredAccountId,
                debitMinor: claimed.amountMinor,
                creditMinor: 0,
              },
              {
                accountId: schedule.recognitionAccountId,
                debitMinor: 0,
                creditMinor: claimed.amountMinor,
              },
            ];

      const posted = await this.journalEntries.postSystemGeneratedEntry(
        tx,
        tenantId,
        legalEntityId,
        actorUserId,
        lines,
        resolution.period,
        claimed.targetDate,
        `Deferral recognition ${claimed.sequenceNumber} of ${schedule.memo}`,
        schedule.currencyCode,
      );

      const [executedRow] = await tx
        .update(deferralRecognitions)
        .set({
          status: "EXECUTED",
          resultingJournalEntryId: posted.id,
          executedAt: new Date(),
          executedBy: actorUserId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deferralRecognitions.id, claimed.id),
            eq(deferralRecognitions.tenantId, tenantId),
            eq(deferralRecognitions.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "EXECUTE",
        entityType: "deferral_recognition",
        entityId: claimed.id,
        beforeState: claimed as unknown as Record<string, unknown>,
        afterState: executedRow as unknown as Record<string, unknown>,
      });

      await this.completeScheduleIfDone(
        tx,
        tenantId,
        legalEntityId,
        actorUserId,
        schedule.id,
      );

      return "executed";
    });
  }

  private async transitionToFailed(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    claimed: DeferralRecognition,
    failureReason: string,
  ): Promise<void> {
    const [failedRow] = await tx
      .update(deferralRecognitions)
      .set({
        status: "FAILED",
        failureReason,
        executedAt: new Date(),
        executedBy: actorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deferralRecognitions.id, claimed.id),
          eq(deferralRecognitions.tenantId, tenantId),
          eq(deferralRecognitions.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId,
      legalEntityId,
      actorUserId: actorUserId ?? undefined,
      action: "FAIL",
      entityType: "deferral_recognition",
      entityId: claimed.id,
      beforeState: claimed as unknown as Record<string, unknown>,
      afterState: failedRow as unknown as Record<string, unknown>,
    });

    // A FAILED occurrence still counts toward "no SCHEDULED occurrences
    // remain" (CONTRACT.md §2 — a schedule's natural end state may
    // legitimately be a mix of EXECUTED and FAILED; nothing auto-
    // retries a FAILED row).
    await this.completeScheduleIfDone(
      tx,
      tenantId,
      legalEntityId,
      actorUserId,
      claimed.scheduleId,
    );
  }

  /** CONTRACT.md §2: system-transitions ACTIVE -> COMPLETED once no
   * occurrence for this schedule remains SCHEDULED. Guarded on
   * `status = 'ACTIVE'` so this is a no-op for an already-CANCELLED
   * schedule (defensive: cancel() already transitions every remaining
   * SCHEDULED occurrence to CANCELLED in the same transaction, so no
   * SCHEDULED row should ever outlive a CANCELLED schedule). */
  private async completeScheduleIfDone(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    scheduleId: string,
  ): Promise<void> {
    const remaining = await tx
      .select({ id: deferralRecognitions.id })
      .from(deferralRecognitions)
      .where(
        and(
          eq(deferralRecognitions.scheduleId, scheduleId),
          eq(deferralRecognitions.status, "SCHEDULED"),
        ),
      )
      .limit(1);
    if (remaining.length > 0) return;

    const [completedSchedule] = await tx
      .update(deferralSchedules)
      .set({ status: "COMPLETED", updatedAt: new Date() })
      .where(
        and(
          eq(deferralSchedules.id, scheduleId),
          eq(deferralSchedules.tenantId, tenantId),
          eq(deferralSchedules.legalEntityId, legalEntityId),
          eq(deferralSchedules.status, "ACTIVE"),
        ),
      )
      .returning();
    if (!completedSchedule) return;

    await tx.insert(auditLogs).values({
      tenantId,
      legalEntityId,
      actorUserId: actorUserId ?? undefined,
      action: "COMPLETE",
      entityType: "deferral_schedule",
      entityId: scheduleId,
      beforeState: null,
      afterState: completedSchedule as unknown as Record<string, unknown>,
    });
  }

  private withRemainingBalance(
    schedule: DeferralSchedule,
    recognitions: DeferralRecognition[],
  ): DeferralScheduleWithRecognitions {
    const executedSum = recognitions
      .filter((r) => r.status === "EXECUTED")
      .reduce((sum, r) => sum + r.amountMinor, 0);
    return {
      ...schedule,
      recognitions,
      remainingBalanceMinor: schedule.totalAmountMinor - executedSum,
    };
  }

  private async findScheduleOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<DeferralSchedule> {
    const [row] = await tx
      .select()
      .from(deferralSchedules)
      .where(
        and(
          eq(deferralSchedules.id, id),
          eq(deferralSchedules.tenantId, tenantId),
          eq(deferralSchedules.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new NotFoundException(`No deferral schedule found with id ${id}.`);
    }
    return row;
  }

  /** Same trivial single-table existence/active/scope check every other
   * service in this codebase does inline rather than routing through
   * JournalEntriesService (see AccountsService, BankTransactionsService,
   * BudgetLinesService, TaxCodesService — postSystemGeneratedEntry()'s
   * own doc comment lists this precedent explicitly). Deliberately does
   * not distinguish "doesn't exist" from "exists in a different tenant/
   * entity" from "inactive" — same information-disclosure convention as
   * JournalEntriesService.validateLinesOrThrow(). */
  private async validateAccountsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(accountIds)];
    const validAccounts = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
          inArray(chartOfAccounts.id, uniqueIds),
        ),
      );
    const validIds = new Set(validAccounts.map((a) => a.id));
    const invalid = uniqueIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  /** Same trivial single-table lookup every other service does inline
   * rather than depending on JournalEntriesService's own private
   * resolveCurrency() (same precedent as validateAccountsOrThrow()
   * above). */
  private async resolveCurrency(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const [entity] = await tx
      .select({ currencyCode: legalEntities.currencyCode })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.id, legalEntityId),
          eq(legalEntities.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!entity) {
      throw new NotFoundException(
        "Legal entity context could not be resolved for this token.",
      );
    }
    return entity.currencyCode;
  }
}
