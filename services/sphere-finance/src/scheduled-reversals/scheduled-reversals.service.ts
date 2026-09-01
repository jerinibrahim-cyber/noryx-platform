import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, asc, auditLogs, eq, lte } from "@noryx/db-core";
import { PostgresError } from "postgres";
import { scheduledReversals, type ScheduledReversal } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { JournalEntriesService } from "../journal-entries/journal-entries.service";
import type { CreateScheduledReversalDto } from "./dto/create-scheduled-reversal.dto";
import type { CancelScheduledReversalDto } from "./dto/cancel-scheduled-reversal.dto";

/** Candidate batch size for one `processDue()` call — bounds a single
 * HTTP request's work (§10 of the Scheduled Reversal for Accruals and
 * Other Timing Adjustments — Final Implementation Specification,
 * Revision 2). There is no queue/worker infrastructure in this codebase
 * to page through the remainder automatically (§0.3/§10 — confirmed by
 * grep, nothing built here changes that); a caller with more than this
 * many due schedules calls `process-due` again. */
const CANDIDATE_BATCH_SIZE = 100;

export interface ListScheduledReversalsFilters {
  status?: "SCHEDULED" | "EXECUTED" | "FAILED" | "CANCELLED";
}

export interface ProcessDueResult {
  claimed: number;
  executed: number;
  failed: number;
  cancelled: number;
}

type ClaimOutcome = "executed" | "failed" | "cancelled" | "skipped";

/**
 * Scheduled Reversal for Accruals and Other Timing Adjustments — Final
 * Implementation Specification (Revision 2). Orchestrates
 * JournalEntriesService's existing, unmodified reversal logic on a
 * future date; this service never builds or posts a journal entry
 * itself — `completeReversalPosting()` is the only place that happens
 * anywhere in this codebase (journal-entries.service.ts doc comment).
 *
 * Lock order, on every path that touches more than one of these
 * resources in one transaction (§10/§11/§12, the CTO's Revision-2
 * concurrency correction):
 *   (1) scheduled_reversals row  ->  (2) original journal_entries row
 *       ->  (3) accounting_periods row.
 * `claimAndExecuteOne()` below is the only method that acquires all
 * three, and always in that order — (1) via its own `FOR UPDATE SKIP
 * LOCKED`, (2) via `JournalEntriesService.lockAndValidateOriginalForReversal()`,
 * (3) via `JournalEntriesService.resolvePeriodForDate()`. This matches
 * the manual `reverse()` path's own (original -> period) order exactly,
 * with the schedule row simply prepended as the first, schedule-specific
 * lock.
 */
@Injectable()
export class ScheduledReversalsService {
  constructor(private readonly journalEntries: JournalEntriesService) {}

  /**
   * §8/§13: creation-time validation deliberately reuses the exact same
   * original-entry precondition check (`lockAndValidateOriginalForReversal`)
   * the execution paths use — never a second, divergent rule set. Also
   * rejects up front if the target date already falls in a period that
   * is already CLOSED (an execution-time-only failure would otherwise be
   * entirely foreseeable at creation time); a NOT_FOUND period is not
   * rejected — periods are created ahead of need in this codebase's
   * "create, list, close only" model (accounting-periods.service.ts),
   * so a schedule may legitimately target a not-yet-created period.
   */
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateScheduledReversalDto,
  ): Promise<ScheduledReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.journalEntries.lockAndValidateOriginalForReversal(
        tx,
        tenantId,
        legalEntityId,
        dto.originalJournalEntryId,
      );

      const periodResolution = await this.journalEntries.resolvePeriodForDate(
        tx,
        tenantId,
        legalEntityId,
        dto.targetDate,
      );
      if (periodResolution.kind === "CLOSED") {
        throw new UnprocessableEntityException(
          `Accounting period "${periodResolution.period.code}" covering ${dto.targetDate} is closed.`,
        );
      }

      let created: ScheduledReversal;
      try {
        const [row] = await tx
          .insert(scheduledReversals)
          .values({
            tenantId,
            legalEntityId,
            originalJournalEntryId: dto.originalJournalEntryId,
            targetDate: dto.targetDate,
            createdBy: actorUserId ?? null,
          })
          .returning();
        created = row!;
      } catch (err) {
        // Closes the race the pre-checks above can't: two concurrent
        // create() calls for the same original entry both pass, both
        // attempt the insert, one commits, the loser lands here.
        // 23505 covers scheduled_reversals_one_active_per_original.
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            "This journal entry already has an active scheduled reversal. Cancel it before scheduling another.",
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "scheduled_reversal",
        entityId: created.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  /** §8/§14: cancels a still-SCHEDULED row. The terminal-immutability
   * trigger (024_scheduled_reversals_immutability_trigger.sql) permits
   * this — it only blocks mutation once a row is ALREADY terminal — and
   * separately rejects cancelling a row that has already resolved
   * (EXECUTED/FAILED/CANCELLED) with a friendly 409 before ever reaching
   * the trigger. */
  async cancel(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: CancelScheduledReversalDto,
  ): Promise<ScheduledReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [existing] = await tx
        .select()
        .from(scheduledReversals)
        .where(
          and(
            eq(scheduledReversals.id, id),
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) {
        throw new NotFoundException(
          `No scheduled reversal found with id ${id}.`,
        );
      }
      if (existing.status !== "SCHEDULED") {
        throw new ConflictException(
          `This scheduled reversal is already ${existing.status} and cannot be cancelled.`,
        );
      }

      const [updated] = await tx
        .update(scheduledReversals)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(scheduledReversals.id, id),
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CANCEL",
        entityType: "scheduled_reversal",
        entityId: id,
        beforeState: existing as unknown as Record<string, unknown>,
        afterState: {
          ...updated!,
          reason: dto.reason ?? null,
        } as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListScheduledReversalsFilters,
  ): Promise<ScheduledReversal[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(scheduledReversals.tenantId, tenantId),
        eq(scheduledReversals.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(scheduledReversals.status, filters.status));
      }
      return tx
        .select()
        .from(scheduledReversals)
        .where(and(...conditions))
        .orderBy(
          asc(scheduledReversals.targetDate),
          asc(scheduledReversals.id),
        );
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<ScheduledReversal> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [row] = await tx
        .select()
        .from(scheduledReversals)
        .where(
          and(
            eq(scheduledReversals.id, id),
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new NotFoundException(
          `No scheduled reversal found with id ${id}.`,
        );
      }
      return row;
    });
  }

  /**
   * §10/§11: candidate selection is a lock-free read in its own short
   * transaction (`withTenant()` always opens one — db.ts — but this one
   * takes no row locks and commits immediately). Each candidate is then
   * claimed and executed in a SEPARATE subsequent transaction
   * (`claimAndExecuteOne`), one at a time — never inside the selection
   * transaction, and never batched together, so one candidate's
   * work/locks can never block or extend another's.
   */
  async processDue(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    asOfDate?: string,
  ): Promise<ProcessDueResult> {
    const cutoff = asOfDate ?? new Date().toISOString().slice(0, 10);
    const result: ProcessDueResult = {
      claimed: 0,
      executed: 0,
      failed: 0,
      cancelled: 0,
    };

    const candidates = await withTenant(tenantId, (tx: TxClient) =>
      tx
        .select({ id: scheduledReversals.id })
        .from(scheduledReversals)
        .where(
          and(
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
            eq(scheduledReversals.status, "SCHEDULED"),
            lte(scheduledReversals.targetDate, cutoff),
          ),
        )
        .orderBy(asc(scheduledReversals.targetDate), asc(scheduledReversals.id))
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
   * The core algorithm (§10/§11/§12). Runs entirely inside ONE
   * transaction, in the required lock order:
   *   (1) scheduled_reversals row — `FOR UPDATE SKIP LOCKED`, so a
   *       concurrent claim of the SAME row (another `process-due` call
   *       racing this one) never blocks — it just skips.
   *   (2) original journal_entries row — via
   *       `lockAndValidateOriginalForReversal()`, IDENTICAL to what the
   *       manual `reverse()` path locks first. This is what makes the
   *       manual-reverse-vs-scheduled-process-due race deadlock-free:
   *       both paths lock the original journal entry before ever
   *       touching an accounting_periods row.
   *   (3) accounting_periods row — via `resolvePeriodForDate()`, only
   *       reached after (2) succeeds.
   *
   * Race outcome when a manual `reverse()` wins the original-entry lock
   * first: `lockAndValidateOriginalForReversal()` here throws
   * `ConflictException` ("already been reversed") once it observes the
   * manual path's commit — mapped below to CANCELLED, not FAILED, per
   * the Revision 2 race proof (this is the expected losing-path
   * outcome, not an error condition). When this path wins instead, the
   * manual path's own identical lock-and-validate call is the one that
   * will see `reversedByJournalEntryId` already set and throw the same
   * `ConflictException` back to that caller — exactly one reversal is
   * ever created, by whichever path's transaction commits first.
   */
  private async claimAndExecuteOne(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    scheduleId: string,
  ): Promise<ClaimOutcome> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const [claimed] = await tx
        .select()
        .from(scheduledReversals)
        .where(
          and(
            eq(scheduledReversals.id, scheduleId),
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);

      if (!claimed || claimed.status !== "SCHEDULED") {
        // Either a concurrent caller already holds/held this row
        // (SKIP LOCKED returned nothing), or it was already resolved
        // since candidate selection ran — either way, not this call's
        // problem; a no-op.
        return "skipped";
      }

      let original;
      try {
        original = await this.journalEntries.lockAndValidateOriginalForReversal(
          tx,
          tenantId,
          legalEntityId,
          claimed.originalJournalEntryId,
        );
      } catch (err) {
        if (err instanceof ConflictException) {
          await this.transitionToCancelled(
            tx,
            tenantId,
            legalEntityId,
            actorUserId,
            claimed,
            "The original journal entry was already reversed (by a manual reversal, or an earlier scheduled execution) before this schedule's target date was processed.",
          );
          return "cancelled";
        }
        // NotFoundException (original deleted — cannot happen via any
        // route in this codebase, defensive only) or
        // UnprocessableEntityException (no longer POSTED, or is itself
        // a reversal — also should not be reachable given the
        // immutability trigger, defensive only): a genuine execution
        // failure, not a benign race outcome.
        const message =
          err instanceof Error
            ? err.message
            : "Unable to reverse the original journal entry.";
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

      const resolution = await this.journalEntries.resolvePeriodForDate(
        tx,
        tenantId,
        legalEntityId,
        claimed.targetDate,
      );

      if (resolution.kind === "NOT_FOUND") {
        // No period covers the target date yet. Accounting periods in
        // this codebase are "create, list, close only" — one may still
        // be created later. Stays SCHEDULED; retried on a future
        // process-due call. Not a failure.
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

      // OPEN — complete the reversal exactly as the manual path does.
      const reversal = await this.journalEntries.completeReversalPosting(
        tx,
        tenantId,
        legalEntityId,
        actorUserId,
        original,
        resolution.period,
        claimed.targetDate,
        `Scheduled reversal of ${original.journalNumber}`,
      );

      const [executedRow] = await tx
        .update(scheduledReversals)
        .set({
          status: "EXECUTED",
          resultingReversalJournalEntryId: reversal.id,
          executedAt: new Date(),
          executedBy: actorUserId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scheduledReversals.id, claimed.id),
            eq(scheduledReversals.tenantId, tenantId),
            eq(scheduledReversals.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "EXECUTE",
        entityType: "scheduled_reversal",
        entityId: claimed.id,
        beforeState: claimed as unknown as Record<string, unknown>,
        afterState: executedRow as unknown as Record<string, unknown>,
      });

      return "executed";
    });
  }

  private async transitionToFailed(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    claimed: ScheduledReversal,
    failureReason: string,
  ): Promise<void> {
    const [failedRow] = await tx
      .update(scheduledReversals)
      .set({
        status: "FAILED",
        failureReason,
        executedAt: new Date(),
        executedBy: actorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduledReversals.id, claimed.id),
          eq(scheduledReversals.tenantId, tenantId),
          eq(scheduledReversals.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId,
      legalEntityId,
      actorUserId: actorUserId ?? undefined,
      action: "FAIL",
      entityType: "scheduled_reversal",
      entityId: claimed.id,
      beforeState: claimed as unknown as Record<string, unknown>,
      afterState: failedRow as unknown as Record<string, unknown>,
    });
  }

  private async transitionToCancelled(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    claimed: ScheduledReversal,
    reason: string,
  ): Promise<void> {
    const [cancelledRow] = await tx
      .update(scheduledReversals)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(
        and(
          eq(scheduledReversals.id, claimed.id),
          eq(scheduledReversals.tenantId, tenantId),
          eq(scheduledReversals.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    await tx.insert(auditLogs).values({
      tenantId,
      legalEntityId,
      actorUserId: actorUserId ?? undefined,
      action: "CANCEL",
      entityType: "scheduled_reversal",
      entityId: claimed.id,
      beforeState: claimed as unknown as Record<string, unknown>,
      afterState: {
        ...cancelledRow!,
        reason,
      } as unknown as Record<string, unknown>,
    });
  }
}
