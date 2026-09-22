import {
  BadRequestException,
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
  gte,
  inArray,
  legalEntities,
  lte,
  sql,
} from "@noryx/db-core";
import {
  accountingPeriods,
  chartOfAccounts,
  journalEntries,
  journalLines,
  taxCodes,
  type AccountingPeriod,
  type JournalEntry,
  type JournalLine,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateJournalEntryDto } from "./dto/create-journal-entry.dto";
import type { CreateJournalLineDto } from "./dto/create-journal-line.dto";
import type { UpdateJournalEntryDto } from "./dto/update-journal-entry.dto";
import type { ReverseJournalEntryDto } from "./dto/reverse-journal-entry.dto";

export type JournalEntryWithLines = JournalEntry & { lines: JournalLine[] };

/** Non-throwing period-resolution result — the basis both
 * `resolveAndLockOpenPeriod()` (manual reverse()/post(), throws) and
 * `ScheduledReversalsService` (branches on `.kind` without throwing,
 * per the Scheduled Reversal spec §12) are built on. Introduced by the
 * Scheduled Reversal for Accruals and Other Timing Adjustments work
 * item — Final Implementation Specification (Revision 2), §12. */
export type PeriodResolution =
  | { kind: "OPEN"; period: AccountingPeriod }
  | { kind: "CLOSED"; period: AccountingPeriod }
  | { kind: "NOT_FOUND" };

export interface ListJournalEntriesFilters {
  status?: "DRAFT" | "POSTED";
  periodId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Journal entries — 2c-1 (draft CRUD) + 2c-2 (posting, numbering,
 * reversal), per docs/finance-2c-journal-entry-service-proposal.md §0.3,
 * §5, §6.
 *
 * Every mutating operation on a `journal_entries` row — `update()`,
 * `remove()`, `post()`, `reverse()` — acquires `SELECT ... FOR UPDATE` on
 * that row as its FIRST statement, via `findByIdInTx(..., { forUpdate:
 * true })`. This is what makes draft-mutation-vs-posting races (§0.3
 * item B) and concurrent-posting/concurrent-reversal races (§5.1, §6)
 * serialize cleanly instead of interleaving: whichever transaction
 * acquires the lock first runs to completion (commit or rollback)
 * before the second transaction's lock wait ends and it re-reads the
 * row's now-current state. Nothing here ever acts on a status value
 * read before acquiring this lock.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as
 * AccountsService throughout. Account validation (existence, active,
 * same tenant+entity) runs at create/edit time (2c-1) AND is
 * independently re-verified at posting time (2c-2, §5 step 6, §7.1) —
 * the latter never trusts the former, since an account can be archived
 * between draft creation and posting.
 */
@Injectable()
export class JournalEntriesService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateJournalEntryDto,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );
      const lines = dto.lines ?? [];
      await this.validateLinesOrThrow(tx, tenantId, legalEntityId, lines);

      const [createdEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: dto.transactionDate,
          currencyCode,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedLines = await this.insertLines(
        tx,
        tenantId,
        createdEntry!.id,
        lines,
      );

      const full: JournalEntryWithLines = {
        ...createdEntry!,
        lines: insertedLines,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "journal_entry",
        entityId: createdEntry!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListJournalEntriesFilters,
  ): Promise<JournalEntry[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(journalEntries.status, filters.status));
      }
      if (filters.periodId) {
        conditions.push(eq(journalEntries.periodId, filters.periodId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(journalEntries.transactionDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(journalEntries.transactionDate, filters.dateTo));
      }
      return tx
        .select()
        .from(journalEntries)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No journal entry found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateJournalEntryDto,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // §0.3 item B: lock first, before any status check — so a
      // concurrent post() cannot interleave with this edit.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No journal entry found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted journal entry.");
      }

      if (dto.lines) {
        await this.validateLinesOrThrow(tx, tenantId, legalEntityId, dto.lines);
      }

      const headerPatch: Partial<typeof journalEntries.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.transactionDate !== undefined) {
        headerPatch.transactionDate = dto.transactionDate;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      await tx
        .update(journalEntries)
        .set(headerPatch)
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.tenantId, tenantId),
            eq(journalEntries.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        // Full-array replacement, not line-level add/remove — §4.3's
        // approved decision. Fresh 1..N numbering, independent of
        // whatever numbering the replaced lines had.
        await tx
          .delete(journalLines)
          .where(eq(journalLines.journalEntryId, id));
        await this.insertLines(tx, tenantId, id, dto.lines);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "journal_entry",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: after as unknown as Record<string, unknown>,
      });

      return after!;
    });
  }

  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // §0.3 item B: lock first, before any status check — so a
      // concurrent post() cannot interleave with this delete.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No journal entry found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted journal entry.");
      }

      // journal_lines rows cascade via the existing FK's onDelete: "cascade".
      await tx
        .delete(journalEntries)
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.tenantId, tenantId),
            eq(journalEntries.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "journal_entry",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /journal-entries/:id/post` — DRAFT -> POSTED. Proposal §5,
   * with the §0.3 item C period-lock correction applied at step 7.
   * Validation order matches §5 exactly: lock, status, line count,
   * balance, account re-validation, period resolution+lock, number
   * allocation, commit, audit. A failure at any step rolls the whole
   * transaction back — no burned journal number from a failed post,
   * since allocation (step 8) only runs after every earlier check has
   * already passed.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 2: load + lock + scope — the very first statement (§5.1).
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No journal entry found with id ${id}.`);
      }

      // Step 3: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This journal entry is already posted.");
      }

      // Step 4: >= 2 lines.
      if (before.lines.length < 2) {
        throw new UnprocessableEntityException(
          "A journal entry must have at least 2 lines to be posted.",
        );
      }

      // Step 5: debits === credits, computed from the already-loaded
      // lines. The DB's deferred balance trigger (2b) is the backstop
      // that fires regardless of whether this check is ever bypassed.
      const totalDebit = before.lines.reduce((sum, l) => sum + l.debitMinor, 0);
      const totalCredit = before.lines.reduce(
        (sum, l) => sum + l.creditMinor,
        0,
      );
      if (totalDebit !== totalCredit) {
        throw new UnprocessableEntityException(
          `Journal entry is unbalanced: total debits (${totalDebit}) do not equal total credits (${totalCredit}).`,
        );
      }

      // Step 6: re-validate every line's account, independently of
      // whatever passed at create/edit time (§5 step 6, §7.1, §7.5's
      // 2c-2 list) — an account can be archived, or reference a
      // different tenant/entity, between draft creation and posting.
      await this.revalidateLinesForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.lines,
      );

      // Step 7: resolve + lock the covering OPEN period (§0.3 item C).
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.transactionDate,
      );

      // Step 8: atomic journal number allocation.
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 9: commit the transition — deliberately not touching
      // updated_at or any other column.
      const [posted] = await tx
        .update(journalEntries)
        .set({
          status: "POSTED",
          journalNumber,
          periodId: period.id,
          postedAt: new Date(),
          postedBy: actorUserId ?? null,
        })
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.tenantId, tenantId),
            eq(journalEntries.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      const after: JournalEntryWithLines = {
        ...posted!,
        lines: before.lines,
      };

      // Step 10: audit.
      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "POST",
        entityType: "journal_entry",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: after as unknown as Record<string, unknown>,
      });

      return after;
    });
  }

  /**
   * `POST /journal-entries/:id/reverse` — creates and posts a new
   * journal entry that reverses `id`, and links the original to it.
   * Proposal §6, with the §0.3 item C period-lock correction applied at
   * step 5. Public behavior, inputs, outputs, errors, and atomicity are
   * byte-for-byte unchanged by the Scheduled Reversal work item's
   * extraction below — this method is now a two-line wrapper around
   * `reverseInTx()`, still opening its own transaction exactly as before.
   */
  async reverse(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: ReverseJournalEntryDto,
  ): Promise<JournalEntryWithLines> {
    return withTenant(tenantId, (tx: TxClient) =>
      this.reverseInTx(tx, tenantId, legalEntityId, actorUserId, id, dto),
    );
  }

  /**
   * The body of `reverse()`, extracted to accept an already-open `tx`
   * instead of opening its own — introduced by the Scheduled Reversal
   * for Accruals and Other Timing Adjustments work item (Final
   * Implementation Specification, Revision 2, §12) so that a scheduled
   * execution's own `SCHEDULED -> EXECUTED` transition and the reversal
   * journal entry's creation can commit atomically together, in one
   * transaction, rather than two. Composes the same three phases in the
   * same order `reverse()` always used — original-lock-and-validate,
   * then period-resolve-and-lock, then build/post/link/audit — so this
   * is a decomposition of the existing logic, not a rewrite of it.
   */
  private async reverseInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: ReverseJournalEntryDto,
  ): Promise<JournalEntryWithLines> {
    // Steps 1-4: load + lock + scope + validate the ORIGINAL.
    const original = await this.lockAndValidateOriginalForReversal(
      tx,
      tenantId,
      legalEntityId,
      id,
    );

    const transactionDate =
      dto.transactionDate ?? new Date().toISOString().slice(0, 10);
    const memo = dto.memo ?? `Reversal of ${original.journalNumber}`;

    // Step 5: resolve + lock the reversal's OWN covering OPEN period
    // (§0.3 item C) — independent of the original's period/status.
    const period = await this.resolveAndLockOpenPeriod(
      tx,
      tenantId,
      legalEntityId,
      transactionDate,
    );

    // Steps 6-12: build lines, insert, number, post, link, audit.
    return this.completeReversalPosting(
      tx,
      tenantId,
      legalEntityId,
      actorUserId,
      original,
      period,
      transactionDate,
      memo,
    );
  }

  /**
   * Steps 1-4 of the original `reverse()`, extracted for reuse — locks
   * and validates the entry to be reversed: exists, POSTED, not already
   * reversed, not itself a reversal. The only mechanism that satisfies
   * "reversal target must be same tenant/entity" (§6.3/§7.3 of the 2c
   * proposal) — there is no separate target-tenant/entity input.
   *
   * Intentionally not `private`: `ScheduledReversalsService` calls this
   * directly, as the FIRST step after claiming its own schedule row, so
   * that the original-journal-entry lock is always acquired before any
   * accounting-period lock on both the manual and scheduled paths alike
   * — the lock-ordering requirement behind the Scheduled Reversal spec's
   * Revision 2 concurrency correction (§10, §11, §12). Not exposed via
   * any HTTP route; only reachable by another service in this module.
   */
  async lockAndValidateOriginalForReversal(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<JournalEntryWithLines> {
    const original = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
      forUpdate: true,
    });
    if (!original) {
      throw new NotFoundException(`No journal entry found with id ${id}.`);
    }
    if (original.status !== "POSTED") {
      throw new UnprocessableEntityException(
        "Only a posted entry can be reversed.",
      );
    }
    if (original.reversedByJournalEntryId !== null) {
      throw new ConflictException("This entry has already been reversed.");
    }
    if (original.reversalOfJournalEntryId !== null) {
      throw new UnprocessableEntityException(
        "Cannot reverse a reversal; reversal-of-reversal requires a dedicated correction workflow, not yet built.",
      );
    }
    return original;
  }

  /**
   * Steps 6-12 of the original `reverse()`, extracted for reuse: build
   * the swapped-account reversal lines, insert and post the reversal
   * entry, link the original (exactly one column — the posted-
   * immutability trigger enforces this narrowly, drizzle/constraints/
   * 003_...), and write the three audit rows. Takes an already-locked
   * `original` and an already-resolved-OPEN `period` — never resolves
   * either itself, so it can never be called out of the required lock
   * order.
   *
   * Intentionally not `private` — called by `reverseInTx()` (manual
   * path) and by `ScheduledReversalsService` (scheduled path, only once
   * its own period resolution has confirmed OPEN) alike. This is the
   * ONLY place a reversal is ever built or posted anywhere in this
   * codebase — never duplicated, never a second posting engine.
   */
  async completeReversalPosting(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    original: JournalEntryWithLines,
    period: AccountingPeriod,
    transactionDate: string,
    memo: string,
  ): Promise<JournalEntryWithLines> {
    // Step 6: build reversal lines — same accounts/amounts, swapped
    // debit/credit, fresh 1..N numbering independent of the original's.
    // Tax/VAT Phase 6 (CTO authorization §8.6) — a tax-classified
    // line's taxCodeId/taxDirection is carried onto its reversal
    // unchanged (same code, same direction — NOT swapped, unlike
    // debit/credit). Combined with the VAT report's signed-contribution
    // formula (creditMinor - debitMinor for OUTPUT, debitMinor -
    // creditMinor for INPUT), a reversal's swapped debit/credit under
    // the same code+direction always nets its original's contribution
    // to exactly zero — no separate "exclude reversed" filter is needed
    // or used for manual-journal tax (contrast tax-reports.service.ts's
    // AP/AR queries, which do need one).
    const reversalLineInputs: CreateJournalLineDto[] = original.lines.map(
      (l) => ({
        accountId: l.accountId,
        debitMinor: l.creditMinor,
        creditMinor: l.debitMinor,
        description: l.description ?? undefined,
        taxCodeId: l.taxCodeId ?? undefined,
        taxDirection: l.taxDirection ?? undefined,
      }),
    );

    // Step 7: insert the reversal's header.
    const [reversalEntry] = await tx
      .insert(journalEntries)
      .values({
        tenantId,
        legalEntityId,
        transactionDate,
        currencyCode: original.currencyCode,
        memo,
        reversalOfJournalEntryId: original.id,
        createdBy: actorUserId ?? null,
      })
      .returning();

    // Step 8: insert reversal lines.
    const reversalLines = await this.insertLines(
      tx,
      tenantId,
      reversalEntry!.id,
      reversalLineInputs,
    );

    // Step 9: allocate the reversal's own journal number — a fresh
    // draw from the same counter, never derived from the original's.
    const journalNumber = await this.allocateJournalNumber(
      tx,
      tenantId,
      legalEntityId,
    );

    // Step 10: post the reversal.
    const [postedReversal] = await tx
      .update(journalEntries)
      .set({
        status: "POSTED",
        journalNumber,
        periodId: period.id,
        postedAt: new Date(),
        postedBy: actorUserId ?? null,
      })
      .where(
        and(
          eq(journalEntries.id, reversalEntry!.id),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    // Step 11: link the original — exactly one column, nothing else.
    // The posted-immutability trigger enforces this narrowly (schema.ts
    // doc comment, drizzle/constraints/003_...); any attempt to also
    // touch updated_at or any other column here would be rejected by
    // the trigger, which is the intended enforcement.
    const [linkedOriginal] = await tx
      .update(journalEntries)
      .set({ reversedByJournalEntryId: postedReversal!.id })
      .where(
        and(
          eq(journalEntries.id, original.id),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    const reversalFull: JournalEntryWithLines = {
      ...postedReversal!,
      lines: reversalLines,
    };

    // Step 12: audit — REVERSE against the original (the linkage
    // event), plus the reversal's own CREATE and POST rows, all in
    // the same transaction (§9, §6 step 12).
    await tx.insert(auditLogs).values([
      {
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "REVERSE",
        entityType: "journal_entry",
        entityId: original.id,
        beforeState: original as unknown as Record<string, unknown>,
        afterState: linkedOriginal as unknown as Record<string, unknown>,
      },
      {
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "journal_entry",
        entityId: reversalEntry!.id,
        beforeState: null,
        afterState: {
          ...reversalEntry!,
          lines: reversalLines,
        } as unknown as Record<string, unknown>,
      },
      {
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "POST",
        entityType: "journal_entry",
        entityId: reversalEntry!.id,
        beforeState: null,
        afterState: reversalFull as unknown as Record<string, unknown>,
      },
    ]);

    return reversalFull;
  }

  /**
   * `JournalEntriesService.postSystemGeneratedEntry()` — Generic
   * Deferral Recognition Engine, Phase 2 Implementation Contract
   * (docs/work-items/deferral-recognition-engine/CONTRACT.md §5),
   * CTO-authorized additive generalization. Composed ONLY from
   * `insertLines()` and `allocateJournalNumber()` — the exact same two
   * primitives `completeReversalPosting()` itself already uses — so
   * this is the SECOND caller of each, not a third posting engine.
   * Zero changes to `completeReversalPosting()`, `reverse()`,
   * `reverseInTx()`, `post()`, `create()`,
   * `lockAndValidateOriginalForReversal()`, `resolvePeriodForDate()`,
   * `resolveAndLockOpenPeriod()`, or the bodies of `insertLines()`/
   * `allocateJournalNumber()` themselves — only their visibility
   * changed (private -> package-internal), the same visibility change
   * already precedented by how `lockAndValidateOriginalForReversal`/
   * `completeReversalPosting` were made non-`private` specifically for
   * `ScheduledReversalsService` to call.
   *
   * The caller (`DeferralRecognitionService`) is responsible for
   * everything this method deliberately does NOT do, exactly as
   * `ScheduledReversalsService.claimAndExecuteOne()` is responsible for
   * locking its own `scheduled_reversals` row before ever calling
   * `lockAndValidateOriginalForReversal()`:
   *   - re-validating both accounts (exists, active, same tenant/
   *     legal entity) immediately before calling this — this method
   *     never queries `chart_of_accounts` itself, matching this
   *     codebase's convention of each caller doing its own trivial
   *     single-table account check (see AccountsService,
   *     BankTransactionsService, BudgetLinesService, TaxCodesService —
   *     none of them route a trivial chart-of-accounts existence/
   *     active check through JournalEntriesService either);
   *   - resolving and locking `period` via `resolvePeriodForDate()`
   *     (this method takes an already-OPEN period, never resolves one
   *     itself, so it can never be called out of the caller's own
   *     required lock order — identical discipline to
   *     `completeReversalPosting()`'s own `period` parameter);
   *   - building `lines` such that they are exactly 2, balanced
   *     (`debitMinor` sum === `creditMinor` sum), and reference only
   *     accounts already re-validated above — this method inserts
   *     whatever it is given via the same `insertLines()` every other
   *     caller uses, and relies on the same structural-by-construction
   *     guarantee `post()`'s own docstring notes, backstopped
   *     regardless by the existing, untouched
   *     `002_balance_invariant_trigger.sql` deferred constraint
   *     trigger on every row in `journal_lines`;
   *   - opening the transaction (`tx` is always the caller's own,
   *     already-open transaction — this method never calls
   *     `withTenant()` itself, so the header insert, line insert,
   *     number allocation, POSTED transition, and the caller's own
   *     domain-specific mutation/audit rows (e.g.
   *     `deferral_recognitions` SCHEDULED -> EXECUTED) all commit or
   *     roll back together, atomically, in one transaction — the same
   *     property `claimAndExecuteOne()` relies on for
   *     `completeReversalPosting()`).
   *
   * No `reversalOfJournalEntryId`/`reversedByJournalEntryId` linkage —
   * those columns stay `null`, this is not a reversal.
   */
  async postSystemGeneratedEntry(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    lines: CreateJournalLineDto[],
    period: AccountingPeriod,
    transactionDate: string,
    memo: string,
    currencyCode: string,
  ): Promise<JournalEntryWithLines> {
    // Step 1: insert the header. Starts DRAFT (the column default),
    // flips to POSTED in step 4 — the same two-phase shape create()+
    // post() always produce, just composed here in one transaction
    // since the caller has already resolved+locked the period and
    // re-validated the accounts.
    const [createdEntry] = await tx
      .insert(journalEntries)
      .values({
        tenantId,
        legalEntityId,
        transactionDate,
        currencyCode,
        memo,
        createdBy: actorUserId ?? null,
      })
      .returning();

    // Step 2: insertLines() — existing private method, reused verbatim.
    const insertedLines = await this.insertLines(
      tx,
      tenantId,
      createdEntry!.id,
      lines,
    );

    // Step 3: allocateJournalNumber() — existing private method, reused
    // verbatim, drawing from the exact same shared per-legal-entity
    // counter every other posting path (manual post(), manual/scheduled
    // reversal) already draws from — no separate numbering sequence.
    const journalNumber = await this.allocateJournalNumber(
      tx,
      tenantId,
      legalEntityId,
    );

    // Step 4: DRAFT -> POSTED.
    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: "POSTED",
        journalNumber,
        periodId: period.id,
        postedAt: new Date(),
        postedBy: actorUserId ?? null,
      })
      .where(
        and(
          eq(journalEntries.id, createdEntry!.id),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.legalEntityId, legalEntityId),
        ),
      )
      .returning();

    const full: JournalEntryWithLines = {
      ...posted!,
      lines: insertedLines,
    };

    // Step 5: audit — CREATE + POST, the identical two-row shape
    // completeReversalPosting() already writes for the entry it
    // creates (steps 12's second and third rows there), so every
    // system-generated entry gets the same audit shape regardless of
    // which caller created it.
    await tx.insert(auditLogs).values([
      {
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "journal_entry",
        entityId: createdEntry!.id,
        beforeState: null,
        afterState: {
          ...createdEntry!,
          lines: insertedLines,
        } as unknown as Record<string, unknown>,
      },
      {
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "POST",
        entityType: "journal_entry",
        entityId: createdEntry!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      },
    ]);

    return full;
  }

  /** Resolves the caller's legal entity's functional currency
   * (proposal §1.6) — never client-supplied. A missing row here means
   * the JWT's legalEntityId doesn't resolve to a real legal_entities row
   * for this tenant, which should never happen for a well-formed token;
   * treated as 404 rather than a raw 500 to stay consistent with this
   * codebase's "resource not found in scope" convention. */
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

  /** Every line's accountId must resolve to an existing, active
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — the 2b->2c cross-entity/cross-tenant handoff this increment is
   * responsible for at create/edit time (§4.1, §7.1, §7.5's 2c-1 list).
   * Never trusts the account's own claimed tenant/entity fields — always
   * scoped by the journal entry's own tenantId/legalEntityId. 400: this
   * is request-shape validation on caller-supplied input (§8's
   * status-code table). See revalidateLinesForPostingOrThrow for the
   * 422 posting-time counterpart. */
  private async validateLinesOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateJournalLineDto[],
  ): Promise<void> {
    if (lines.length === 0) return;

    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      lines.map((l) => l.accountId),
    );
    if (invalid.length > 0) {
      // Deliberately does not distinguish "doesn't exist" from "exists in
      // a different tenant/entity" from "inactive" — §7.4's information
      // disclosure convention.
      throw new BadRequestException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }

    // Tax/VAT Phase 6 — draft-time validation of every explicitly
    // tax-classified line's tax code (CTO authorization §8.4). The DTO's
    // TaxCodeDirectionPairingConstraint already guarantees taxCodeId and
    // taxDirection are both-or-neither by the time we get here; only the
    // referenced code's existence/activation/scope remains to check.
    const taxCodeIds = lines
      .map((l) => l.taxCodeId)
      .filter((id): id is string => id !== undefined && id !== null);
    if (taxCodeIds.length > 0) {
      const invalidTaxCodes = await this.findInvalidTaxCodeIds(
        tx,
        legalEntityId,
        taxCodeIds,
      );
      if (invalidTaxCodes.length > 0) {
        throw new BadRequestException(
          `The following tax code id(s) are not active tax codes in this legal entity: ${invalidTaxCodes.join(", ")}.`,
        );
      }
    }
  }

  /** Posting-time re-validation of every line's account — independent
   * of whatever passed at draft create/edit time (§5 step 6, §7.1). An
   * account can be archived, or in principle a line corrupted by a bug
   * elsewhere, between draft creation and posting — this never trusts
   * that earlier check. 422, not 400: this is a business-rule/invariant
   * failure at posting time, not a request-shape validation failure
   * (§8's status-code table). Same information-disclosure convention as
   * create/edit time (§7.4). */
  private async revalidateLinesForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: JournalLine[],
  ): Promise<void> {
    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      lines.map((l) => l.accountId),
    );
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }

    // Tax/VAT Phase 6 — post-time re-validation of every tax-classified
    // line's tax code, independent of whatever passed at draft
    // create/edit time (CTO authorization §8.4, mirroring the account
    // re-validation immediately above): a tax code can be deactivated
    // between draft creation and posting. 422, not 400 — same
    // business-rule-at-posting-time convention as the account check.
    const taxCodeIds = lines
      .map((l) => l.taxCodeId)
      .filter((id): id is string => id !== null);
    if (taxCodeIds.length > 0) {
      const invalidTaxCodes = await this.findInvalidTaxCodeIds(
        tx,
        legalEntityId,
        taxCodeIds,
      );
      if (invalidTaxCodes.length > 0) {
        throw new UnprocessableEntityException(
          `The following tax code id(s) are not active tax codes in this legal entity: ${invalidTaxCodes.join(", ")}.`,
        );
      }
    }
  }

  private async findInvalidAccountIds(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountIds: string[],
  ): Promise<string[]> {
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
    return uniqueIds.filter((id) => !validIds.has(id));
  }

  /** Tax/VAT Phase 6 — deliberately a local, trivial, single-table
   * lookup (tax_codes: exists in this legal entity, isActive) rather
   * than an injected TaxCodesService, unlike AP/AR's tax wiring — this
   * codebase's "usual convention" for a trivial single-table check
   * (same shape as findInvalidAccountIds above, resolveCurrency,
   * allocateJournalNumber), explicitly contrasted in
   * SupplierBillsModule's own doc comment against the "non-trivial,
   * evolving business logic" case that justifies DI there (rate
   * resolution/calculation — CTO authorization §8.2 explicitly rules
   * that out for this work item, so there is no non-trivial logic to
   * inject a service for). Also avoids adding a first-ever constructor
   * dependency to JournalEntriesService, which every other AP/AR/
   * ScheduledReversals module already registers as a bare second
   * provider on the explicit assumption ("Safe for the identical
   * reason: JournalEntriesService has no constructor-injected
   * dependencies of its own" — SupplierBillsModule's own doc comment)
   * that it has none — introducing one would require touching seven
   * further, functionally unrelated modules (supplier-payments,
   * customer-receipts, customer-credit-notes, scheduled-reversals,
   * etc.) purely for DI wiring. Queries the exact same `tax_codes`
   * table TaxCodesService.findByIdInTx() itself queries — not a second
   * tax-code authority, just a second call site for the same one. */
  private async findInvalidTaxCodeIds(
    tx: TxClient,
    legalEntityId: string,
    taxCodeIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(taxCodeIds)];
    const validCodes = await tx
      .select({ id: taxCodes.id })
      .from(taxCodes)
      .where(
        and(
          eq(taxCodes.legalEntityId, legalEntityId),
          eq(taxCodes.isActive, true),
          inArray(taxCodes.id, uniqueIds),
        ),
      );
    const validIds = new Set(validCodes.map((c) => c.id));
    return uniqueIds.filter((id) => !validIds.has(id));
  }

  /** Resolves the accounting period covering `transactionDate` for
   * (tenantId, legalEntityId), and locks that row via
   * `SELECT ... FOR UPDATE` — a non-throwing, discriminated result
   * (§12 of the Scheduled Reversal spec, Revision 2) rather than an
   * exception, so a caller can branch on "closed" vs. "not found"
   * without try/catch. Whichever period covers the date is locked
   * regardless of its current status, so both outcomes can still be
   * reported precisely, and a concurrent `AccountingPeriodsService.
   * close()` attempt blocks on this row until the current transaction
   * commits or rolls back rather than racing it.
   *
   * Intentionally not `private` — `ScheduledReversalsService` calls
   * this directly, as the SECOND step after locking the original
   * journal entry (never before it — the Revision 2 lock-ordering
   * requirement), to decide FAILED/leave-SCHEDULED/proceed without an
   * exception-driven control flow. `resolveAndLockOpenPeriod()` below
   * is now a thin, throwing wrapper over this for post()/reverse()'s
   * unchanged behavior. */
  async resolvePeriodForDate(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    transactionDate: string,
  ): Promise<PeriodResolution> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, transactionDate),
          gte(accountingPeriods.endDate, transactionDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      return { kind: "NOT_FOUND" };
    }
    if (period.status !== "OPEN") {
      return { kind: "CLOSED", period };
    }
    return { kind: "OPEN", period };
  }

  /** Thin, throwing wrapper over `resolvePeriodForDate()`, preserving
   * `post()`/`reverse()`'s exact pre-existing behavior, error types,
   * and messages — used identically by both, unchanged by the
   * Scheduled Reversal work item in any way a caller could observe. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    transactionDate: string,
  ): Promise<AccountingPeriod> {
    const resolution = await this.resolvePeriodForDate(
      tx,
      tenantId,
      legalEntityId,
      transactionDate,
    );
    if (resolution.kind === "NOT_FOUND") {
      throw new UnprocessableEntityException(
        `No accounting period covers transaction date ${transactionDate} for this legal entity.`,
      );
    }
    if (resolution.kind === "CLOSED") {
      throw new UnprocessableEntityException(
        `Accounting period "${resolution.period.code}" covering ${transactionDate} is closed.`,
      );
    }
    return resolution.period;
  }

  /** Race-free journal-number allocation via the counter table's atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
   * (docs/finance-journal-engine-proposal.md §1.4) — never
   * `MAX(journal_number)+1`. Runs inside the same transaction as the
   * rest of posting/reversal, so a later failure in that same
   * transaction rolls the allocation back too; no burned numbers from a
   * failed post. Formatted `JE-{n:06d}`, scoped per legal entity.
   *
   * Intentionally not `private` — `postSystemGeneratedEntry()` above
   * reuses it verbatim (Deferral Recognition Engine, CONTRACT.md §5),
   * the same visibility change already precedented by
   * `lockAndValidateOriginalForReversal`/`completeReversalPosting`.
   * Body unchanged. */
  async allocateJournalNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO journal_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = journal_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `JE-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Intentionally not `private` — `postSystemGeneratedEntry()` above
   * reuses it verbatim (Deferral Recognition Engine, CONTRACT.md §5),
   * the same visibility change already precedented by
   * `lockAndValidateOriginalForReversal`/`completeReversalPosting`.
   * Body unchanged. */
  async insertLines(
    tx: TxClient,
    tenantId: string,
    journalEntryId: string,
    lines: CreateJournalLineDto[],
  ): Promise<JournalLine[]> {
    if (lines.length === 0) return [];
    return tx
      .insert(journalLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          journalEntryId,
          lineNumber: index + 1,
          accountId: line.accountId,
          debitMinor: line.debitMinor,
          creditMinor: line.creditMinor,
          description: line.description ?? null,
          // Tax/VAT Phase 6 — both null or both set, guaranteed by
          // TaxCodeDirectionPairingConstraint at the DTO layer and by
          // the two implication CHECK constraints at the DB layer.
          taxCodeId: line.taxCodeId ?? null,
          taxDirection: line.taxDirection ?? null,
        })),
      )
      .returning();
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking an entry belonging to a different legal entity
   * within the same tenant, same convention as AccountsService.
   *
   * `options.forUpdate` acquires `SELECT ... FOR UPDATE` on the header
   * row — used by every mutating operation (update/remove/post/reverse)
   * as their first statement (§0.3 item B, §5.1, §6). Plain reads
   * (findOne, and the "after" snapshot inside update()) never lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<JournalEntryWithLines | undefined> {
    const condition = and(
      eq(journalEntries.id, id),
      eq(journalEntries.tenantId, tenantId),
      eq(journalEntries.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(journalEntries)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(journalEntries).where(condition).limit(1);
    const entry = rows[0];
    if (!entry) return undefined;

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, id))
      .orderBy(asc(journalLines.lineNumber));

    return { ...entry, lines };
  }
}
