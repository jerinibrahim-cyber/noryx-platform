import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, auditLogs, eq, gte, lte } from "@noryx/db-core";
import { PostgresError } from "postgres";
import { accountingPeriods, type AccountingPeriod } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateAccountingPeriodDto } from "./dto/create-accounting-period.dto";

/**
 * Accounting periods — 2c-1 (create, list, close only; no reopen, per
 * the approved proposal). Create/close are `finance.admin` only; list
 * is open to any finance.* role (§3/§9 of the proposal — the RBAC table
 * in the controller's own doc comment is the source of truth for the
 * exact per-route breakdown). Same withTenant()/explicit-legalEntityId-
 * predicate shape as AccountsService — see that file's doc comment for
 * why the legalEntityId predicate is never dropped even though RLS
 * alone would still stop cross-tenant leakage.
 *
 * docs/finance-2c-journal-entry-service-proposal.md §3.
 */
@Injectable()
export class AccountingPeriodsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateAccountingPeriodDto,
  ): Promise<AccountingPeriod> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Friendly pre-check — better error message when there's no race.
      // The real guarantee is the EXCLUDE USING gist constraint from 2b;
      // the catch block below is what closes the race this pre-check
      // can't (§3 of the 2c proposal, correction #2).
      const overlapping = await tx
        .select()
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.tenantId, tenantId),
            eq(accountingPeriods.legalEntityId, legalEntityId),
            lte(accountingPeriods.startDate, dto.endDate),
            gte(accountingPeriods.endDate, dto.startDate),
          ),
        )
        .limit(1);
      if (overlapping.length > 0) {
        throw new ConflictException(
          `This period's date range overlaps existing period "${overlapping[0]!.code}" for this legal entity.`,
        );
      }

      let created: AccountingPeriod;
      try {
        const [row] = await tx
          .insert(accountingPeriods)
          .values({
            tenantId,
            legalEntityId,
            code: dto.code,
            startDate: dto.startDate,
            endDate: dto.endDate,
          })
          .returning();
        created = row!;
      } catch (err) {
        // Closes the race the pre-check above can't: two concurrent
        // create() calls both pass the pre-check (neither sees the
        // other's not-yet-committed row), both attempt the insert, one
        // commits, and the loser lands here. No raw Postgres error may
        // escape the API (2c proposal §3, correction #2) — 23P01 is the
        // EXCLUDE USING gist overlap constraint, 23505 is the
        // (tenant, entity, code) UNIQUE constraint.
        if (
          err instanceof PostgresError &&
          (err.code === "23P01" || err.code === "23505")
        ) {
          throw new ConflictException(
            "This period's date range or code conflicts with an existing period for this legal entity.",
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "accounting_period",
        entityId: created.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
  ): Promise<AccountingPeriod[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      return tx
        .select()
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.tenantId, tenantId),
            eq(accountingPeriods.legalEntityId, legalEntityId),
          ),
        );
    });
  }

  async close(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<AccountingPeriod> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Atomic conditional transition — corrected per review: the
      // previous read-then-write shape (SELECT, check status === OPEN,
      // then UPDATE with no status predicate) raced. Two concurrent
      // close() calls could both read OPEN before either UPDATE
      // committed, and since the UPDATE's WHERE clause didn't repeat the
      // status check, both would succeed — silently violating "already
      // CLOSED -> 409" under concurrency. status = 'OPEN' is now part of
      // the UPDATE's own WHERE clause, so only the first of two
      // concurrent requests for the same row can ever match; the loser
      // matches zero rows and is handled below via a follow-up read —
      // never a second silent "success." Same class of fix as the
      // SELECT ... FOR UPDATE correction documented for 2c-2 posting
      // (docs/finance-2c-journal-entry-service-proposal.md §5.1) — here
      // the single atomic UPDATE...WHERE is sufficient on its own since
      // there's no multi-statement validation chain to protect, unlike
      // posting.
      const [updated] = await tx
        .update(accountingPeriods)
        .set({
          status: "CLOSED",
          closedAt: new Date(),
          closedBy: actorUserId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(accountingPeriods.id, id),
            eq(accountingPeriods.tenantId, tenantId),
            eq(accountingPeriods.legalEntityId, legalEntityId),
            eq(accountingPeriods.status, "OPEN"),
          ),
        )
        .returning();

      if (!updated) {
        // Zero rows matched: either the period doesn't exist in this
        // scope at all (404), or it exists but wasn't OPEN (409) —
        // distinguished by a follow-up read taken AFTER the UPDATE
        // attempt, never by trusting a read that happened before it
        // (that read-before-write gap is exactly the race being fixed).
        const existing = await this.findByIdInTx(tx, legalEntityId, id);
        if (!existing) {
          throw new NotFoundException(
            `No accounting period found with id ${id}.`,
          );
        }
        throw new ConflictException(
          `Accounting period "${existing.code}" is already closed.`,
        );
      }

      // Reconstructed rather than re-read, to avoid a second query on
      // the success path — accurate for every field this action
      // actually changes (status, closedAt, closedBy), which is what
      // the audit trail is for. updatedAt is reused from the
      // post-close row rather than the true pre-close value: a
      // deliberate, harmless imprecision on a non-business timestamp,
      // not a gap in the business-relevant before/after snapshot.
      const before: AccountingPeriod = {
        ...updated,
        status: "OPEN",
        closedAt: null,
        closedBy: null,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CLOSE",
        entityType: "accounting_period",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated;
    });
  }

  /** Same reasoning as AccountsService.findByIdInTx — RLS already
   * restricts to the caller's tenant, but a direct-by-id lookup must not
   * leak a period belonging to a different legal entity within the same
   * tenant, so that predicate is applied explicitly here too. */
  private async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<AccountingPeriod | undefined> {
    const rows = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.id, id),
          eq(accountingPeriods.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    return rows[0];
  }
}
