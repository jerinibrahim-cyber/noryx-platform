import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  and,
  auditLogs,
  eq,
  gte,
  legalEntities,
  lte,
  sql,
} from "@noryx/db-core";
import {
  accountingPeriods,
  bankCashAccounts,
  bankTransactions,
  chartOfAccounts,
  journalEntries,
  journalLines,
  type AccountingPeriod,
  type BankTransaction,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type {
  BankTransactionType,
  CreateBankTransactionDto,
} from "./dto/create-bank-transaction.dto";
import type { UpdateBankTransactionDto } from "./dto/update-bank-transaction.dto";

export interface ListBankTransactionsFilters {
  status?: "DRAFT" | "POSTED";
  type?: BankTransactionType;
  bankCashAccountId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** GL account types DEPOSIT/WITHDRAWAL may reference (proposal §6.2, §19
 * item 5 — narrowed to balance-sheet sources, steering a genuine P&L-side
 * deposit/withdrawal toward FEE/INTEREST or a proper AP/AR document
 * instead). */
const DEPOSIT_WITHDRAWAL_OFFSET_TYPES = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
] as const;

/**
 * Bank Transactions — Banking-1b
 * (docs/finance-work-item-banking-1b-proposal.md §6-§10, CTO-approved).
 * A DOCUMENT — the exact DRAFT->POSTED lifecycle every other posted
 * document in this schema uses (supplier_payments, customer_receipts,
 * ...), NOT master data like bank_cash_accounts itself.
 *
 * Draft CRUD mirrors SupplierPaymentsService's create/list/findOne/
 * update/remove shape exactly (SELECT ... FOR UPDATE before any
 * status-dependent mutation, DRAFT-only edit/delete). post() replicates
 * the identical replicated-Journal-Engine-posting shape every sub-ledger
 * already uses — direct insertion into the shared journal_entries/
 * journal_lines/journal_number_counters tables, inside this service's own
 * transaction, rather than calling JournalEntriesService (proposal §8) —
 * for the identical transaction-atomicity reason repeated by every prior
 * work item: calling JournalEntriesService as a second, sequential call
 * would split "document POSTED" and "journal entry POSTED" into two
 * transactions, unacceptable for Finance.
 *
 * bankCashAccountId/counterpartyBankCashAccountId reference
 * bank_cash_accounts.id directly (Banking-1a's own master entity) — the
 * first real FK consumer of that table (proposal §10). Posting resolves
 * each referenced Bank/Cash Account's own glAccountId and re-validates
 * that underlying chart_of_accounts row is still ACTIVE at post time
 * (independent of whatever passed at draft create/edit time) — the same
 * "re-validate every line's account independently of create/edit time"
 * discipline the Journal Engine and every sub-ledger already apply
 * (JournalEntriesService.post() step 6); this is distinct from, and does
 * not contradict, Banking-1a's own "reads never re-check the linked GL
 * account's state" rule, which governs reading/listing a Bank/Cash
 * Account, not posting a new journal entry against one.
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every other
 * Finance service.
 */
@Injectable()
export class BankTransactionsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateBankTransactionDto,
  ): Promise<BankTransaction> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.validateBankCashAccountRefOrThrow(
        tx,
        legalEntityId,
        dto.bankCashAccountId,
      );

      if (dto.type === "TRANSFER") {
        // dto's own IsValidBankTransactionAccountShape constraint already
        // guarantees counterpartyBankCashAccountId is present and
        // glAccountId is absent for TRANSFER — see create-bank-
        // transaction.dto.ts.
        const counterpartyId = dto.counterpartyBankCashAccountId!;
        if (counterpartyId === dto.bankCashAccountId) {
          throw new BadRequestException(
            "counterpartyBankCashAccountId must refer to a different Bank/Cash Account than bankCashAccountId.",
          );
        }
        await this.validateBankCashAccountRefOrThrow(
          tx,
          legalEntityId,
          counterpartyId,
        );
      } else {
        // dto's own constraint guarantees glAccountId is present and
        // counterpartyBankCashAccountId is absent for every other type.
        await this.validateOffsetAccountOrThrow(
          tx,
          legalEntityId,
          dto.type,
          dto.glAccountId!,
        );
      }

      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );

      const [created] = await tx
        .insert(bankTransactions)
        .values({
          tenantId,
          legalEntityId,
          type: dto.type,
          transactionDate: dto.transactionDate,
          currencyCode,
          amountMinor: dto.amountMinor,
          bankCashAccountId: dto.bankCashAccountId,
          counterpartyBankCashAccountId:
            dto.counterpartyBankCashAccountId ?? null,
          glAccountId: dto.glAccountId ?? null,
          reference: dto.reference ?? null,
          memo: dto.memo ?? null,
          createdBy: actorUserId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "bank_transaction",
        entityId: created!.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created!;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListBankTransactionsFilters,
  ): Promise<BankTransaction[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(bankTransactions.tenantId, tenantId),
        eq(bankTransactions.legalEntityId, legalEntityId),
      ];
      if (filters.status) {
        conditions.push(eq(bankTransactions.status, filters.status));
      }
      if (filters.type) {
        conditions.push(eq(bankTransactions.type, filters.type));
      }
      if (filters.bankCashAccountId) {
        conditions.push(
          eq(bankTransactions.bankCashAccountId, filters.bankCashAccountId),
        );
      }
      if (filters.dateFrom) {
        conditions.push(
          gte(bankTransactions.transactionDate, filters.dateFrom),
        );
      }
      if (filters.dateTo) {
        conditions.push(lte(bankTransactions.transactionDate, filters.dateTo));
      }
      return tx
        .select()
        .from(bankTransactions)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<BankTransaction> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No bank transaction found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateBankTransactionDto,
  ): Promise<BankTransaction> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No bank transaction found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot edit a posted bank transaction.");
      }

      // type is immutable (proposal §19 item 4) and absent from this DTO
      // — the shape invariant the create DTO's own constraint enforces
      // must therefore be enforced here instead, against the
      // transaction's own existing (immutable) type.
      if (before.type === "TRANSFER") {
        if (dto.glAccountId !== undefined) {
          throw new BadRequestException(
            "glAccountId cannot be set on a TRANSFER bank transaction — use counterpartyBankCashAccountId.",
          );
        }
      } else if (dto.counterpartyBankCashAccountId !== undefined) {
        throw new BadRequestException(
          `counterpartyBankCashAccountId cannot be set on a ${before.type} bank transaction — use glAccountId.`,
        );
      }

      const nextBankCashAccountId =
        dto.bankCashAccountId ?? before.bankCashAccountId;
      const nextCounterpartyId =
        dto.counterpartyBankCashAccountId !== undefined
          ? dto.counterpartyBankCashAccountId
          : before.counterpartyBankCashAccountId;

      if (dto.bankCashAccountId !== undefined) {
        await this.validateBankCashAccountRefOrThrow(
          tx,
          legalEntityId,
          dto.bankCashAccountId,
        );
      }
      if (before.type === "TRANSFER") {
        if (dto.counterpartyBankCashAccountId !== undefined) {
          await this.validateBankCashAccountRefOrThrow(
            tx,
            legalEntityId,
            dto.counterpartyBankCashAccountId,
          );
        }
        if (
          nextCounterpartyId !== null &&
          nextCounterpartyId === nextBankCashAccountId
        ) {
          throw new BadRequestException(
            "counterpartyBankCashAccountId must refer to a different Bank/Cash Account than bankCashAccountId.",
          );
        }
      } else if (dto.glAccountId !== undefined) {
        await this.validateOffsetAccountOrThrow(
          tx,
          legalEntityId,
          before.type,
          dto.glAccountId,
        );
      }

      const headerPatch: Partial<typeof bankTransactions.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.transactionDate !== undefined) {
        headerPatch.transactionDate = dto.transactionDate;
      }
      if (dto.amountMinor !== undefined) {
        headerPatch.amountMinor = dto.amountMinor;
      }
      if (dto.bankCashAccountId !== undefined) {
        headerPatch.bankCashAccountId = dto.bankCashAccountId;
      }
      if (dto.counterpartyBankCashAccountId !== undefined) {
        headerPatch.counterpartyBankCashAccountId =
          dto.counterpartyBankCashAccountId;
      }
      if (dto.glAccountId !== undefined) {
        headerPatch.glAccountId = dto.glAccountId;
      }
      if (dto.reference !== undefined) {
        headerPatch.reference = dto.reference;
      }
      if (dto.memo !== undefined) {
        headerPatch.memo = dto.memo;
      }

      const [updated] = await tx
        .update(bankTransactions)
        .set(headerPatch)
        .where(
          and(
            eq(bankTransactions.id, id),
            eq(bankTransactions.tenantId, tenantId),
            eq(bankTransactions.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_transaction",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<BankTransaction> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No bank transaction found with id ${id}.`);
      }
      if (before.status !== "DRAFT") {
        throw new ConflictException("Cannot delete a posted bank transaction.");
      }

      await tx
        .delete(bankTransactions)
        .where(
          and(
            eq(bankTransactions.id, id),
            eq(bankTransactions.tenantId, tenantId),
            eq(bankTransactions.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "bank_transaction",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /**
   * `POST /bank-transactions/:id/post` — DRAFT -> POSTED. Proposal §8's
   * shape: lock, status, re-validate bank/cash leg(s) + offset account
   * (resolving each Bank/Cash Account's own glAccountId along the way),
   * resolve+lock the covering OPEN period, atomic transaction-number
   * allocation, atomic journal-number allocation, direct journal_entries/
   * journal_lines insertion (DRAFT-then-POST ordering — journal_lines_
   * immutable blocks any INSERT once its parent journal_entries row is
   * POSTED, same ordering fix already established by every prior sub-
   * ledger's post()), commit, 2-row audit (transaction + journal entry).
   * A failure at any step rolls the whole transaction back — no burned
   * transaction number, no burned journal number, no orphaned journal
   * entry, from a failed post.
   */
  async post(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<BankTransaction> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // Step 1: load + lock + scope.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No bank transaction found with id ${id}.`);
      }

      // Step 2: status === DRAFT.
      if (before.status !== "DRAFT") {
        throw new ConflictException("This bank transaction is already posted.");
      }

      // Step 3: re-validate the primary bank/cash leg, independently of
      // whatever passed at draft create/edit time — an account can be
      // deactivated between draft creation and posting. Resolves its own
      // glAccountId (and re-validates that underlying GL account is
      // still ACTIVE) in the same query.
      const primaryLeg = await this.revalidateBankCashAccountForPostingOrThrow(
        tx,
        legalEntityId,
        before.bankCashAccountId,
      );

      let debitAccountId: string;
      let creditAccountId: string;

      if (before.type === "TRANSFER") {
        // Step 4 (TRANSFER): re-validate the counterparty leg the same
        // way.
        const counterpartyLeg =
          await this.revalidateBankCashAccountForPostingOrThrow(
            tx,
            legalEntityId,
            before.counterpartyBankCashAccountId!,
          );
        // Destination (counterparty) Dr / Source (primary) Cr — proposal
        // §8's TRANSFER row, "A -> B: DEBIT B.glAccountId / CREDIT
        // A.glAccountId" — bankCashAccountId is the "from" (A) leg by
        // convention, counterpartyBankCashAccountId is the "to" (B) leg.
        debitAccountId = counterpartyLeg.glAccountId;
        creditAccountId = primaryLeg.glAccountId;
      } else {
        // Step 4 (non-TRANSFER): re-validate the offset account,
        // independently of whatever passed at draft create/edit time.
        const offsetAccountId =
          await this.revalidateOffsetAccountForPostingOrThrow(
            tx,
            legalEntityId,
            before.type,
            before.glAccountId!,
          );
        switch (before.type) {
          case "DEPOSIT":
          case "INTEREST":
            // Bank/Cash Dr / Offset Cr — money enters the account.
            debitAccountId = primaryLeg.glAccountId;
            creditAccountId = offsetAccountId;
            break;
          case "WITHDRAWAL":
          case "FEE":
            // Offset Dr / Bank/Cash Cr — money leaves the account.
            debitAccountId = offsetAccountId;
            creditAccountId = primaryLeg.glAccountId;
            break;
          default: {
            const exhaustive: never = before.type;
            throw new UnprocessableEntityException(
              `Unhandled bank transaction type: ${String(exhaustive)}.`,
            );
          }
        }
      }

      // Step 5: resolve + lock the covering OPEN period.
      const period = await this.resolveAndLockOpenPeriod(
        tx,
        tenantId,
        legalEntityId,
        before.transactionDate,
      );

      // Step 6: atomic transaction-number allocation — a SEPARATE
      // counter from every other document's own counter (proposal §15).
      const internalReference = await this.allocateBankTransactionNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 7: atomic journal-number allocation from the SAME sequence
      // real journal entries and every other document use — no
      // Banking-only journal-number series.
      const journalNumber = await this.allocateJournalNumber(
        tx,
        tenantId,
        legalEntityId,
      );

      // Step 8: insert the journal entry header as DRAFT first, then its
      // lines, then flip to POSTED in a separate UPDATE below — NOT
      // inserted already-POSTED (journal_lines_immutable would otherwise
      // reject the line INSERTs).
      const [draftJournalEntry] = await tx
        .insert(journalEntries)
        .values({
          tenantId,
          legalEntityId,
          transactionDate: before.transactionDate,
          currencyCode: before.currencyCode,
          memo: `Bank Transaction ${internalReference} (${before.type})`,
          createdBy: actorUserId ?? null,
        })
        .returning();

      const journalLineValues: (typeof journalLines.$inferInsert)[] = [
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 1,
          accountId: debitAccountId,
          debitMinor: before.amountMinor,
          creditMinor: 0,
          description: `Bank Transaction ${internalReference} — ${before.type}`,
        },
        {
          tenantId,
          journalEntryId: draftJournalEntry!.id,
          lineNumber: 2,
          accountId: creditAccountId,
          debitMinor: 0,
          creditMinor: before.amountMinor,
          description: `Bank Transaction ${internalReference} — ${before.type}`,
        },
      ];
      const insertedJournalLines = await tx
        .insert(journalLines)
        .values(journalLineValues)
        .returning();

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

      // Step 9: commit the bank transaction's own transition.
      const [posted] = await tx
        .update(bankTransactions)
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
            eq(bankTransactions.id, id),
            eq(bankTransactions.tenantId, tenantId),
            eq(bankTransactions.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      // Step 10: audit — POST against the transaction, CREATE against
      // the new journal entry (proposal §12 — a 2-row audit write per
      // post, no per-child-row audit since Bank Transaction has no child
      // rows analogous to bill settlement).
      await tx.insert(auditLogs).values([
        {
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "POST",
          entityType: "bank_transaction",
          entityId: id,
          beforeState: before as unknown as Record<string, unknown>,
          afterState: posted as unknown as Record<string, unknown>,
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

      return posted!;
    });
  }

  /** bankCashAccountId/counterpartyBankCashAccountId must resolve to an
   * existing, active bank_cash_accounts row in the caller's own legal
   * entity — create/edit-time validation, 400. RLS already scopes the
   * lookup to the caller's tenant; legalEntityId is applied explicitly
   * (same convention as every other Finance service). Deliberately does
   * NOT check the linked GL account's active state here — that mirrors
   * Banking-1a's own posture (a Bank/Cash Account reference is valid to
   * *select* as long as the Bank/Cash Account itself is active; whether
   * its GL account is postable is a posting-time concern, checked
   * separately in revalidateBankCashAccountForPostingOrThrow). */
  private async validateBankCashAccountRefOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: bankCashAccounts.id })
      .from(bankCashAccounts)
      .where(
        and(
          eq(bankCashAccounts.id, accountId),
          eq(bankCashAccounts.legalEntityId, legalEntityId),
          eq(bankCashAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `bankCashAccountId ${accountId} does not refer to an active Bank/Cash Account in this legal entity.`,
      );
    }
  }

  /** Posting-time re-validation of a bank/cash leg — independent of
   * whatever passed at draft create/edit time. Re-checks BOTH that the
   * bank_cash_accounts row is still active AND that its own linked GL
   * account (chart_of_accounts) is still active — a Bank Transaction is
   * about to post a real journal line against that GL account, so it
   * must be postable today, the same "re-validate every line's account
   * independently of create/edit time" discipline the Journal Engine and
   * every sub-ledger already apply. 422, not 400: a business-rule/
   * invariant failure at posting time. Returns the resolved glAccountId
   * for use in journal-line construction. */
  private async revalidateBankCashAccountForPostingOrThrow(
    tx: TxClient,
    legalEntityId: string,
    accountId: string,
  ): Promise<{ glAccountId: string }> {
    const rows = await tx
      .select({
        glAccountId: bankCashAccounts.glAccountId,
        glAccountActive: chartOfAccounts.isActive,
      })
      .from(bankCashAccounts)
      .innerJoin(
        chartOfAccounts,
        eq(chartOfAccounts.id, bankCashAccounts.glAccountId),
      )
      .where(
        and(
          eq(bankCashAccounts.id, accountId),
          eq(bankCashAccounts.legalEntityId, legalEntityId),
          eq(bankCashAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0 || !rows[0]!.glAccountActive) {
      throw new UnprocessableEntityException(
        `bankCashAccountId ${accountId} is not an active Bank/Cash Account with an active GL account in this legal entity.`,
      );
    }
    return { glAccountId: rows[0]!.glAccountId };
  }

  /** glAccountId must resolve to an existing, active chart_of_accounts
   * row in the caller's own legal entity, of a type permitted for `type`
   * (proposal §6.2): FEE -> EXPENSE, INTEREST -> REVENUE, DEPOSIT/
   * WITHDRAWAL -> ASSET/LIABILITY/EQUITY. Create/edit-time validation,
   * 400. */
  private async validateOffsetAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    type: BankTransactionType,
    accountId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: chartOfAccounts.id, type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `glAccountId ${accountId} does not refer to an active account in this legal entity.`,
      );
    }
    this.assertOffsetAccountTypeAllowed(type, rows[0]!.type, accountId);
  }

  /** Posting-time re-validation of the offset account — independent of
   * whatever passed at draft create/edit time. 422, not 400. Returns the
   * validated accountId unchanged, for symmetry with
   * revalidateBankCashAccountForPostingOrThrow's return shape. */
  private async revalidateOffsetAccountForPostingOrThrow(
    tx: TxClient,
    legalEntityId: string,
    type: BankTransactionType,
    accountId: string,
  ): Promise<string> {
    const rows = await tx
      .select({ id: chartOfAccounts.id, type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.id, accountId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new UnprocessableEntityException(
        `glAccountId ${accountId} is not an active account in this legal entity.`,
      );
    }
    try {
      this.assertOffsetAccountTypeAllowed(type, rows[0]!.type, accountId);
    } catch {
      throw new UnprocessableEntityException(
        `glAccountId ${accountId} (type ${rows[0]!.type}) is not a permitted offset account for a ${type} bank transaction.`,
      );
    }
    return accountId;
  }

  private assertOffsetAccountTypeAllowed(
    type: BankTransactionType,
    accountType: string,
    accountId: string,
  ): void {
    if (type === "FEE" && accountType !== "EXPENSE") {
      throw new BadRequestException(
        `glAccountId ${accountId} must reference an EXPENSE account for a FEE bank transaction (found ${accountType}).`,
      );
    }
    if (type === "INTEREST" && accountType !== "REVENUE") {
      throw new BadRequestException(
        `glAccountId ${accountId} must reference a REVENUE account for an INTEREST bank transaction (found ${accountType}).`,
      );
    }
    if (
      (type === "DEPOSIT" || type === "WITHDRAWAL") &&
      !DEPOSIT_WITHDRAWAL_OFFSET_TYPES.includes(
        accountType as (typeof DEPOSIT_WITHDRAWAL_OFFSET_TYPES)[number],
      )
    ) {
      throw new BadRequestException(
        `glAccountId ${accountId} must reference an ASSET, LIABILITY, or EQUITY account for a ${type} bank transaction (found ${accountType}).`,
      );
    }
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * BankCashAccountsService.resolveCurrency, duplicated locally (private
   * to this class, same convention as every other sub-ledger). */
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

  /** Resolves the accounting period covering `transactionDate`, locked
   * via `SELECT ... FOR UPDATE`. Identical query/lock shape to
   * SupplierPaymentsService.resolveAndLockOpenPeriod, duplicated
   * locally. */
  private async resolveAndLockOpenPeriod(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    transactionDate: string,
  ): Promise<AccountingPeriod> {
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
      throw new UnprocessableEntityException(
        `No accounting period covers transaction date ${transactionDate} for this legal entity.`,
      );
    }
    if (period.status !== "OPEN") {
      throw new UnprocessableEntityException(
        `Accounting period "${period.code}" covering ${transactionDate} is closed.`,
      );
    }
    return period;
  }

  /** Race-free transaction-numbering allocation via
   * bank_transaction_number_counters' atomic `INSERT ... ON CONFLICT DO
   * UPDATE ... RETURNING` — a SEPARATE table from every other document's
   * own counter (proposal §2.5/§15). Formatted `BTX-{n:06d}`, scoped per
   * legal entity. */
  private async allocateBankTransactionNumber(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
  ): Promise<string> {
    const rows = (await tx.execute(sql`
      INSERT INTO bank_transaction_number_counters (tenant_id, legal_entity_id, last_assigned_number)
      VALUES (${tenantId}, ${legalEntityId}, 1)
      ON CONFLICT (tenant_id, legal_entity_id)
      DO UPDATE SET last_assigned_number = bank_transaction_number_counters.last_assigned_number + 1
      RETURNING last_assigned_number
    `)) as unknown as Array<{ last_assigned_number: number }>;
    const lastAssignedNumber = rows[0]!.last_assigned_number;
    return `BTX-${String(lastAssignedNumber).padStart(6, "0")}`;
  }

  /** Race-free journal-number allocation from the SAME
   * journal_number_counters row real journal entries and every other
   * document use — identical atomic pattern to every other sub-ledger's
   * own private copy, duplicated locally rather than sharing via a
   * cross-service call. Formatted `JE-{n:06d}`, scoped per legal
   * entity. */
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

  /** Scoped by (id, tenantId, legalEntityId) — same convention as every
   * other Finance service. `options.forUpdate` acquires
   * `SELECT ... FOR UPDATE` on the row — used by every mutating operation
   * (update/remove/post) as their first statement. Plain reads never
   * lock. Deliberately does NOT join or filter on the linked bank_cash_
   * accounts row's isActive state — reads never reject/hide a Bank
   * Transaction because its Bank/Cash Account later became inactive
   * (same locked historical-read correction Banking-1a itself
   * established). */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<BankTransaction | undefined> {
    const condition = and(
      eq(bankTransactions.id, id),
      eq(bankTransactions.tenantId, tenantId),
      eq(bankTransactions.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(bankTransactions)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(bankTransactions).where(condition).limit(1);
    return rows[0];
  }
}
