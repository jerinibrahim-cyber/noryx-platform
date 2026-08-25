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
  apSettings,
  chartOfAccounts,
  journalEntries,
  journalLines,
  suppliers,
  supplierBills,
  supplierBillLines,
  type AccountingPeriod,
  type ApSettings,
  type Supplier,
  type SupplierBill,
  type SupplierBillLine,
} from "../../db/schema";
import { withTenant, type TxClient } from "../../db/db";
import type { CreateSupplierBillDto } from "./dto/create-supplier-bill.dto";
import type { CreateSupplierBillLineDto } from "./dto/create-supplier-bill-line.dto";
import type { UpdateSupplierBillDto } from "./dto/update-supplier-bill.dto";

export type SupplierBillWithLines = SupplierBill & {
  lines: SupplierBillLine[];
};

export interface ListSupplierBillsFilters {
  status?: "DRAFT" | "POSTED";
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
  /// Added in AP-1c (docs/finance-work-item-1c-supplier-payments-
  /// proposal.md §1/§11) — a minimal, direct enabler of AP-1c's own
  /// payment-allocation flow (finding candidate bills to allocate
  /// against), not an AP-1d report endpoint.
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID";
}

/**
 * Supplier bills — AP-1b
 * (docs/finance-work-item-1b-supplier-bills-proposal.md §4, §7, §8, §17).
 *
 * Draft CRUD mirrors JournalEntriesService's create/list/findOne/update/
 * remove shape exactly (full-line-array-replacement on update, DRAFT-only
 * edit/delete, SELECT ... FOR UPDATE before any status-dependent
 * mutation). post() replicates JournalEntriesService.post()'s 10-step
 * transaction against supplier_bills instead of journal_entries, and
 * inserts DIRECTLY into the shared journal_entries/journal_lines/
 * journal_number_counters tables rather than calling
 * JournalEntriesService — proposal §8's key architectural decision:
 * JournalEntriesService.create()/.post() each own their own transaction,
 * which is the wrong shape for "bill POSTED" and "journal entry POSTED"
 * needing to commit atomically together. The private helpers below that
 * mirror JournalEntriesService's own private helpers
 * (resolveAndLockOpenPeriod, allocateJournalNumber-equivalent,
 * findInvalidAccountIds-equivalent) are deliberate, documented
 * duplication — those methods are private to JournalEntriesService, not
 * a shared exported utility only two call sites would ever use.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service throughout.
 */
@Injectable()
export class SupplierBillsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateSupplierBillDto,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const supplier = await this.validateSupplierRefOrThrow(
        tx,
        legalEntityId,
        dto.supplierId,
      );
      await this.validateLineAccountsOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.lines,
      );

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );
      const dueDate =
        dto.dueDate ??
        this.computeDefaultDueDate(dto.billDate, supplier.paymentTermsDays);
      const totals = this.computeTotals(dto.lines);

      const [createdBill] = await tx
        .insert(supplierBills)
        .values({
          tenantId,
          legalEntityId,
          supplierId: dto.supplierId,
          supplierBillNumber: dto.supplierBillNumber,
          billDate: dto.billDate,
          dueDate: dueDate ?? null,
          currencyCode,
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const insertedLines = await this.insertLines(
        tx,
        tenantId,
        createdBill!.id,
        dto.lines,
      );

      const full: SupplierBillWithLines = {
        ...createdBill!,
        lines: insertedLines,
      };

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "supplier_bill",
        entityId: createdBill!.id,
        beforeState: null,
        afterState: full as unknown as Record<string, unknown>,
      });

      return full;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListSupplierBillsFilters,
  ): Promise<SupplierBill[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(supplierBills.tenantId, tenantId),
        eq(supplierBills.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(supplierBills.status, filters.status));
      }
      if (filters.supplierId) {
        conditions.push(eq(supplierBills.supplierId, filters.supplierId));
      }
      if (filters.dateFrom) {
        conditions.push(gte(supplierBills.billDate, filters.dateFrom));
      }
      if (filters.dateTo) {
        conditions.push(lte(supplierBills.billDate, filters.dateTo));
      }
      if (filters.paymentStatus) {
        conditions.push(eq(supplierBills.paymentStatus, filters.paymentStatus));
      }
      return tx
        .select()
        .from(supplierBills)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateSupplierBillDto,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted supplier bill.");
      }

      const headerPatch: Partial<typeof supplierBills.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.supplierBillNumber !== undefined) {
        headerPatch.supplierBillNumber = dto.supplierBillNumber;
      }
      if (dto.billDate !== undefined) {
        headerPatch.billDate = dto.billDate;
      }
      if (dto.dueDate !== undefined) {
        headerPatch.dueDate = dto.dueDate;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      if (dto.lines) {
        await this.validateLineAccountsOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.lines,
        );
        const totals = this.computeTotals(dto.lines);
        headerPatch.subtotalMinor = totals.subtotalMinor;
        headerPatch.taxMinor = totals.taxMinor;
        headerPatch.totalMinor = totals.totalMinor;
      }

      await tx
        .update(supplierBills)
        .set(headerPatch)
        .where(
          and(
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        );

      if (dto.lines) {
        // Full-array replacement, not line-level add/remove — same
        // convention as JournalEntriesService.update(). Fresh 1..N
        // numbering, independent of whatever numbering the replaced
        // lines had.
        await tx
          .delete(supplierBillLines)
          .where(eq(supplierBillLines.billId, id));
        await this.insertLines(tx, tenantId, id, dto.lines);
      }

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "supplier_bill",
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
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted supplier bill.");
      }

      // supplier_bill_lines rows cascade via the existing FK's
      // onDelete: "cascade".
      await tx
        .delete(supplierBills)
        .where(
          and(
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "supplier_bill",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /bills/:id/post` — DRAFT -> POSTED. Proposal §8's 10-step
   * shape, replicated from JournalEntriesService.post() and applied to
   * a bill instead of a journal entry: lock, status, line-count,
   * account re-validation, AP settings + tax-account validation, period
   * resolution+lock, bill-number allocation, journal-number allocation,
   * direct journal_entries/journal_lines insertion, commit, dual audit.
   * A failure at any step rolls the whole transaction back — no burned
   * bill number, no burned journal number, no orphaned journal entry,
   * from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<SupplierBillWithLines> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope — the very first statement.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No supplier bill found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This supplier bill is already posted.");
      }

      // Step 3: at least 1 line (a bill's own natural minimum — unlike
      // journal entries' >= 2, a single-line bill is a valid document).
      if (before.lines.length < 1) {
        throw new UnprocessableEntityException(
          "A supplier bill must have at least 1 line to be posted.",
        );
      }

      // Step 4: re-validate every line's account, independently of
      // whatever passed at create/edit time — an account can be
      // archived between draft creation and posting.
      await this.revalidateLineAccountsForPostingOrThrow(
        tx,
        tenantId,
        legalEntityId,
        before.lines,
      );

      // Step 5: load AP settings; validate the tax-input account is
      // configured if this bill carries any tax.
      const settings = await this.loadApSettingsOrThrow(
        tx,
        tenantId,
        legalEntityId,
      );
      const taxTotal = before.lines.reduce(
        (sum, l) => sum + l.taxAmountMinor,
        0,
      );
      if (taxTotal > 0 && !settings.taxInputAccountId) {
        throw new UnprocessableEntityException(
          "This bill has tax amounts but no tax input account is configured in AP settings for this legal entity.",
        );
      }

      // Step 6: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.billDate,
      );

      // Step 7: atomic bill-number allocation — a SEPARATE counter from
      // journal_number_counters (proposal §8 step 7).
      const internalReference = await this.allocateBillNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 8: atomic journal-number allocation from the SAME sequence
      // real journal entries use — no AP-only journal-number series
      // (proposal §8 step 8, the literal "posts through the existing
      // Journal Engine" property).
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 9: insert the journal entry header as DRAFT first, then its
      // lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED. journal_lines_immutable (004) blocks
      // any INSERT once its parent journal_entries row is POSTED
      // (correctly — that guarantee is exactly what makes posted-entry
      // history append-only), so lines must exist before the header's
      // status transition, mirroring JournalEntriesService's own
      // create()-builds-lines-while-DRAFT, post()-only-flips-status
      // shape exactly, just both steps inside this one transaction
      // instead of two separate HTTP calls.
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.billDate,
          currencyCode: before.currencyCode,
          memo: `Supplier bill ${internalReference} (${before.supplierBillNumber})`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const journalLineValues: (typeof journalLines.$inferInsert)[] = [];
      let lineNumber = 1;
      for (const line of before.lines) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: line.accountId,
          debitMinor: line.amountMinor,
          creditMinor: 0,
          description: line.description ?? `Bill ${internalReference} line`,
        });
      }
      if (taxTotal > 0) {
        journalLineValues.push({
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: lineNumber++,
          accountId: settings.taxInputAccountId!,
          debitMinor: taxTotal,
          creditMinor: 0,
          description: `Tax on bill ${internalReference}`,
        });
      }
      journalLineValues.push({
        tenantId,
        journalEntryId: draftJournalEntry!.id,
        lineNumber: lineNumber++,
        accountId: settings.apControlAccountId,
        debitMinor: 0,
        creditMinor: before.totalMinor,
        description: `AP control — bill ${internalReference}`,
      });

      const insertedJournalLines = await tx
        .insert(journalLines)
        .values(journalLineValues)
        .returning();

      // Step 9b: now that the lines exist, flip the journal entry header
      // to POSTED — the same DRAFT -> POSTED transition
      // JournalEntriesService.post() performs, just inside this same
      // transaction rather than a separate HTTP call.
      const [postedJournalEntry] = await tx
        .update(journalEntries)
        .set({
          status: "POSTED",
          journalNumber,
          periodId: period.id,
          postedBy: actorUserId ?? null,
          postedAt: new Date(),
        })
        .where(eq(journalEntries.id, draftJournalEntry!.id))
        .returning();

      // Step 10: commit the bill's transition.
      const [posted] = await tx
        .update(supplierBills)
        .set({
          status: "POSTED",
          internalReference,
          journalEntryId: postedJournalEntry!.id,
          periodId: period.id,
          postedBy: actorUserId ?? null,
          postedAt: new Date(),
        })
        .where(
          and(
            eq(supplierBills.id, id),
            eq(supplierBills.tenantId, tenantId),
            eq(supplierBills.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      const after: SupplierBillWithLines = {
        ...posted!,
        lines: before.lines,
      };

      // Step 11: dual audit — POST against the bill, CREATE against the
      // new journal entry, same two-row-for-one-operation shape
      // JournalEntriesService.reverse() already establishes.
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "supplier_bill",
          entityId: id,
          beforeState: before as unknown as Record<string, unknown>,
          afterState: after as unknown as Record<string, unknown>,
        },
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "CREATE",
          entityType: "journal_entry",
          entityId: postedJournalEntry!.id,
          beforeState: null,
          afterState: {
            ...postedJournalEntry!,
            lines: insertedJournalLines,
          } as unknown as Record<string, unknown>,
        },
      ]);

      return after;
    });
  }

  /** supplierId must resolve to an existing, active supplier in the
   * caller's own (tenantId [via RLS], legalEntityId). Returns the
   * supplier row so callers can read paymentTermsDays for the due-date
   * default. */
  private async validateSupplierRefOrThrow(
    tx: TxClient,
    legalEntityId: string,
    supplierId: string,
  ): Promise<Supplier> {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.legalEntityId, legalEntityId),
          eq(suppliers.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `supplierId ${supplierId} does not refer to an active supplier in this legal entity.`,
      );
    }
    return rows[0]!;
  }

  /** Every line's accountId must resolve to an existing, active
   * chart_of_accounts row in the caller's own (tenantId, legalEntityId)
   * — create/edit-time validation. 400: request-shape validation on
   * caller-supplied input. See revalidateLineAccountsForPostingOrThrow
   * for the 422 posting-time counterpart. Deliberately does not
   * distinguish "doesn't exist" from "wrong tenant/entity" from
   * "inactive", same information-disclosure convention as every other
   * Finance service. */
  private async validateLineAccountsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: CreateSupplierBillLineDto[],
  ): Promise<void> {
    const invalid = await this.findInvalidAccountIds(
      tx,
      tenantId,
      legalEntityId,
      lines.map((l) => l.accountId),
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `The following account id(s) are not active accounts in this legal entity: ${invalid.join(", ")}.`,
      );
    }
  }

  /** Posting-time re-validation of every line's account — independent
   * of whatever passed at draft create/edit time. An account can be
   * archived between draft creation and posting. 422, not 400: this is
   * a business-rule/invariant failure at posting time. */
  private async revalidateLineAccountsForPostingOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lines: SupplierBillLine[],
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
    return uniqueIds.filter((accId) => !validIds.has(accId));
  }

  /** Loads ap_settings for this legal entity, scoped by tenantId +
   * legalEntityId within the SAME posting transaction (so a concurrent
   * ApSettingsService.upsert() either commits fully before or fully
   * after this read under read-committed isolation — see proposal §14's
   * concurrency discussion for the narrow window this does not close).
   * 422, not 404: at posting time, an unconfigured AP settings row is a
   * business-rule failure on this bill's posting attempt, not "the
   * resource you asked for doesn't exist" (contrast with
   * ApSettingsService.findOne's 404 for the direct `GET /ap/settings`
   * read). */
  private async loadApSettingsOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<ApSettings> {
    const rows = await tx
      .select()
      .from(apSettings)
      .where(
        and(
          eq(apSettings.tenantId, tenantId),
          eq(apSettings.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new UnprocessableEntityException(
        "AP settings have not been configured for this legal entity.",
      );
    }
    return rows[0]!;
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * JournalEntriesService.resolveCurrency, duplicated locally (private
   * to that class). */
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

  /** Resolves the accounting period covering `billDate` for
   * (tenantId, legalEntityId), locked via `SELECT ... FOR UPDATE` in
   * the same transaction — identical query/lock shape to
   * JournalEntriesService.resolveAndLockOpenPeriod, duplicated locally
   * (private to that class). Required so a concurrent
   * AccountingPeriodsService.close() cannot complete between this
   * resolution and the posting commit. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    billDate: string,
  ): Promise<AccountingPeriod> {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.tenantId, tenantId),
          eq(accountingPeriods.legalEntityId, legalEntityId),
          lte(accountingPeriods.startDate, billDate),
          gte(accountingPeriods.endDate, billDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!period) {
      throw new UnprocessableEntityException(
        `No accounting period covers bill date ${billDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${billDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free bill-number allocation via ap_number_counters' atomic
   * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a SEPARATE
   * counter table/row from journal_number_counters (proposal §8 step
   * 7). Formatted `BILL-{n:06d}`, scoped per legal entity. */
  private async allocateBillNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO ap_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = ap_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `BILL-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries use — identical
   * atomic pattern to JournalEntriesService.allocateJournalNumber,
   * duplicated locally (private to that class) rather than sharing the
   * same sequence via a cross-service call, which would reintroduce the
   * exact multi-transaction atomicity problem §8 avoids. Formatted
   * `JE-{n:06d}`, scoped per legal entity — the literal "no parallel
   * journal-number series" property. */
  private async allocateJournalNumber(
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

  private async insertLines(
    tx: TxClient,
    tenantId: string,
    billId: string,
    lines: CreateSupplierBillLineDto[],
  ): Promise<SupplierBillLine[]> {
    return tx
      .insert(supplierBillLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          billId,
          lineNumber: index + 1,
          accountId: line.accountId,
          description: line.description ?? null,
          amountMinor: line.amountMinor,
          taxAmountMinor: line.taxAmountMinor ?? 0,
        })),
      )
      .returning();
  }

  /** subtotalMinor = SUM(line.amountMinor), taxMinor =
   * SUM(line.taxAmountMinor), totalMinor = subtotalMinor + taxMinor —
   * server-computed, never client-supplied, matches the
   * supplier_bills_total_equals_subtotal_plus_tax CHECK constraint by
   * construction. */
  private computeTotals(lines: CreateSupplierBillLineDto[]): {
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
  } {
    const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    const taxMinor = lines.reduce((sum, l) => sum + (l.taxAmountMinor ?? 0), 0);
    return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
  }

  /** billDate + paymentTermsDays, computed once at create time — the
   * result is then an independently-editable field, never re-derived
   * from a later billDate edit (proposal §4's doc comment on dueDate).
   * Returns null if the supplier has no paymentTermsDays configured.
   * Date arithmetic is done in UTC-anchored components to avoid any
   * timezone-dependent day-shift. */
  private computeDefaultDueDate(
    billDate: string,
    paymentTermsDays: number | null,
  ): string | null {
    if (paymentTermsDays === null || paymentTermsDays === undefined) {
      return null;
    }
    const [year, month, day] = billDate.split("-").map(Number);
    const due = new Date(Date.UTC(year!, month! - 1, day!));
    due.setUTCDate(due.getUTCDate() + paymentTermsDays);
    return due.toISOString().slice(0, 10);
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking a bill belonging to a different legal entity
   * within the same tenant, same convention as every other Finance
   * service. `options.forUpdate` acquires `SELECT ... FOR UPDATE` on
   * the header row — used by every mutating operation (update/remove/
   * post) as their first statement. Plain reads never lock. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SupplierBillWithLines | undefined> {
    const condition = and(
      eq(supplierBills.id, id),
      eq(supplierBills.tenantId, tenantId),
      eq(supplierBills.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(supplierBills)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(supplierBills).where(condition).limit(1);
    const bill = rows[0];
    if (!bill) return undefined;

    const lines = await tx
      .select()
      .from(supplierBillLines)
      .where(eq(supplierBillLines.billId, id))
      .orderBy(asc(supplierBillLines.lineNumber));

    return { ...bill, lines };
  }
}
