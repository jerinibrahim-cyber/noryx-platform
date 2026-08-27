import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, auditLogs, eq, gte, inArray, lte, or, sql } from "@noryx/db-core";
import { PostgresError } from "postgres";
import {
  bankCashAccounts,
  bankReconciliationMatches,
  bankStatementImports,
  bankStatementLines,
  bankTransactions,
  chartOfAccounts,
  type BankReconciliationMatch,
  type BankStatementImport,
  type BankStatementLine,
  type BankTransaction,
  type ChartOfAccount,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { BankTransactionsService } from "../bank-transactions/bank-transactions.service";
import type { ImportBankStatementDto } from "./dto/import-bank-statement.dto";
import type { UpdateBankStatementImportDto } from "./dto/update-bank-statement-import.dto";
import type { CreateBankReconciliationMatchDto } from "./dto/create-bank-reconciliation-match.dto";
import type { IgnoreBankStatementLineDto } from "./dto/ignore-bank-statement-line.dto";
import type { CreateBankTransactionFromLineDto } from "./dto/create-bank-transaction-from-line.dto";
import type { ListBankStatementImportsQueryDto } from "./dto/list-bank-statement-imports.query.dto";
import type { ListBankStatementLinesQueryDto } from "./dto/list-bank-statement-lines.query.dto";
import type { CreateBankTransactionDto } from "../bank-transactions/dto/create-bank-transaction.dto";

/** Deterministic-match tolerance window (§8) — a configurable value in
 * principle, hardcoded to the proposal's documented default for MVP (no
 * per-tenant configuration surface exists anywhere in this codebase to
 * extend). */
const DETERMINISTIC_MATCH_TOLERANCE_DAYS = 3;

export interface BankStatementImportSummary {
  /** Balance block (§16/§17) — never collapsed with the matching block. */
  statementClosingBalanceMinor: number | null;
  glBookBalanceMinor: number;
  differenceMinor: number | null;
  /** Matching-completeness block (§9/§16) — always reported separately. */
  totalStatementLines: number;
  matchedStatementLines: number;
  partiallyMatchedStatementLines: number;
  unmatchedStatementLines: number;
  ignoredStatementLines: number;
  unmatchedBankTransactionCount: number;
}

export interface BankStatementImportWithSummary extends BankStatementImport {
  summary: BankStatementImportSummary;
}

interface ParsedCsvLine {
  lineNumber: number; // 1-based, including the header row, for error messages.
  lineDate: string;
  direction: "DEBIT" | "CREDIT";
  amountMinor: number;
  externalReference: string | null;
  rawDescription: string | null;
}

interface CsvParseResult {
  lines: ParsedCsvLine[];
  errors: string[];
}

/**
 * Bank Statement Import & Bank Reconciliation — Banking-1c
 * (docs/finance-work-item-banking-1c-proposal.md, CTO-APPROVED —
 * implementation-authorization turn, amended proposal, locked
 * semantics).
 *
 * The reconciliation layer owns matching/linking state ONLY (§10) — it
 * never inserts into journal_entries/journal_lines directly, and never
 * calls JournalEntriesService. The one write it makes against
 * bank_transactions is via the existing, unmodified
 * BankTransactionsService.create() (create-from-line, §10) — this
 * service never mutates bank_transactions/bank_cash_accounts any other
 * way.
 *
 * BOOK BALANCE (glBookBalance below) is the actual GL balance of
 * bank_cash_accounts.glAccountId, computed the same way
 * GeneralLedgerService.getBalance computes any account balance —
 * duplicated locally rather than importing GeneralLedgerService, the
 * same cross-module-coupling convention every other report in this
 * codebase already follows (financial-statements.service.ts's own
 * signFor/rawTotalsBefore duplication, ap-reports.service.ts's own
 * glLiabilityBalance). It is NEVER a sum of bank_transactions (§17,
 * BLOCKER-corrected).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class BankReconciliationService {
  constructor(private readonly bankTransactions: BankTransactionsService) {}

  // -------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------

  /** `POST /bank-statement-imports` — synchronous CSV_GENERIC parse +
   * validate + persist (§5/§7). A malformed file produces a FAILED
   * import header with `parseErrors` populated and ZERO lines persisted
   * (§20 acceptance criterion 1) — never a partial import. A valid file
   * always produces a VALIDATED import with every line persisted, even
   * when duplicate-line-fingerprint or opening/closing-balance
   * internal-consistency warnings exist (§7/§12 — warnings never
   * block). */
  async importStatement(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: ImportBankStatementDto,
    fileBuffer: Buffer,
    uploadedFileName: string,
  ): Promise<BankStatementImport> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const bankCashAccount = await this.resolveActiveBankCashAccountOrThrow(
        tx,
        legalEntityId,
        dto.bankCashAccountId,
      );

      const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

      // Friendly pre-check for bank_statement_imports_account_file_hash_
      // unique — the DB UNIQUE constraint is the race closer (§12,
      // same "friendly check + DB constraint" pattern as
      // BankCashAccountsService.create's own code-uniqueness check).
      const existing = await tx
        .select({ id: bankStatementImports.id })
        .from(bankStatementImports)
        .where(
          and(
            eq(bankStatementImports.tenantId, tenantId),
            eq(bankStatementImports.legalEntityId, legalEntityId),
            eq(bankStatementImports.bankCashAccountId, dto.bankCashAccountId),
            eq(bankStatementImports.fileHash, fileHash),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          "A byte-identical file has already been imported for this Bank/Cash Account.",
        );
      }

      const currencyCode = bankCashAccount.currencyCode;
      const parsed = this.parseCsvGeneric(fileBuffer.toString("utf-8"));

      const fileName = dto.fileName ?? uploadedFileName;
      const sourceFormat = dto.sourceFormat ?? "CSV_GENERIC";

      if (parsed.errors.length > 0) {
        let created: BankStatementImport;
        try {
          const [row] = await tx
            .insert(bankStatementImports)
            .values({
              tenantId,
              legalEntityId,
              bankCashAccountId: dto.bankCashAccountId,
              sourceFormat,
              fileName,
              fileHash,
              statementDateFrom: dto.statementDateFrom,
              statementDateTo: dto.statementDateTo,
              openingBalanceMinor: dto.openingBalanceMinor ?? null,
              closingBalanceMinor: dto.closingBalanceMinor ?? null,
              status: "FAILED",
              parseErrors: parsed.errors,
              importedBy: actorUserId ?? null,
            })
            .returning();
          created = row!;
        } catch (err) {
          throw this.mapImportUniqueViolation(err);
        }

        await tx.insert(auditLogs).values({
          tenantId,
          legalEntityId,
          actorUserId: actorUserId ?? undefined,
          action: "CREATE",
          entityType: "bank_statement_import",
          entityId: created.id,
          beforeState: null,
          afterState: {
            ...created,
            lineCount: 0,
            parseErrors: parsed.errors,
          } as unknown as Record<string, unknown>,
        });

        return created;
      }

      // Duplicate-line-fingerprint warning (§12) — checked against every
      // existing line for this account across DIFFERENT imports, never
      // blocking.
      const fingerprints = parsed.lines.map((l) =>
        this.lineFingerprint(dto.bankCashAccountId, l),
      );
      const priorMatches =
        fingerprints.length > 0
          ? await tx
              .select({
                lineFingerprint: bankStatementLines.lineFingerprint,
                lineDate: bankStatementLines.lineDate,
              })
              .from(bankStatementLines)
              .where(
                and(
                  eq(
                    bankStatementLines.bankCashAccountId,
                    dto.bankCashAccountId,
                  ),
                  inArray(bankStatementLines.lineFingerprint, fingerprints),
                ),
              )
          : [];
      const priorByFingerprint = new Map(
        priorMatches.map((r) => [r.lineFingerprint, r.lineDate]),
      );
      const warnings: string[] = [];
      for (const fp of new Set(fingerprints)) {
        const priorDate = priorByFingerprint.get(fp);
        if (priorDate) {
          warnings.push(
            `Possible duplicate of a line already imported on ${priorDate}.`,
          );
        }
      }

      // Best-effort internal-consistency check (§7) — non-blocking, only
      // evaluated when BOTH balances are present.
      if (
        dto.openingBalanceMinor !== undefined &&
        dto.closingBalanceMinor !== undefined
      ) {
        const creditSum = parsed.lines
          .filter((l) => l.direction === "CREDIT")
          .reduce((sum, l) => sum + l.amountMinor, 0);
        const debitSum = parsed.lines
          .filter((l) => l.direction === "DEBIT")
          .reduce((sum, l) => sum + l.amountMinor, 0);
        const computedClosing = dto.openingBalanceMinor + creditSum - debitSum;
        if (computedClosing !== dto.closingBalanceMinor) {
          warnings.push(
            `Internal-consistency check failed: openingBalanceMinor (${dto.openingBalanceMinor}) + credits (${creditSum}) - debits (${debitSum}) = ${computedClosing}, which does not equal the declared closingBalanceMinor (${dto.closingBalanceMinor}). This does not block import.`,
          );
        }
      }

      let created: BankStatementImport;
      try {
        const [row] = await tx
          .insert(bankStatementImports)
          .values({
            tenantId,
            legalEntityId,
            bankCashAccountId: dto.bankCashAccountId,
            sourceFormat,
            fileName,
            fileHash,
            statementDateFrom: dto.statementDateFrom,
            statementDateTo: dto.statementDateTo,
            openingBalanceMinor: dto.openingBalanceMinor ?? null,
            closingBalanceMinor: dto.closingBalanceMinor ?? null,
            status: "VALIDATED",
            parseWarnings: warnings.length > 0 ? warnings : null,
            importedBy: actorUserId ?? null,
          })
          .returning();
        created = row!;
      } catch (err) {
        throw this.mapImportUniqueViolation(err);
      }

      const insertedLines =
        parsed.lines.length > 0
          ? await tx
              .insert(bankStatementLines)
              .values(
                parsed.lines.map((l) => ({
                  tenantId,
                  legalEntityId,
                  statementImportId: created.id,
                  bankCashAccountId: dto.bankCashAccountId,
                  lineDate: l.lineDate,
                  direction: l.direction,
                  amountMinor: l.amountMinor,
                  currencyCode,
                  externalReference: l.externalReference,
                  rawDescription: l.rawDescription,
                  lineFingerprint: this.lineFingerprint(
                    dto.bankCashAccountId,
                    l,
                  ),
                })),
              )
              .returning()
          : [];

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "bank_statement_import",
        entityId: created.id,
        beforeState: null,
        afterState: {
          ...created,
          lineCount: insertedLines.length,
          parseWarnings: warnings,
        } as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListBankStatementImportsQueryDto,
  ): Promise<BankStatementImport[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(bankStatementImports.tenantId, tenantId),
        eq(bankStatementImports.legalEntityId, legalEntityId),
      ];
      if (filters.bankCashAccountId) {
        conditions.push(
          eq(bankStatementImports.bankCashAccountId, filters.bankCashAccountId),
        );
      }
      if (filters.status) {
        conditions.push(eq(bankStatementImports.status, filters.status));
      }
      if (filters.reconciliationStatus) {
        conditions.push(
          eq(
            bankStatementImports.reconciliationStatus,
            filters.reconciliationStatus,
          ),
        );
      }
      return tx
        .select()
        .from(bankStatementImports)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<BankStatementImportWithSummary> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        id,
      );
      const summary = await this.summaryFor(tx, tenantId, legalEntityId, found);
      return { ...found, summary };
    });
  }

  /** `PATCH /bank-statement-imports/:id` — sets/corrects
   * openingBalanceMinor/closingBalanceMinor (§7/§9/§15). Only permitted
   * while `reconciliationStatus = OPEN` — the immutability trigger would
   * reject an UPDATE once COMPLETED, but this friendly check gives a
   * clean 409 rather than a raw DB-trigger error surfacing to the
   * client. */
  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateBankStatementImportDto,
  ): Promise<BankStatementImport> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        id,
        { forUpdate: true },
      );
      if (before.reconciliationStatus === "COMPLETED") {
        throw new ConflictException(
          "Cannot edit a completed reconciliation's import — completion is an immutable historical snapshot.",
        );
      }

      const patch: Partial<typeof bankStatementImports.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.openingBalanceMinor !== undefined) {
        patch.openingBalanceMinor = dto.openingBalanceMinor;
      }
      if (dto.closingBalanceMinor !== undefined) {
        patch.closingBalanceMinor = dto.closingBalanceMinor;
      }

      const [updated] = await tx
        .update(bankStatementImports)
        .set(patch)
        .where(
          and(
            eq(bankStatementImports.id, id),
            eq(bankStatementImports.tenantId, tenantId),
            eq(bankStatementImports.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_statement_import",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** `DELETE /bank-statement-imports/:id` — permitted only while
   * `status IN (PENDING, FAILED)` AND `reconciliationStatus = OPEN` AND
   * zero ACTIVE matches (§15) — before anything meaningful has
   * happened, mirroring the DRAFT-only-delete convention every document
   * in this codebase follows. A VALIDATED import (lines exist) is never
   * deletable through this endpoint — re-importing after correcting a
   * source file is the intended path, not editing history. */
  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<BankStatementImport> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        id,
        { forUpdate: true },
      );
      if (before.status !== "PENDING" && before.status !== "FAILED") {
        throw new ConflictException(
          "Cannot delete a VALIDATED bank statement import — its lines are part of the reconciliation record. Delete is only permitted for a PENDING or FAILED import.",
        );
      }
      if (before.reconciliationStatus !== "OPEN") {
        throw new ConflictException(
          "Cannot delete a completed reconciliation's import.",
        );
      }
      const activeMatchCount = await this.countActiveMatchesForImport(tx, id);
      if (activeMatchCount > 0) {
        throw new ConflictException(
          "Cannot delete a bank statement import with active matches.",
        );
      }

      await tx
        .delete(bankStatementLines)
        .where(eq(bankStatementLines.statementImportId, id));
      await tx
        .delete(bankStatementImports)
        .where(
          and(
            eq(bankStatementImports.id, id),
            eq(bankStatementImports.tenantId, tenantId),
            eq(bankStatementImports.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "bank_statement_import",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  // -------------------------------------------------------------------
  // Statement lines
  // -------------------------------------------------------------------

  async listLines(
    tenantId: string,
    legalEntityId: string,
    importId: string,
    filters: ListBankStatementLinesQueryDto,
  ): Promise<BankStatementLine[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.resolveImportOrThrow(tx, tenantId, legalEntityId, importId);
      const conditions = [
        eq(bankStatementLines.statementImportId, importId),
        eq(bankStatementLines.tenantId, tenantId),
        eq(bankStatementLines.legalEntityId, legalEntityId),
      ];
      if (filters.matchStatus) {
        conditions.push(
          eq(bankStatementLines.matchStatus, filters.matchStatus),
        );
      }
      return tx
        .select()
        .from(bankStatementLines)
        .where(and(...conditions));
    });
  }

  /** `GET /bank-statement-imports/:id/lines/:lineId/suggestions` —
   * `DETERMINISTIC_MATCH`-tier candidates, computed at read time, never
   * persisted until confirmed (§8/§16). Returns every `POSTED`
   * `bank_transactions` row in the matching candidate universe (§8)
   * satisfying: same Bank/Cash Account context (the line's own account,
   * or — for a TRANSFER — either leg), same amount, matching direction,
   * `transactionDate` within the tolerance window of `lineDate`, and
   * positive remaining (unmatched) amount. `ambiguous: true` whenever
   * more than one candidate qualifies (§8) — the caller must never
   * auto-pick a winner from more than one candidate. */
  async suggestionsForLine(
    tenantId: string,
    legalEntityId: string,
    importId: string,
    lineId: string,
  ): Promise<{ candidates: BankTransaction[]; ambiguous: boolean }> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.resolveImportOrThrow(tx, tenantId, legalEntityId, importId);
      const line = await this.resolveLineOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
        lineId,
      );
      const candidates = await this.deterministicCandidatesForLine(tx, line);
      return { candidates, ambiguous: candidates.length > 1 };
    });
  }

  /** `POST /bank-statement-imports/:id/lines/:lineId/ignore` — marks a
   * line `IGNORED` (§9/§10), an explicit, recorded user action, never a
   * default/inferred state. Rejected if the line already has any ACTIVE
   * match (undo the match first) or is already IGNORED. */
  async ignoreLine(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
    lineId: string,
    dto: IgnoreBankStatementLineDto,
  ): Promise<BankStatementLine> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
      );
      this.assertOpenOrThrow(parentImport);
      const before = await this.resolveLineOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
        lineId,
        { forUpdate: true },
      );
      if (before.matchStatus === "IGNORED") {
        throw new ConflictException("This statement line is already ignored.");
      }
      if (before.matchStatus !== "UNMATCHED") {
        throw new ConflictException(
          "Only an UNMATCHED statement line can be ignored — undo any existing match first.",
        );
      }

      const [updated] = await tx
        .update(bankStatementLines)
        .set({ matchStatus: "IGNORED", updatedAt: new Date() })
        .where(eq(bankStatementLines.id, lineId))
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_statement_line",
        entityId: lineId,
        beforeState: {
          ...before,
          reason: dto.reason ?? null,
        } as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** `POST /bank-statement-imports/:id/lines/:lineId/create-bank-transaction`
   * (§10, Decision 6) — pre-fills type/amountMinor/transactionDate/
   * bankCashAccountId from the line and calls the existing, unmodified
   * `BankTransactionsService.create()`. The result is an ordinary DRAFT
   * bank transaction; posting is a separate, explicit
   * `POST /bank-transactions/:id/post` call the caller must make
   * itself. `acknowledgeDuplicationWarning` is enforced by the DTO
   * itself (required `true`) — the possible-AP/AR/manual-journal-
   * duplication warning (§10) is surfaced in this method's own doc
   * comment and DTO validation message, not a runtime string the
   * caller must parse. */
  async createBankTransactionFromLine(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
    lineId: string,
    dto: CreateBankTransactionFromLineDto,
  ): Promise<BankTransaction> {
    // resolveLineOrThrow scopes/validates the line via withTenant itself
    // (BankTransactionsService.create() opens its own withTenant
    // transaction) — deliberately NOT nested inside this service's own
    // withTenant call, since BankTransactionsService.create() must run
    // as its own top-level, unmodified call (§10 — this service never
    // reimplements or wraps Banking-1b's own transactional boundary).
    const line = await withTenant(tenantId, async (tx: TxClient) => {
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
      );
      this.assertOpenOrThrow(parentImport);
      return this.resolveLineOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
        lineId,
      );
    });

    const createDto: CreateBankTransactionDto = {
      type: dto.type,
      transactionDate: line.lineDate,
      amountMinor: line.amountMinor,
      bankCashAccountId: line.bankCashAccountId,
      glAccountId: dto.glAccountId,
      reference: dto.reference ?? line.externalReference ?? undefined,
      memo:
        dto.memo ??
        (line.rawDescription
          ? `Created from bank statement line (import ${importId}): ${line.rawDescription}`
          : `Created from bank statement line (import ${importId}).`),
    };

    return this.bankTransactions.create(
      tenantId,
      legalEntityId,
      actorUserId,
      createDto,
    );
  }

  // -------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------

  async listMatches(
    tenantId: string,
    legalEntityId: string,
    importId: string,
  ): Promise<BankReconciliationMatch[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.resolveImportOrThrow(tx, tenantId, legalEntityId, importId);
      const lineIds = (
        await tx
          .select({ id: bankStatementLines.id })
          .from(bankStatementLines)
          .where(eq(bankStatementLines.statementImportId, importId))
      ).map((r) => r.id);
      if (lineIds.length === 0) return [];
      return tx
        .select()
        .from(bankReconciliationMatches)
        .where(
          and(
            eq(bankReconciliationMatches.tenantId, tenantId),
            eq(bankReconciliationMatches.legalEntityId, legalEntityId),
            inArray(bankReconciliationMatches.statementLineId, lineIds),
          ),
        );
    });
  }

  /** `POST /bank-statement-imports/:id/matches` (§8/§9) — creates a
   * match, MANUAL (default) or DETERMINISTIC_MATCH. A DETERMINISTIC_MATCH
   * request is independently re-verified against the deterministic rule
   * (same account/amount/direction, date within tolerance, exactly one
   * qualifying candidate) — never trusted from client input alone (§8's
   * "every suggestion is reproducible from the same inputs"). Rejects
   * over-allocation on EITHER side (§8, hard reject) before the row is
   * inserted. Recomputes and persists both the statement line's
   * `matchStatus` cache (bank_transactions has no equivalent column —
   * derived only, §9). */
  async createMatch(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
    dto: CreateBankReconciliationMatchDto,
  ): Promise<BankReconciliationMatch> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
      );
      this.assertOpenOrThrow(parentImport);

      const line = await this.resolveLineOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
        dto.statementLineId,
        { forUpdate: true },
      );
      if (line.matchStatus === "IGNORED") {
        throw new ConflictException(
          "Cannot match an IGNORED statement line — undo the ignore state is not supported; this line was explicitly determined to need no counterpart.",
        );
      }

      const transaction =
        await this.resolvePostedCandidateBankTransactionOrThrow(
          tx,
          tenantId,
          legalEntityId,
          dto.bankTransactionId,
          line,
        );

      const matchType = dto.matchType ?? "MANUAL";
      if (matchType === "DETERMINISTIC_MATCH") {
        const candidates = await this.deterministicCandidatesForLine(tx, line);
        const stillQualifies = candidates.some((c) => c.id === transaction.id);
        if (!stillQualifies) {
          throw new UnprocessableEntityException(
            "This pair does not satisfy the DETERMINISTIC_MATCH rule (same account, same amount, matching direction, transactionDate within tolerance) — use matchType MANUAL instead.",
          );
        }
        if (candidates.length > 1) {
          throw new UnprocessableEntityException(
            "More than one candidate satisfies the DETERMINISTIC_MATCH rule for this line — this is an ambiguous match and must be confirmed as MANUAL, not DETERMINISTIC_MATCH.",
          );
        }
        if (dto.matchedAmountMinor !== line.amountMinor) {
          throw new UnprocessableEntityException(
            "A DETERMINISTIC_MATCH is strictly 1:1 at full amount — matchedAmountMinor must equal the statement line's own amountMinor.",
          );
        }
      }

      const lineRemaining = await this.remainingAmountForStatementLine(
        tx,
        dto.statementLineId,
        line.amountMinor,
      );
      if (dto.matchedAmountMinor > lineRemaining) {
        throw new UnprocessableEntityException(
          `Over-allocation: this match would allocate ${dto.matchedAmountMinor} against a statement line with only ${lineRemaining} remaining unmatched.`,
        );
      }
      const transactionRemaining = await this.remainingAmountForBankTransaction(
        tx,
        dto.bankTransactionId,
        transaction.amountMinor,
        line.bankCashAccountId,
      );
      if (dto.matchedAmountMinor > transactionRemaining) {
        throw new UnprocessableEntityException(
          `Over-allocation: this match would allocate ${dto.matchedAmountMinor} against a bank transaction with only ${transactionRemaining} remaining unmatched.`,
        );
      }

      const [created] = await tx
        .insert(bankReconciliationMatches)
        .values({
          tenantId,
          legalEntityId,
          statementLineId: dto.statementLineId,
          bankTransactionId: dto.bankTransactionId,
          matchedAmountMinor: dto.matchedAmountMinor,
          matchType,
          matchedBy: actorUserId ?? null,
        })
        .returning();

      await this.recomputeLineMatchStatus(tx, dto.statementLineId);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "bank_reconciliation_match",
        entityId: created!.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created!;
    });
  }

  /** `POST /bank-statement-imports/:id/matches/:matchId/undo` — soft
   * undo (ACTIVE -> UNDONE), permitted only while the parent import's
   * `reconciliationStatus = OPEN` (§15's deliberate, narrow deviation
   * from zero-exception immutability — undoing a link is not an
   * accounting mutation). */
  async undoMatch(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
    matchId: string,
  ): Promise<BankReconciliationMatch> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
      );
      this.assertOpenOrThrow(parentImport);

      const rows = await tx
        .select()
        .from(bankReconciliationMatches)
        .innerJoin(
          bankStatementLines,
          eq(bankStatementLines.id, bankReconciliationMatches.statementLineId),
        )
        .where(
          and(
            eq(bankReconciliationMatches.id, matchId),
            eq(bankReconciliationMatches.tenantId, tenantId),
            eq(bankReconciliationMatches.legalEntityId, legalEntityId),
            eq(bankStatementLines.statementImportId, importId),
          ),
        )
        .for("update")
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundException(
          `No match found with id ${matchId} on this import.`,
        );
      }
      const before = rows[0]!.bank_reconciliation_matches;
      if (before.status !== "ACTIVE") {
        throw new ConflictException("This match has already been undone.");
      }

      const [updated] = await tx
        .update(bankReconciliationMatches)
        .set({
          status: "UNDONE",
          undoneBy: actorUserId ?? null,
          undoneAt: new Date(),
        })
        .where(eq(bankReconciliationMatches.id, matchId))
        .returning();

      await this.recomputeLineMatchStatus(tx, before.statementLineId);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_reconciliation_match",
        entityId: matchId,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  // -------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------

  /** `POST /bank-statement-imports/:id/complete` (§9, the amendment's
   * central correction) — requires BOTH:
   *   A. MATCHING COMPLETENESS — every statement line MATCHED or
   *      IGNORED.
   *   B. BALANCE RECONCILIATION — statementClosingBalanceMinor IS NOT
   *      NULL AND equals glBookBalance (differenceMinor = 0).
   * Neither condition alone is sufficient (§9/§17/§20 acceptance
   * criteria 11-13). Records completedBy/completedAt as an immutable
   * historical snapshot (§15) — never re-validated after the fact. */
  async complete(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
  ): Promise<BankStatementImport> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        importId,
        { forUpdate: true },
      );
      if (before.reconciliationStatus === "COMPLETED") {
        throw new ConflictException(
          "This reconciliation is already completed.",
        );
      }
      if (before.status !== "VALIDATED") {
        throw new ConflictException(
          "Only a VALIDATED import can be completed.",
        );
      }

      // Condition A — matching completeness.
      const undisposedCount = await this.countLinesNotMatchedOrIgnored(
        tx,
        importId,
      );
      if (undisposedCount > 0) {
        throw new UnprocessableEntityException(
          `Cannot complete: ${undisposedCount} statement line(s) are neither MATCHED nor IGNORED.`,
        );
      }

      // Condition B — balance reconciliation.
      if (before.closingBalanceMinor === null) {
        throw new UnprocessableEntityException(
          "Cannot complete: statementClosingBalanceMinor is not set.",
        );
      }
      const glBookBalanceMinor = await this.glBookBalanceForImport(
        tx,
        tenantId,
        legalEntityId,
        before,
      );
      const differenceMinor = before.closingBalanceMinor - glBookBalanceMinor;
      if (differenceMinor !== 0) {
        throw new UnprocessableEntityException(
          `Cannot complete: statementClosingBalanceMinor (${before.closingBalanceMinor}) does not equal the GL book balance (${glBookBalanceMinor}); differenceMinor = ${differenceMinor}.`,
        );
      }

      const [updated] = await tx
        .update(bankStatementImports)
        .set({
          reconciliationStatus: "COMPLETED",
          completedBy: actorUserId ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bankStatementImports.id, importId))
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "bank_statement_import",
        entityId: importId,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private mapImportUniqueViolation(err: unknown): Error {
    if (err instanceof PostgresError && err.code === "23505") {
      return new ConflictException(
        "A byte-identical file has already been imported for this Bank/Cash Account.",
      );
    }
    return err as Error;
  }

  private async resolveActiveBankCashAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    bankCashAccountId: string,
  ): Promise<{ id: string; currencyCode: string; glAccountId: string }> {
    const rows = await tx
      .select({
        id: bankCashAccounts.id,
        currencyCode: bankCashAccounts.currencyCode,
        glAccountId: bankCashAccounts.glAccountId,
      })
      .from(bankCashAccounts)
      .where(
        and(
          eq(bankCashAccounts.id, bankCashAccountId),
          eq(bankCashAccounts.legalEntityId, legalEntityId),
          eq(bankCashAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `bankCashAccountId ${bankCashAccountId} does not refer to an active Bank/Cash Account in this legal entity.`,
      );
    }
    return rows[0]!;
  }

  private async resolveImportOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<BankStatementImport> {
    const condition = and(
      eq(bankStatementImports.id, id),
      eq(bankStatementImports.tenantId, tenantId),
      eq(bankStatementImports.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(bankStatementImports)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(bankStatementImports).where(condition).limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        `No bank statement import found with id ${id}.`,
      );
    }
    return rows[0]!;
  }

  private async resolveLineOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    importId: string,
    lineId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<BankStatementLine> {
    const condition = and(
      eq(bankStatementLines.id, lineId),
      eq(bankStatementLines.statementImportId, importId),
      eq(bankStatementLines.tenantId, tenantId),
      eq(bankStatementLines.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(bankStatementLines)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx.select().from(bankStatementLines).where(condition).limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        `No statement line found with id ${lineId} on import ${importId}.`,
      );
    }
    return rows[0]!;
  }

  private assertOpenOrThrow(parentImport: BankStatementImport): void {
    if (parentImport.reconciliationStatus !== "OPEN") {
      throw new ConflictException(
        "This action is not permitted once the reconciliation is COMPLETED.",
      );
    }
  }

  /** A POSTED bank transaction, scoped to this legal entity, that
   * belongs to the matching candidate universe for `line` — either the
   * line's own bankCashAccountId, or (for a TRANSFER) its
   * counterpartyBankCashAccountId (§8's double-leg matching). */
  private async resolvePostedCandidateBankTransactionOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    bankTransactionId: string,
    line: BankStatementLine,
  ): Promise<BankTransaction> {
    const rows = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.id, bankTransactionId),
          eq(bankTransactions.tenantId, tenantId),
          eq(bankTransactions.legalEntityId, legalEntityId),
          eq(bankTransactions.status, "POSTED"),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `bankTransactionId ${bankTransactionId} does not refer to a POSTED bank transaction in this legal entity.`,
      );
    }
    const transaction = rows[0]!;
    const inCandidateUniverse =
      transaction.bankCashAccountId === line.bankCashAccountId ||
      transaction.counterpartyBankCashAccountId === line.bankCashAccountId;
    if (!inCandidateUniverse) {
      throw new BadRequestException(
        `bankTransactionId ${bankTransactionId} is not in the matching candidate universe for this statement line's Bank/Cash Account.`,
      );
    }
    return transaction;
  }

  /** DETERMINISTIC_MATCH candidates for one statement line (§8): same
   * account context, same amount, matching direction, transactionDate
   * within the tolerance window, POSTED, positive remaining
   * (unmatched) amount. */
  private async deterministicCandidatesForLine(
    tx: TxClient,
    line: BankStatementLine,
  ): Promise<BankTransaction[]> {
    // direction on the line is from the BANK's perspective: a CREDIT
    // line (money entering the account, per the bank) matches an
    // internal DEPOSIT/INTEREST on the primary leg, or a TRANSFER whose
    // counterpartyBankCashAccountId is this line's own account (the
    // "to" leg, an inflow). A DEBIT line matches WITHDRAWAL/FEE, or a
    // TRANSFER whose bankCashAccountId is this line's own account (the
    // "from" leg, an outflow).
    const directionCondition =
      line.direction === "CREDIT"
        ? or(
            and(
              eq(bankTransactions.bankCashAccountId, line.bankCashAccountId),
              inArray(bankTransactions.type, ["DEPOSIT", "INTEREST"]),
            ),
            and(
              eq(
                bankTransactions.counterpartyBankCashAccountId,
                line.bankCashAccountId,
              ),
              eq(bankTransactions.type, "TRANSFER"),
            ),
          )
        : or(
            and(
              eq(bankTransactions.bankCashAccountId, line.bankCashAccountId),
              inArray(bankTransactions.type, ["WITHDRAWAL", "FEE"]),
            ),
            and(
              eq(bankTransactions.bankCashAccountId, line.bankCashAccountId),
              eq(bankTransactions.type, "TRANSFER"),
            ),
          );

    const [minDate, maxDate] = this.dateToleranceWindow(
      line.lineDate,
      DETERMINISTIC_MATCH_TOLERANCE_DAYS,
    );

    const rows = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.legalEntityId, line.legalEntityId),
          eq(bankTransactions.status, "POSTED"),
          eq(bankTransactions.amountMinor, line.amountMinor),
          gte(bankTransactions.transactionDate, minDate),
          lte(bankTransactions.transactionDate, maxDate),
          directionCondition,
        ),
      );

    const candidatesWithCapacity: BankTransaction[] = [];
    for (const candidate of rows) {
      const remaining = await this.remainingAmountForBankTransaction(
        tx,
        candidate.id,
        candidate.amountMinor,
        line.bankCashAccountId,
      );
      if (remaining >= line.amountMinor) {
        candidatesWithCapacity.push(candidate);
      }
    }
    return candidatesWithCapacity;
  }

  private async remainingAmountForStatementLine(
    tx: TxClient,
    statementLineId: string,
    ownAmountMinor: number,
  ): Promise<number> {
    const rows = await tx
      .select({
        matchedAmountMinor: bankReconciliationMatches.matchedAmountMinor,
      })
      .from(bankReconciliationMatches)
      .where(
        and(
          eq(bankReconciliationMatches.statementLineId, statementLineId),
          eq(bankReconciliationMatches.status, "ACTIVE"),
        ),
      );
    const allocated = rows.reduce((sum, r) => sum + r.matchedAmountMinor, 0);
    return ownAmountMinor - allocated;
  }

  /** Remaining (unallocated) amount for a bank transaction, scoped to
   * ONE leg — the Bank/Cash Account context (`legAccountId`) of the
   * statement being reconciled. Scoping by leg, not globally by
   * `bankTransactionId` alone, is required for TRANSFER's double-leg
   * matching (§8): a single TRANSFER `bank_transaction` legitimately
   * gets matched twice — once against the primary account's statement,
   * once against the counterparty account's statement — each leg
   * independently allocatable up to the transaction's own
   * `amountMinor`. Over-allocation protection still applies WITHIN each
   * leg (joins to `bank_statement_lines.bankCashAccountId` to find only
   * the ACTIVE matches belonging to this leg). For every non-TRANSFER
   * transaction there is only one leg, so behavior is unchanged. */
  private async remainingAmountForBankTransaction(
    tx: TxClient,
    bankTransactionId: string,
    ownAmountMinor: number,
    legAccountId: string,
  ): Promise<number> {
    const rows = await tx
      .select({
        matchedAmountMinor: bankReconciliationMatches.matchedAmountMinor,
      })
      .from(bankReconciliationMatches)
      .innerJoin(
        bankStatementLines,
        eq(bankReconciliationMatches.statementLineId, bankStatementLines.id),
      )
      .where(
        and(
          eq(bankReconciliationMatches.bankTransactionId, bankTransactionId),
          eq(bankReconciliationMatches.status, "ACTIVE"),
          eq(bankStatementLines.bankCashAccountId, legAccountId),
        ),
      );
    const allocated = rows.reduce((sum, r) => sum + r.matchedAmountMinor, 0);
    return ownAmountMinor - allocated;
  }

  /** Recomputes and persists `bank_statement_lines.matchStatus` from the
   * single source of truth, `bank_reconciliation_matches` (§9) — called
   * after every match create/undo affecting this line. */
  private async recomputeLineMatchStatus(
    tx: TxClient,
    statementLineId: string,
  ): Promise<void> {
    const [line] = await tx
      .select({ amountMinor: bankStatementLines.amountMinor })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.id, statementLineId))
      .limit(1);
    if (!line) return;
    const matchRows = await tx
      .select({
        matchedAmountMinor: bankReconciliationMatches.matchedAmountMinor,
      })
      .from(bankReconciliationMatches)
      .where(
        and(
          eq(bankReconciliationMatches.statementLineId, statementLineId),
          eq(bankReconciliationMatches.status, "ACTIVE"),
        ),
      );
    const allocated = matchRows.reduce(
      (sum, r) => sum + r.matchedAmountMinor,
      0,
    );
    const matchStatus =
      allocated <= 0
        ? "UNMATCHED"
        : allocated < line.amountMinor
          ? "PARTIALLY_MATCHED"
          : "MATCHED";
    await tx
      .update(bankStatementLines)
      .set({ matchStatus, updatedAt: new Date() })
      .where(eq(bankStatementLines.id, statementLineId));
  }

  private async countActiveMatchesForImport(
    tx: TxClient,
    importId: string,
  ): Promise<number> {
    const lineIds = (
      await tx
        .select({ id: bankStatementLines.id })
        .from(bankStatementLines)
        .where(eq(bankStatementLines.statementImportId, importId))
    ).map((r) => r.id);
    if (lineIds.length === 0) return 0;
    const rows = await tx
      .select({ id: bankReconciliationMatches.id })
      .from(bankReconciliationMatches)
      .where(
        and(
          inArray(bankReconciliationMatches.statementLineId, lineIds),
          eq(bankReconciliationMatches.status, "ACTIVE"),
        ),
      );
    return rows.length;
  }

  private async countLinesNotMatchedOrIgnored(
    tx: TxClient,
    importId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ id: bankStatementLines.id })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.statementImportId, importId),
          inArray(bankStatementLines.matchStatus, [
            "UNMATCHED",
            "PARTIALLY_MATCHED",
          ]),
        ),
      );
    return rows.length;
  }

  /** BOOK BALANCE (§2.13/§17) — the actual GL balance of the import's
   * Bank/Cash Account's linked GL account, as of `statementDateTo`,
   * computed the same way GeneralLedgerService.getBalance computes any
   * account balance: sign-adjusted SUM(debit) - SUM(credit) over every
   * POSTED journal_lines row for that account up to the as-of date —
   * regardless of which document (bank_transactions, supplier_payments,
   * customer_receipts, a manual Journal Entry) posted it. NEVER a sum of
   * bank_transactions. */
  private async glBookBalanceForImport(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    parentImport: BankStatementImport,
  ): Promise<number> {
    const [bankCashAccount] = await tx
      .select({ glAccountId: bankCashAccounts.glAccountId })
      .from(bankCashAccounts)
      .where(eq(bankCashAccounts.id, parentImport.bankCashAccountId))
      .limit(1);
    if (!bankCashAccount) {
      throw new NotFoundException(
        `No Bank/Cash Account found with id ${parentImport.bankCashAccountId}.`,
      );
    }
    return this.glBookBalance(
      tx,
      tenantId,
      legalEntityId,
      bankCashAccount.glAccountId,
      parentImport.statementDateTo,
    );
  }

  private async glBookBalance(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    asOf: string,
  ): Promise<number> {
    const [account] = await tx
      .select({ type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, accountId))
      .limit(1);
    if (!account) {
      throw new NotFoundException(`No GL account found with id ${accountId}.`);
    }
    const rows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(jl.debit_minor), 0) AS raw_debit,
        COALESCE(SUM(jl.credit_minor), 0) AS raw_credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId}
        AND jl.tenant_id = ${tenantId}
        AND je.tenant_id = ${tenantId}
        AND je.legal_entity_id = ${legalEntityId}
        AND je.status = 'POSTED'
        AND je.transaction_date <= ${asOf}::date
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    const sign = this.signFor(account.type);
    return sign * (rawDebit - rawCredit);
  }

  /** Duplicated from GeneralLedgerService.signFor — see this file's top
   * comment for why (cross-module-coupling convention, same as
   * financial-statements.service.ts's own duplicate). +1 for a
   * DEBIT-normal type (ASSET, EXPENSE), -1 for a CREDIT-normal type
   * (LIABILITY, EQUITY, REVENUE). */
  private signFor(type: ChartOfAccount["type"]): 1 | -1 {
    return type === "ASSET" || type === "EXPENSE" ? 1 : -1;
  }

  private async summaryFor(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    parentImport: BankStatementImport,
  ): Promise<BankStatementImportSummary> {
    const glBookBalanceMinor = await this.glBookBalanceForImport(
      tx,
      tenantId,
      legalEntityId,
      parentImport,
    );
    const differenceMinor =
      parentImport.closingBalanceMinor === null
        ? null
        : parentImport.closingBalanceMinor - glBookBalanceMinor;

    const lines = await tx
      .select({
        matchStatus: bankStatementLines.matchStatus,
      })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.statementImportId, parentImport.id));

    const totalStatementLines = lines.length;
    const matchedStatementLines = lines.filter(
      (l) => l.matchStatus === "MATCHED",
    ).length;
    const partiallyMatchedStatementLines = lines.filter(
      (l) => l.matchStatus === "PARTIALLY_MATCHED",
    ).length;
    const unmatchedStatementLines = lines.filter(
      (l) => l.matchStatus === "UNMATCHED",
    ).length;
    const ignoredStatementLines = lines.filter(
      (l) => l.matchStatus === "IGNORED",
    ).length;

    const candidateTransactions = await tx
      .select({
        id: bankTransactions.id,
        amountMinor: bankTransactions.amountMinor,
      })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.legalEntityId, legalEntityId),
          eq(bankTransactions.status, "POSTED"),
          sql`(${bankTransactions.bankCashAccountId} = ${parentImport.bankCashAccountId} OR ${bankTransactions.counterpartyBankCashAccountId} = ${parentImport.bankCashAccountId})`,
        ),
      );
    let unmatchedBankTransactionCount = 0;
    for (const t of candidateTransactions) {
      const remaining = await this.remainingAmountForBankTransaction(
        tx,
        t.id,
        t.amountMinor,
        parentImport.bankCashAccountId,
      );
      if (remaining === t.amountMinor) {
        unmatchedBankTransactionCount += 1;
      }
    }

    return {
      statementClosingBalanceMinor: parentImport.closingBalanceMinor,
      glBookBalanceMinor,
      differenceMinor,
      totalStatementLines,
      matchedStatementLines,
      partiallyMatchedStatementLines,
      unmatchedStatementLines,
      ignoredStatementLines,
      unmatchedBankTransactionCount,
    };
  }

  /** [lineDate - toleranceDays, lineDate + toleranceDays] as YYYY-MM-DD
   * strings, computed in application code from a UTC calendar date —
   * never SQL date arithmetic — same "deterministic today" posture as
   * every other date computation in this codebase
   * (GeneralLedgerService.todayUtc and its duplicates). */
  private dateToleranceWindow(
    lineDate: string,
    toleranceDays: number,
  ): [string, string] {
    const base = new Date(`${lineDate}T00:00:00Z`);
    const min = new Date(base);
    min.setUTCDate(min.getUTCDate() - toleranceDays);
    const max = new Date(base);
    max.setUTCDate(max.getUTCDate() + toleranceDays);
    return [min.toISOString().slice(0, 10), max.toISOString().slice(0, 10)];
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return typeof value === "number" ? value : Number(value);
  }

  /** `(bankCashAccountId, lineDate, direction, amountMinor,
   * externalReference-or-rawDescription)` — duplicate-line detection
   * across DIFFERENT imports (§12). */
  private lineFingerprint(
    bankCashAccountId: string,
    line: Pick<
      ParsedCsvLine,
      | "lineDate"
      | "direction"
      | "amountMinor"
      | "externalReference"
      | "rawDescription"
    >,
  ): string {
    const key = [
      bankCashAccountId,
      line.lineDate,
      line.direction,
      line.amountMinor,
      line.externalReference ?? line.rawDescription ?? "",
    ].join("|");
    return createHash("sha256").update(key).digest("hex");
  }

  // -------------------------------------------------------------------
  // CSV_GENERIC parsing (§7) — a documented, fixed contract:
  // `date,description,reference,debit,credit`. Hand-rolled, RFC4180-
  // aware (quoted fields, escaped quotes, embedded commas) — no CSV
  // library exists anywhere in this monorepo to depend on (§2.10/§2.11),
  // and the contract is small and fully under this proposal's own
  // control.
  // -------------------------------------------------------------------

  private parseCsvGeneric(content: string): CsvParseResult {
    const rawRows = this.splitCsvRows(content);
    if (rawRows.length === 0) {
      return { lines: [], errors: ["The file is empty."] };
    }

    const header = rawRows[0]!.map((h) => h.trim().toLowerCase());
    const expected = ["date", "description", "reference", "debit", "credit"];
    if (
      header.length !== expected.length ||
      !expected.every((col, i) => header[i] === col)
    ) {
      return {
        lines: [],
        errors: [
          `Header row must be exactly "${expected.join(",")}" (case-insensitive) — found "${rawRows[0]!.join(",")}".`,
        ],
      };
    }

    const errors: string[] = [];
    const lines: ParsedCsvLine[] = [];
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i]!;
      const lineNumber = i + 1; // 1-based, including the header.
      if (row.length === 1 && row[0]!.trim() === "") continue; // trailing blank line.
      if (row.length !== expected.length) {
        errors.push(
          `Line ${lineNumber}: expected ${expected.length} columns, found ${row.length}.`,
        );
        continue;
      }
      const [dateRaw, descriptionRaw, referenceRaw, debitRaw, creditRaw] = row;
      const date = dateRaw!.trim();
      if (
        !dateRegex.test(date) ||
        Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      ) {
        errors.push(
          `Line ${lineNumber}: "date" must be a valid YYYY-MM-DD date.`,
        );
        continue;
      }
      const debit = debitRaw!.trim();
      const credit = creditRaw!.trim();
      const debitPresent = debit !== "";
      const creditPresent = credit !== "";
      if (debitPresent === creditPresent) {
        errors.push(
          `Line ${lineNumber}: exactly one of "debit" or "credit" must be present (found debit="${debit}", credit="${credit}").`,
        );
        continue;
      }
      const amountStr = debitPresent ? debit : credit;
      const amountMinor = this.parseDecimalToMinorUnits(amountStr);
      if (amountMinor === null || amountMinor <= 0) {
        errors.push(
          `Line ${lineNumber}: "${debitPresent ? "debit" : "credit"}" must be a positive decimal amount (found "${amountStr}").`,
        );
        continue;
      }
      const description = descriptionRaw!.trim();
      const reference = referenceRaw!.trim();
      lines.push({
        lineNumber,
        lineDate: date,
        direction: debitPresent ? "DEBIT" : "CREDIT",
        amountMinor,
        externalReference: reference === "" ? null : reference,
        rawDescription: description === "" ? null : description,
      });
    }

    return { lines, errors };
  }

  /** Parses a decimal string (e.g. "1000.50") into integer minor units
   * (100050), assuming exactly 2 decimal places — the same minor-unit
   * convention every amountMinor column in this schema already uses. */
  private parseDecimalToMinorUnits(raw: string): number | null {
    const parts = raw.split(".");
    if (parts.length > 2) return null;
    const [wholeStr, fracStrRaw] = parts;
    if (!/^\d{1,15}$/.test(wholeStr ?? "")) return null;
    if (fracStrRaw !== undefined && !/^\d{1,2}$/.test(fracStrRaw)) return null;
    const fracStr = (fracStrRaw ?? "").padEnd(2, "0");
    const whole = Number(wholeStr);
    const frac = Number(fracStr);
    if (Number.isNaN(whole) || Number.isNaN(frac)) return null;
    return whole * 100 + frac;
  }

  /** RFC4180-aware CSV row splitter — handles double-quoted fields,
   * embedded commas/newlines inside quotes, and `""`-escaped quotes.
   * Splits on both `\n` and `\r\n` line endings. */
  private splitCsvRows(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const normalized = content.replace(/\r\n/g, "\n");
    while (i < normalized.length) {
      const ch = normalized[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (normalized[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }
}
