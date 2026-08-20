import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
} from "@noryx/db-core";
import {
  chartOfAccounts,
  journalEntries,
  journalLines,
  type JournalEntry,
  type JournalLine,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateJournalEntryDto } from "./dto/create-journal-entry.dto";
import type { CreateJournalLineDto } from "./dto/create-journal-line.dto";
import type { UpdateJournalEntryDto } from "./dto/update-journal-entry.dto";

export type JournalEntryWithLines = JournalEntry & { lines: JournalLine[] };

export interface ListJournalEntriesFilters {
  status?: "DRAFT" | "POSTED";
  periodId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Journal entries — 2c-1 scope only: draft CRUD (create, list, get,
 * edit, delete). No posting, no numbering, no reversal — those are 2c-2,
 * a separate, not-yet-approved increment
 * (docs/finance-2c-journal-entry-service-proposal.md §0.1/§12).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as
 * AccountsService throughout. Account validation (existence, active,
 * same tenant+entity) runs at create AND edit time here — stricter than
 * the original proposal's posting-only minimum, per §4.1's approved
 * decision; posting (2c-2, not implemented) re-validates independently
 * and must never trust this increment's draft-time state.
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
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
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
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
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
   * scoped by the journal entry's own tenantId/legalEntityId. */
  private async validateLinesOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateJournalLineDto[],
  ): Promise<void> {
    if (lines.length === 0) return;

    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const validAccounts = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
          inArray(chartOfAccounts.id, accountIds),
        ),
      );
    const validIds = new Set(validAccounts.map((a) => a.id));
    const invalid = accountIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      // Deliberately does not distinguish "doesn't exist" from "exists in
      // a different tenant/entity" from "inactive" — §7.4's information
      // disclosure convention.
      throw new BadRequestException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  private async insertLines(
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
        })),
      )
      .returning();
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking an entry belonging to a different legal entity
   * within the same tenant, same convention as AccountsService. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<JournalEntryWithLines | undefined> {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, id),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (!entry) return undefined;

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, id))
      .orderBy(asc(journalLines.lineNumber));

    return { ...entry, lines };
  }
}
