import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, auditLogs, eq, gte, inArray, lte, sql } from "@noryx/db-core";
import { PostgresError } from "postgres";
import {
  bankCashAccounts,
  bankStatementLines,
  chartOfAccounts,
  paymentProviderSettlementImports,
  paymentProviderSettlements,
  paymentSettlementMatches,
  type BankStatementLine,
  type BankTransaction,
  type ChartOfAccount,
  type PaymentProviderSettlement,
  type PaymentProviderSettlementImport,
  type PaymentSettlementMatch,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { BankTransactionsService } from "../bank-transactions/bank-transactions.service";
import type { CreateBankTransactionDto } from "../bank-transactions/dto/create-bank-transaction.dto";
import type { ImportPaymentProviderSettlementDto } from "./dto/import-payment-provider-settlement.dto";
import type { ListPaymentProviderSettlementImportsQueryDto } from "./dto/list-payment-provider-settlement-imports.query.dto";
import type { ListPaymentProviderSettlementsQueryDto } from "./dto/list-payment-provider-settlements.query.dto";
import type { CreatePaymentSettlementMatchDto } from "./dto/create-payment-settlement-match.dto";
import type { CreateSettlementTransactionsDto } from "./dto/create-settlement-transactions.dto";
import type { ClearingReconciliationQueryDto } from "./dto/clearing-reconciliation-query.dto";

/** Deterministic-match tolerance window (§10, mirrors Banking-1c's own
 * DETERMINISTIC_MATCH_TOLERANCE_DAYS exactly — no per-tenant
 * configuration surface exists to extend it). */
const DETERMINISTIC_MATCH_TOLERANCE_DAYS = 3;

export interface PaymentProviderSettlementImportSummary {
  /** Balance block (§16/§18) — never collapsed with the matching block. */
  providerSettlementTotalMinor: number;
  clearingAccountGlMovementMinor: number;
  differenceMinor: number;
  /** Matching-completeness block (§18) — always reported separately. */
  totalSettlements: number;
  matchedSettlements: number;
  partiallyMatchedSettlements: number;
  unmatchedSettlements: number;
  ignoredSettlements: number;
}

export interface PaymentProviderSettlementImportWithSummary extends PaymentProviderSettlementImport {
  summary: PaymentProviderSettlementImportSummary;
}

export interface ClearingReconciliationResult {
  bankCashAccountId: string;
  dateFrom: string | null;
  dateTo: string;
  /** A claim FROM the provider — never GL-authoritative (§20). */
  providerSettlementTotalMinor: number;
  /** The Clearing Account's own GL movement over the same window,
   * computed locally, journal_lines-derived (§13/§20) — the SAME
   * authority every other Banking report in this codebase uses. Never
   * merged with providerSettlementTotalMinor above. */
  clearingAccountGlMovementMinor: number;
  differenceMinor: number;
}

interface ParsedSettlementRow {
  rowNumber: number; // 1-based, including the header row, for error messages.
  providerSettlementId: string;
  settlementDate: string;
  grossAmountMinor: number;
  feeAmountMinor: number;
  adjustmentAmountMinor: number;
  netAmountMinor: number;
  rawDescription: string | null;
}

interface CsvParseResult {
  rows: ParsedSettlementRow[];
  errors: string[];
}

/**
 * Payment Provider Settlement Import & Reconciliation — Banking-1e
 * (docs/finance-work-item-banking-1e-proposal.md, CTO-approved —
 * implementation-authorization turn).
 *
 * This service owns matching/linking/import state ONLY (§6, §18) — it
 * never inserts into journal_entries/journal_lines directly, and never
 * calls JournalEntriesService. The one write it makes against
 * bank_transactions is via the existing, unmodified
 * BankTransactionsService.create() (create-settlement-transactions,
 * §19) — this service never mutates bank_transactions/bank_cash_accounts
 * any other way, and never touches bank_statement_lines/
 * bank_statement_imports/bank_reconciliation_matches (Banking-1c,
 * unmodified) beyond an additive FK reference from its own
 * payment_settlement_matches table.
 *
 * CLEARING ACCOUNT GL MOVEMENT (glMovementForAccount below) is the
 * actual GL movement of the Clearing Account's linked GL account over a
 * date window — computed the same way GeneralLedgerService.getBalance
 * computes any account balance, duplicated locally rather than importing
 * GeneralLedgerService or BankReportsService, the same
 * cross-module-coupling convention every other report in this codebase
 * already follows (BankReconciliationService's own glBookBalance,
 * ar-reports.service.ts's glAssetBalance). It is NEVER a sum of
 * payment_provider_settlements (§20, BLOCKER-equivalent to Banking-1c's
 * own §17 correction).
 *
 * Same withTenant()/explicit-legalEntityId-predicate shape as every
 * other Finance service.
 */
@Injectable()
export class PaymentProviderSettlementsService {
  constructor(private readonly bankTransactions: BankTransactionsService) {}

  // -------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------

  /** `POST /payment-provider-settlement-imports` — synchronous
   * GENERIC_SETTLEMENT_CSV parse + validate + persist (§14). A malformed
   * file, an internally-inconsistent row (gross - fee + adjustment !=
   * net), or a duplicate providerSettlementId (within the file OR
   * against an already-persisted settlement for this account) produces
   * a FAILED import header with `parseErrors` populated and ZERO
   * settlement records persisted (§16 item 1, §33 acceptance criteria
   * 2/4) — never a partial import, never a silent auto-correction of
   * the provider's own numbers. */
  async importSettlements(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: ImportPaymentProviderSettlementDto,
    fileBuffer: Buffer,
    uploadedFileName: string,
  ): Promise<PaymentProviderSettlementImport> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const clearingAccount = await this.resolveActiveClearingAccountOrThrow(
        tx,
        legalEntityId,
        dto.bankCashAccountId,
      );

      const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

      // Friendly pre-check for ppsi_account_file_hash_unique — the DB
      // UNIQUE constraint is the race closer (same "friendly check + DB
      // constraint" pattern as every other idempotency guard in this
      // codebase).
      const existing = await tx
        .select({ id: paymentProviderSettlementImports.id })
        .from(paymentProviderSettlementImports)
        .where(
          and(
            eq(paymentProviderSettlementImports.tenantId, tenantId),
            eq(paymentProviderSettlementImports.legalEntityId, legalEntityId),
            eq(
              paymentProviderSettlementImports.bankCashAccountId,
              dto.bankCashAccountId,
            ),
            eq(paymentProviderSettlementImports.fileHash, fileHash),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          "A byte-identical file has already been imported for this Clearing Account.",
        );
      }

      const fileName = dto.fileName ?? uploadedFileName;
      const providerFormat = dto.providerFormat ?? "GENERIC_SETTLEMENT_CSV";

      const parsed = this.parseGenericSettlementCsv(
        fileBuffer.toString("utf-8"),
      );

      // §15 — the deterministic identity key check, performed BEFORE any
      // insert so a duplicate settlement ID (within this file, or
      // against one already persisted for this account) produces the
      // identical "FAILED import, zero records persisted" outcome as a
      // syntax/arithmetic error (§16 item 1's "reject outright" posture,
      // applied consistently).
      const errors = [...parsed.errors];
      const seenInFile = new Map<string, number>(); // providerSettlementId -> first rowNumber.
      for (const row of parsed.rows) {
        const firstRow = seenInFile.get(row.providerSettlementId);
        if (firstRow !== undefined) {
          errors.push(
            `Row ${row.rowNumber}: providerSettlementId "${row.providerSettlementId}" duplicates row ${firstRow} within this same file.`,
          );
        } else {
          seenInFile.set(row.providerSettlementId, row.rowNumber);
        }
      }
      if (parsed.rows.length > 0) {
        const providerSettlementIds = [...seenInFile.keys()];
        const alreadyPersisted = await tx
          .select({
            providerSettlementId:
              paymentProviderSettlements.providerSettlementId,
          })
          .from(paymentProviderSettlements)
          .where(
            and(
              eq(paymentProviderSettlements.tenantId, tenantId),
              eq(paymentProviderSettlements.legalEntityId, legalEntityId),
              eq(
                paymentProviderSettlements.bankCashAccountId,
                dto.bankCashAccountId,
              ),
              inArray(
                paymentProviderSettlements.providerSettlementId,
                providerSettlementIds,
              ),
            ),
          );
        const alreadyPersistedIds = new Set(
          alreadyPersisted.map((r) => r.providerSettlementId),
        );
        for (const row of parsed.rows) {
          if (alreadyPersistedIds.has(row.providerSettlementId)) {
            errors.push(
              `Row ${row.rowNumber}: providerSettlementId "${row.providerSettlementId}" already exists for this Clearing Account (from a previous import).`,
            );
          }
        }
      }

      if (errors.length > 0) {
        let created: PaymentProviderSettlementImport;
        try {
          const [row] = await tx
            .insert(paymentProviderSettlementImports)
            .values({
              tenantId,
              legalEntityId,
              bankCashAccountId: dto.bankCashAccountId,
              providerFormat,
              fileName,
              fileHash,
              status: "FAILED",
              parseErrors: errors,
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
          entityType: "payment_provider_settlement_import",
          entityId: created.id,
          beforeState: null,
          afterState: {
            ...created,
            settlementCount: 0,
            parseErrors: errors,
          } as unknown as Record<string, unknown>,
        });

        return created;
      }

      let created: PaymentProviderSettlementImport;
      try {
        const [row] = await tx
          .insert(paymentProviderSettlementImports)
          .values({
            tenantId,
            legalEntityId,
            bankCashAccountId: dto.bankCashAccountId,
            providerFormat,
            fileName,
            fileHash,
            status: "VALIDATED",
            importedBy: actorUserId ?? null,
          })
          .returning();
        created = row!;
      } catch (err) {
        throw this.mapImportUniqueViolation(err);
      }

      let insertedSettlements: PaymentProviderSettlement[] = [];
      try {
        insertedSettlements =
          parsed.rows.length > 0
            ? await tx
                .insert(paymentProviderSettlements)
                .values(
                  parsed.rows.map((r) => ({
                    tenantId,
                    legalEntityId,
                    settlementImportId: created.id,
                    bankCashAccountId: dto.bankCashAccountId,
                    providerSettlementId: r.providerSettlementId,
                    settlementDate: r.settlementDate,
                    currencyCode: clearingAccount.currencyCode,
                    grossAmountMinor: r.grossAmountMinor,
                    feeAmountMinor: r.feeAmountMinor,
                    adjustmentAmountMinor: r.adjustmentAmountMinor,
                    netAmountMinor: r.netAmountMinor,
                    rawDescription: r.rawDescription,
                  })),
                )
                .returning()
            : [];
      } catch (err) {
        // Race closer for pps_account_provider_settlement_id_unique — the
        // friendly pre-check above cannot see a concurrent import's
        // not-yet-committed rows.
        throw this.mapImportUniqueViolation(err);
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "payment_provider_settlement_import",
        entityId: created.id,
        beforeState: null,
        afterState: {
          ...created,
          settlementCount: insertedSettlements.length,
        } as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    filters: ListPaymentProviderSettlementImportsQueryDto,
  ): Promise<PaymentProviderSettlementImport[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(paymentProviderSettlementImports.tenantId, tenantId),
        eq(paymentProviderSettlementImports.legalEntityId, legalEntityId),
      ];
      if (filters.bankCashAccountId) {
        conditions.push(
          eq(
            paymentProviderSettlementImports.bankCashAccountId,
            filters.bankCashAccountId,
          ),
        );
      }
      if (filters.status) {
        conditions.push(
          eq(paymentProviderSettlementImports.status, filters.status),
        );
      }
      if (filters.reconciliationStatus) {
        conditions.push(
          eq(
            paymentProviderSettlementImports.reconciliationStatus,
            filters.reconciliationStatus,
          ),
        );
      }
      return tx
        .select()
        .from(paymentProviderSettlementImports)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<PaymentProviderSettlementImportWithSummary> {
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

  /** `DELETE /payment-provider-settlement-imports/:id` — permitted only
   * while `status IN (PENDING, FAILED)` AND `reconciliationStatus =
   * OPEN` AND zero ACTIVE matches (§18/§29 Rule 12) — mirrors
   * BankReconciliationService.remove() exactly. A VALIDATED import
   * (settlement records exist) is never deletable through this endpoint
   * — re-importing after correcting a source file is the intended path. */
  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<PaymentProviderSettlementImport> {
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
          "Cannot delete a VALIDATED payment provider settlement import — its settlement records are part of the reconciliation record. Delete is only permitted for a PENDING or FAILED import.",
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
          "Cannot delete a payment provider settlement import with active matches.",
        );
      }

      await tx
        .delete(paymentProviderSettlements)
        .where(eq(paymentProviderSettlements.settlementImportId, id));
      await tx
        .delete(paymentProviderSettlementImports)
        .where(
          and(
            eq(paymentProviderSettlementImports.id, id),
            eq(paymentProviderSettlementImports.tenantId, tenantId),
            eq(paymentProviderSettlementImports.legalEntityId, legalEntityId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "payment_provider_settlement_import",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  // -------------------------------------------------------------------
  // Settlement records
  // -------------------------------------------------------------------

  async listSettlements(
    tenantId: string,
    legalEntityId: string,
    importId: string,
    filters: ListPaymentProviderSettlementsQueryDto,
  ): Promise<PaymentProviderSettlement[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.resolveImportOrThrow(tx, tenantId, legalEntityId, importId);
      const conditions = [
        eq(paymentProviderSettlements.settlementImportId, importId),
        eq(paymentProviderSettlements.tenantId, tenantId),
        eq(paymentProviderSettlements.legalEntityId, legalEntityId),
      ];
      if (filters.matchStatus) {
        conditions.push(
          eq(paymentProviderSettlements.matchStatus, filters.matchStatus),
        );
      }
      return tx
        .select()
        .from(paymentProviderSettlements)
        .where(and(...conditions));
    });
  }

  /** `GET /payment-provider-settlements/:id/suggestions` —
   * `DETERMINISTIC_MATCH`-tier candidates, computed at read time, never
   * persisted until confirmed (§10, mirrors
   * BankReconciliationService.suggestionsForLine exactly). Returns every
   * `bank_statement_lines` row (ANY Bank/Cash Account in this legal
   * entity — not pre-scoped to the settlement's own Clearing Account,
   * since the net settlement amount lands in a DIFFERENT, real Bank/Cash
   * Account discovered by the match itself, §6) satisfying: `direction
   * = CREDIT`, `amountMinor = netAmountMinor`, `lineDate` within the
   * tolerance window of `settlementDate`, and positive remaining
   * (settlement-side-unmatched) capacity. `ambiguous: true` whenever
   * more than one candidate qualifies. */
  async suggestionsForSettlement(
    tenantId: string,
    legalEntityId: string,
    settlementId: string,
  ): Promise<{ candidates: BankStatementLine[]; ambiguous: boolean }> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const settlement = await this.resolveSettlementOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlementId,
      );
      const candidates = await this.deterministicCandidatesForSettlement(
        tx,
        settlement,
      );
      return { candidates, ambiguous: candidates.length > 1 };
    });
  }

  // -------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------

  async listMatches(
    tenantId: string,
    legalEntityId: string,
    settlementId: string,
  ): Promise<PaymentSettlementMatch[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      await this.resolveSettlementOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlementId,
      );
      return tx
        .select()
        .from(paymentSettlementMatches)
        .where(
          and(
            eq(paymentSettlementMatches.tenantId, tenantId),
            eq(paymentSettlementMatches.legalEntityId, legalEntityId),
            eq(
              paymentSettlementMatches.paymentProviderSettlementId,
              settlementId,
            ),
          ),
        );
    });
  }

  /** `POST /payment-provider-settlements/:id/match` (§10) — creates a
   * match, MANUAL (default) or DETERMINISTIC_MATCH, mirroring
   * BankReconciliationService.createMatch exactly. A DETERMINISTIC_MATCH
   * request is independently re-verified against the deterministic rule
   * — never trusted from client input alone. Rejects over-allocation on
   * EITHER side before the row is inserted. Recomputes and persists the
   * settlement's own `matchStatus` cache. */
  async createMatch(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    settlementId: string,
    dto: CreatePaymentSettlementMatchDto,
  ): Promise<PaymentSettlementMatch> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const settlement = await this.resolveSettlementOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlementId,
        { forUpdate: true },
      );
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlement.settlementImportId,
      );
      this.assertOpenOrThrow(parentImport);

      const line = await this.resolvePaymentBankStatementLineOrThrow(
        tx,
        tenantId,
        legalEntityId,
        dto.bankStatementLineId,
      );
      if (line.direction !== "CREDIT") {
        throw new BadRequestException(
          "Only a CREDIT (money entering the account) bank statement line can be matched to a settlement — a settlement's net proceeds are always a bank credit.",
        );
      }

      const matchType = dto.matchType ?? "MANUAL";
      if (matchType === "DETERMINISTIC_MATCH") {
        const candidates = await this.deterministicCandidatesForSettlement(
          tx,
          settlement,
        );
        const stillQualifies = candidates.some((c) => c.id === line.id);
        if (!stillQualifies) {
          throw new UnprocessableEntityException(
            "This pair does not satisfy the DETERMINISTIC_MATCH rule (netAmountMinor equals the line's amountMinor, CREDIT direction, settlementDate within tolerance) — use matchType MANUAL instead.",
          );
        }
        if (candidates.length > 1) {
          throw new UnprocessableEntityException(
            "More than one candidate satisfies the DETERMINISTIC_MATCH rule for this settlement — this is an ambiguous match and must be confirmed as MANUAL, not DETERMINISTIC_MATCH.",
          );
        }
        if (dto.matchedAmountMinor !== settlement.netAmountMinor) {
          throw new UnprocessableEntityException(
            "A DETERMINISTIC_MATCH is strictly 1:1 at full amount — matchedAmountMinor must equal the settlement's own netAmountMinor.",
          );
        }
      }

      const settlementRemaining = await this.remainingAmountForSettlement(
        tx,
        settlementId,
        settlement.netAmountMinor,
      );
      if (dto.matchedAmountMinor > settlementRemaining) {
        throw new UnprocessableEntityException(
          `Over-allocation: this match would allocate ${dto.matchedAmountMinor} against a settlement with only ${settlementRemaining} remaining unmatched.`,
        );
      }
      const lineRemaining = await this.remainingAmountForBankStatementLine(
        tx,
        dto.bankStatementLineId,
        line.amountMinor,
      );
      if (dto.matchedAmountMinor > lineRemaining) {
        throw new UnprocessableEntityException(
          `Over-allocation: this match would allocate ${dto.matchedAmountMinor} against a bank statement line with only ${lineRemaining} remaining unmatched (settlement-side).`,
        );
      }

      const [created] = await tx
        .insert(paymentSettlementMatches)
        .values({
          tenantId,
          legalEntityId,
          paymentProviderSettlementId: settlementId,
          bankStatementLineId: dto.bankStatementLineId,
          matchedAmountMinor: dto.matchedAmountMinor,
          matchType,
          matchedBy: actorUserId ?? null,
        })
        .returning();

      await this.recomputeSettlementMatchStatus(tx, settlementId);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "payment_settlement_match",
        entityId: created!.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created!;
    });
  }

  /** `POST /payment-provider-settlements/:id/matches/:matchId/undo` —
   * soft undo (ACTIVE -> UNDONE), permitted only while the parent
   * import's `reconciliationStatus = OPEN` — identical deliberate,
   * narrow deviation from zero-exception immutability as
   * BankReconciliationService.undoMatch (§18, undoing a link is not an
   * accounting mutation). */
  async undoMatch(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    settlementId: string,
    matchId: string,
  ): Promise<PaymentSettlementMatch> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const settlement = await this.resolveSettlementOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlementId,
      );
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlement.settlementImportId,
      );
      this.assertOpenOrThrow(parentImport);

      const rows = await tx
        .select()
        .from(paymentSettlementMatches)
        .where(
          and(
            eq(paymentSettlementMatches.id, matchId),
            eq(paymentSettlementMatches.tenantId, tenantId),
            eq(paymentSettlementMatches.legalEntityId, legalEntityId),
            eq(
              paymentSettlementMatches.paymentProviderSettlementId,
              settlementId,
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundException(
          `No match found with id ${matchId} on this settlement.`,
        );
      }
      const before = rows[0]!;
      if (before.status !== "ACTIVE") {
        throw new ConflictException("This match has already been undone.");
      }

      const [updated] = await tx
        .update(paymentSettlementMatches)
        .set({
          status: "UNDONE",
          undoneBy: actorUserId ?? null,
          undoneAt: new Date(),
        })
        .where(eq(paymentSettlementMatches.id, matchId))
        .returning();

      await this.recomputeSettlementMatchStatus(tx, settlementId);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "payment_settlement_match",
        entityId: matchId,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  // -------------------------------------------------------------------
  // Posting-adjacent convenience (§19) — never posts.
  // -------------------------------------------------------------------

  /** `POST /payment-provider-settlements/:id/create-settlement-transactions`
   * (§19, Open CTO Decision 3) — pre-fills TWO DRAFT `bank_transactions`
   * from one settlement record: a TRANSFER (Clearing Account -> the real
   * Bank/Cash Account the caller selects, amountMinor = netAmountMinor)
   * and, when feeAmountMinor > 0, a FEE (Clearing Account -> the EXPENSE
   * account the caller selects, amountMinor = feeAmountMinor). Both are
   * created via the EXISTING, UNMODIFIED BankTransactionsService.create()
   * — the identical mechanism Banking-1c's own create-from-line
   * convenience already calls. NEITHER is posted by this action — the
   * caller still issues two separate, explicit `POST
   * /bank-transactions/:id/post` calls. adjustmentAmountMinor, when
   * nonzero, is NOT auto-converted into a third transaction (§6) — the
   * user handles it manually. */
  async createSettlementTransactions(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    settlementId: string,
    dto: CreateSettlementTransactionsDto,
  ): Promise<BankTransaction[]> {
    // resolveSettlementOrThrow scopes/validates the settlement via
    // withTenant itself (BankTransactionsService.create() opens its own
    // withTenant transaction) — deliberately NOT nested inside this
    // service's own withTenant call, mirroring
    // BankReconciliationService.createBankTransactionFromLine's own
    // documented reasoning: BankTransactionsService.create() must run as
    // its own top-level, unmodified call, never wrapped in this
    // service's own transactional boundary.
    const settlement = await withTenant(tenantId, async (tx: TxClient) => {
      const s = await this.resolveSettlementOrThrow(
        tx,
        tenantId,
        legalEntityId,
        settlementId,
      );
      const parentImport = await this.resolveImportOrThrow(
        tx,
        tenantId,
        legalEntityId,
        s.settlementImportId,
      );
      this.assertOpenOrThrow(parentImport);
      return s;
    });

    if (dto.feeGlAccountId === undefined && settlement.feeAmountMinor > 0) {
      throw new BadRequestException(
        "feeGlAccountId is required when the settlement's feeAmountMinor is greater than 0.",
      );
    }
    if (dto.destinationBankCashAccountId === settlement.bankCashAccountId) {
      throw new BadRequestException(
        "destinationBankCashAccountId must refer to a different Bank/Cash Account than the settlement's own Clearing Account.",
      );
    }

    const transactionDate = dto.transactionDate ?? settlement.settlementDate;
    const created: BankTransaction[] = [];

    // TRANSFER — Dr Bank (real) / Cr Clearing (§6): bankCashAccountId is
    // the "from" leg (credited), counterpartyBankCashAccountId is the
    // "to" leg (debited) — bank-transactions.service.ts's own posting
    // convention ("Destination Dr / Source Cr").
    const transferDto: CreateBankTransactionDto = {
      type: "TRANSFER",
      transactionDate,
      amountMinor: settlement.netAmountMinor,
      bankCashAccountId: settlement.bankCashAccountId,
      counterpartyBankCashAccountId: dto.destinationBankCashAccountId,
      reference:
        dto.reference ?? `Settlement ${settlement.providerSettlementId}`,
      memo: `Settlement transfer for provider settlement ${settlement.providerSettlementId} (import ${settlement.settlementImportId}).`,
    };
    created.push(
      await this.bankTransactions.create(
        tenantId,
        legalEntityId,
        actorUserId,
        transferDto,
      ),
    );

    if (settlement.feeAmountMinor > 0) {
      const feeDto: CreateBankTransactionDto = {
        type: "FEE",
        transactionDate,
        amountMinor: settlement.feeAmountMinor,
        bankCashAccountId: settlement.bankCashAccountId,
        glAccountId: dto.feeGlAccountId!,
        reference:
          dto.reference ?? `Settlement ${settlement.providerSettlementId}`,
        memo: `Gateway fee for provider settlement ${settlement.providerSettlementId} (import ${settlement.settlementImportId}).`,
      };
      created.push(
        await this.bankTransactions.create(
          tenantId,
          legalEntityId,
          actorUserId,
          feeDto,
        ),
      );
    }

    return created;
  }

  // -------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------

  /** `POST /payment-provider-settlement-imports/:id/complete` (§18) —
   * requires BOTH:
   *   A. MATCHING COMPLETENESS — every settlement record for this import
   *      is MATCHED or IGNORED.
   *   B. BALANCE RECONCILIATION — Σ(this import's own settlements'
   *      netAmountMinor) equals the Clearing Account's real GL movement
   *      over the date window spanned by those settlements
   *      (differenceMinor = 0).
   * Neither condition alone is sufficient — identical two-condition
   * shape to Banking-1c's own reconciliation completion (§9 of that
   * proposal). Records completedBy/completedAt as an immutable
   * historical snapshot — never re-validated after the fact. */
  async complete(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    importId: string,
  ): Promise<PaymentProviderSettlementImport> {
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
      const undisposedCount = await this.countSettlementsNotMatchedOrIgnored(
        tx,
        importId,
      );
      if (undisposedCount > 0) {
        throw new UnprocessableEntityException(
          `Cannot complete: ${undisposedCount} settlement record(s) are neither MATCHED nor IGNORED.`,
        );
      }

      // Condition B — balance reconciliation.
      const { differenceMinor } = await this.differenceForImport(
        tx,
        tenantId,
        legalEntityId,
        before,
      );
      if (differenceMinor !== 0) {
        throw new UnprocessableEntityException(
          `Cannot complete: the provider settlement total does not equal the Clearing Account's GL movement for this import's period; differenceMinor = ${differenceMinor}.`,
        );
      }

      const [updated] = await tx
        .update(paymentProviderSettlementImports)
        .set({
          reconciliationStatus: "COMPLETED",
          completedBy: actorUserId ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(paymentProviderSettlementImports.id, importId))
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "payment_provider_settlement_import",
        entityId: importId,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  // -------------------------------------------------------------------
  // Reporting (§20)
  // -------------------------------------------------------------------

  /** `GET /payment-provider-settlements/clearing-reconciliation` — the
   * ONLY report this domain ships in MVP beyond plain listing (§20/§26).
   * Two figures, never merged: PROVIDER SETTLEMENT TOTAL (a claim FROM
   * the provider) vs CLEARING ACCOUNT GL MOVEMENT (GL-derived, computed
   * locally — never payment_provider_settlements-derived). An omitted
   * `dateFrom` computes GL movement from inception (mirrors
   * BankCashAccountStatementQueryDto's own convention) — the same as an
   * as-of GL balance. */
  async clearingReconciliation(
    tenantId: string,
    legalEntityId: string,
    query: ClearingReconciliationQueryDto,
  ): Promise<ClearingReconciliationResult> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const clearingAccount = await this.resolveActiveClearingAccountOrThrow(
        tx,
        legalEntityId,
        query.bankCashAccountId,
      );
      const dateTo = query.dateTo ?? new Date().toISOString().slice(0, 10);
      const dateFrom = query.dateFrom ?? null;

      const settlementRows = await tx
        .select({ netAmountMinor: paymentProviderSettlements.netAmountMinor })
        .from(paymentProviderSettlements)
        .where(
          and(
            eq(paymentProviderSettlements.tenantId, tenantId),
            eq(paymentProviderSettlements.legalEntityId, legalEntityId),
            eq(
              paymentProviderSettlements.bankCashAccountId,
              query.bankCashAccountId,
            ),
            dateFrom
              ? gte(paymentProviderSettlements.settlementDate, dateFrom)
              : sql`TRUE`,
            lte(paymentProviderSettlements.settlementDate, dateTo),
          ),
        );
      const providerSettlementTotalMinor = settlementRows.reduce(
        (sum, r) => sum + r.netAmountMinor,
        0,
      );

      const clearingAccountGlMovementMinor = await this.glMovementForAccount(
        tx,
        tenantId,
        legalEntityId,
        clearingAccount.glAccountId,
        dateFrom,
        dateTo,
      );

      return {
        bankCashAccountId: query.bankCashAccountId,
        dateFrom,
        dateTo,
        providerSettlementTotalMinor,
        clearingAccountGlMovementMinor,
        differenceMinor:
          providerSettlementTotalMinor - clearingAccountGlMovementMinor,
      };
    });
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private mapImportUniqueViolation(err: unknown): Error {
    if (err instanceof PostgresError && err.code === "23505") {
      if (err.constraint_name === "ppsi_account_file_hash_unique") {
        return new ConflictException(
          "A byte-identical file has already been imported for this Clearing Account.",
        );
      }
      return new ConflictException(
        "One or more providerSettlementId values in this file already exist for this Clearing Account.",
      );
    }
    return err as Error;
  }

  /** §7 — validates/requires `purpose = 'CLEARING'` on the target
   * account explicitly, rejecting an OPERATING account rather than
   * silently importing settlement data against it. A direct field
   * check, never an inference from an import FK's existence. */
  private async resolveActiveClearingAccountOrThrow(
    tx: TxClient,
    legalEntityId: string,
    bankCashAccountId: string,
  ): Promise<{
    id: string;
    currencyCode: string;
    glAccountId: string;
    purpose: string;
  }> {
    const rows = await tx
      .select({
        id: bankCashAccounts.id,
        currencyCode: bankCashAccounts.currencyCode,
        glAccountId: bankCashAccounts.glAccountId,
        purpose: bankCashAccounts.purpose,
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
    const account = rows[0]!;
    if (account.purpose !== "CLEARING") {
      throw new BadRequestException(
        `bankCashAccountId ${bankCashAccountId} has purpose = ${account.purpose}, not CLEARING — payment provider settlements may only be imported against a Clearing Account (§7).`,
      );
    }
    return account;
  }

  private async resolveImportOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<PaymentProviderSettlementImport> {
    const condition = and(
      eq(paymentProviderSettlementImports.id, id),
      eq(paymentProviderSettlementImports.tenantId, tenantId),
      eq(paymentProviderSettlementImports.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(paymentProviderSettlementImports)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx
          .select()
          .from(paymentProviderSettlementImports)
          .where(condition)
          .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        `No payment provider settlement import found with id ${id}.`,
      );
    }
    return rows[0]!;
  }

  private async resolveSettlementOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<PaymentProviderSettlement> {
    const condition = and(
      eq(paymentProviderSettlements.id, id),
      eq(paymentProviderSettlements.tenantId, tenantId),
      eq(paymentProviderSettlements.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx
          .select()
          .from(paymentProviderSettlements)
          .where(condition)
          .for("update")
          .limit(1)
      : await tx
          .select()
          .from(paymentProviderSettlements)
          .where(condition)
          .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        `No payment provider settlement found with id ${id}.`,
      );
    }
    return rows[0]!;
  }

  private async resolvePaymentBankStatementLineOrThrow(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    lineId: string,
  ): Promise<BankStatementLine> {
    const rows = await tx
      .select()
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.id, lineId),
          eq(bankStatementLines.tenantId, tenantId),
          eq(bankStatementLines.legalEntityId, legalEntityId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(
        `bankStatementLineId ${lineId} does not refer to a bank statement line in this legal entity.`,
      );
    }
    return rows[0]!;
  }

  private assertOpenOrThrow(
    parentImport: PaymentProviderSettlementImport,
  ): void {
    if (parentImport.reconciliationStatus !== "OPEN") {
      throw new ConflictException(
        "This action is not permitted once the reconciliation is COMPLETED.",
      );
    }
  }

  /** DETERMINISTIC_MATCH candidates for one settlement (§10): a CREDIT
   * bank statement line, ANY Bank/Cash Account in this legal entity,
   * same amount as the settlement's netAmountMinor, lineDate within the
   * tolerance window of settlementDate, positive remaining
   * (settlement-side) capacity. */
  private async deterministicCandidatesForSettlement(
    tx: TxClient,
    settlement: PaymentProviderSettlement,
  ): Promise<BankStatementLine[]> {
    const [minDate, maxDate] = this.dateToleranceWindow(
      settlement.settlementDate,
      DETERMINISTIC_MATCH_TOLERANCE_DAYS,
    );

    const rows = await tx
      .select()
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.legalEntityId, settlement.legalEntityId),
          eq(bankStatementLines.direction, "CREDIT"),
          eq(bankStatementLines.amountMinor, settlement.netAmountMinor),
          gte(bankStatementLines.lineDate, minDate),
          lte(bankStatementLines.lineDate, maxDate),
        ),
      );

    const candidatesWithCapacity: BankStatementLine[] = [];
    for (const candidate of rows) {
      const remaining = await this.remainingAmountForBankStatementLine(
        tx,
        candidate.id,
        candidate.amountMinor,
      );
      if (remaining >= settlement.netAmountMinor) {
        candidatesWithCapacity.push(candidate);
      }
    }
    return candidatesWithCapacity;
  }

  private async remainingAmountForSettlement(
    tx: TxClient,
    settlementId: string,
    ownAmountMinor: number,
  ): Promise<number> {
    const rows = await tx
      .select({
        matchedAmountMinor: paymentSettlementMatches.matchedAmountMinor,
      })
      .from(paymentSettlementMatches)
      .where(
        and(
          eq(
            paymentSettlementMatches.paymentProviderSettlementId,
            settlementId,
          ),
          eq(paymentSettlementMatches.status, "ACTIVE"),
        ),
      );
    const allocated = rows.reduce((sum, r) => sum + r.matchedAmountMinor, 0);
    return ownAmountMinor - allocated;
  }

  /** Remaining (unallocated) amount for a bank statement line, scoped to
   * THIS domain's own payment_settlement_matches only — never summed
   * together with Banking-1c's own bank_reconciliation_matches, a
   * structurally separate reconciliation relationship against the same
   * line (§10, §29 Rule 4: this domain does not duplicate Banking-1c's
   * own bank-side matching, it reuses the SAME line as its bank side —
   * the two match tables' allocations are independent by design). */
  private async remainingAmountForBankStatementLine(
    tx: TxClient,
    bankStatementLineId: string,
    ownAmountMinor: number,
  ): Promise<number> {
    const rows = await tx
      .select({
        matchedAmountMinor: paymentSettlementMatches.matchedAmountMinor,
      })
      .from(paymentSettlementMatches)
      .where(
        and(
          eq(paymentSettlementMatches.bankStatementLineId, bankStatementLineId),
          eq(paymentSettlementMatches.status, "ACTIVE"),
        ),
      );
    const allocated = rows.reduce((sum, r) => sum + r.matchedAmountMinor, 0);
    return ownAmountMinor - allocated;
  }

  /** Recomputes and persists `payment_provider_settlements.matchStatus`
   * from the single source of truth, `payment_settlement_matches` —
   * called after every match create/undo affecting this settlement. */
  private async recomputeSettlementMatchStatus(
    tx: TxClient,
    settlementId: string,
  ): Promise<void> {
    const [settlement] = await tx
      .select({ netAmountMinor: paymentProviderSettlements.netAmountMinor })
      .from(paymentProviderSettlements)
      .where(eq(paymentProviderSettlements.id, settlementId))
      .limit(1);
    if (!settlement) return;
    const matchRows = await tx
      .select({
        matchedAmountMinor: paymentSettlementMatches.matchedAmountMinor,
      })
      .from(paymentSettlementMatches)
      .where(
        and(
          eq(
            paymentSettlementMatches.paymentProviderSettlementId,
            settlementId,
          ),
          eq(paymentSettlementMatches.status, "ACTIVE"),
        ),
      );
    const allocated = matchRows.reduce(
      (sum, r) => sum + r.matchedAmountMinor,
      0,
    );
    const matchStatus =
      allocated <= 0
        ? "UNMATCHED"
        : allocated < settlement.netAmountMinor
          ? "PARTIALLY_MATCHED"
          : "MATCHED";
    await tx
      .update(paymentProviderSettlements)
      .set({ matchStatus, updatedAt: new Date() })
      .where(eq(paymentProviderSettlements.id, settlementId));
  }

  private async countActiveMatchesForImport(
    tx: TxClient,
    importId: string,
  ): Promise<number> {
    const settlementIds = (
      await tx
        .select({ id: paymentProviderSettlements.id })
        .from(paymentProviderSettlements)
        .where(eq(paymentProviderSettlements.settlementImportId, importId))
    ).map((r) => r.id);
    if (settlementIds.length === 0) return 0;
    const rows = await tx
      .select({ id: paymentSettlementMatches.id })
      .from(paymentSettlementMatches)
      .where(
        and(
          inArray(
            paymentSettlementMatches.paymentProviderSettlementId,
            settlementIds,
          ),
          eq(paymentSettlementMatches.status, "ACTIVE"),
        ),
      );
    return rows.length;
  }

  private async countSettlementsNotMatchedOrIgnored(
    tx: TxClient,
    importId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ id: paymentProviderSettlements.id })
      .from(paymentProviderSettlements)
      .where(
        and(
          eq(paymentProviderSettlements.settlementImportId, importId),
          inArray(paymentProviderSettlements.matchStatus, [
            "UNMATCHED",
            "PARTIALLY_MATCHED",
          ]),
        ),
      );
    return rows.length;
  }

  /** §18 condition B — Σ(this import's own settlements' netAmountMinor)
   * vs the Clearing Account's real GL movement over the date window
   * spanned by those settlements (MIN(settlementDate)..MAX(settlementDate);
   * an import with zero settlement records trivially reconciles as
   * 0 == 0 over its own importedAt date). */
  private async differenceForImport(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    parentImport: PaymentProviderSettlementImport,
  ): Promise<{
    providerSettlementTotalMinor: number;
    glMovementMinor: number;
    differenceMinor: number;
  }> {
    const settlementRows = await tx
      .select({
        netAmountMinor: paymentProviderSettlements.netAmountMinor,
        settlementDate: paymentProviderSettlements.settlementDate,
      })
      .from(paymentProviderSettlements)
      .where(
        eq(paymentProviderSettlements.settlementImportId, parentImport.id),
      );

    const providerSettlementTotalMinor = settlementRows.reduce(
      (sum, r) => sum + r.netAmountMinor,
      0,
    );

    let dateFrom: string;
    let dateTo: string;
    if (settlementRows.length === 0) {
      const importedDate = parentImport.importedAt.toISOString().slice(0, 10);
      dateFrom = importedDate;
      dateTo = importedDate;
    } else {
      const dates = settlementRows.map((r) => r.settlementDate).sort();
      dateFrom = dates[0]!;
      dateTo = dates[dates.length - 1]!;
    }

    const [clearingAccount] = await tx
      .select({ glAccountId: bankCashAccounts.glAccountId })
      .from(bankCashAccounts)
      .where(eq(bankCashAccounts.id, parentImport.bankCashAccountId))
      .limit(1);
    if (!clearingAccount) {
      throw new NotFoundException(
        `No Bank/Cash Account found with id ${parentImport.bankCashAccountId}.`,
      );
    }

    const glMovementMinor = await this.glMovementForAccount(
      tx,
      tenantId,
      legalEntityId,
      clearingAccount.glAccountId,
      dateFrom,
      dateTo,
    );

    return {
      providerSettlementTotalMinor,
      glMovementMinor,
      differenceMinor: providerSettlementTotalMinor - glMovementMinor,
    };
  }

  /** GL MOVEMENT — the actual GL movement of `accountId` over
   * `[dateFrom, dateTo]` (inclusive; `dateFrom = null` means "from
   * inception"), computed the same way GeneralLedgerService.getBalance
   * computes any account balance/movement: sign-adjusted SUM(debit) -
   * SUM(credit) over every POSTED journal_lines row for that account in
   * the window — regardless of which document (bank_transactions,
   * supplier_payments, customer_receipts, a manual Journal Entry) posted
   * it. NEVER a sum of payment_provider_settlements. */
  private async glMovementForAccount(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    accountId: string,
    dateFrom: string | null,
    dateTo: string,
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
        AND je.transaction_date <= ${dateTo}::date
        AND (${dateFrom}::date IS NULL OR je.transaction_date >= ${dateFrom}::date)
    `)) as unknown as Array<{ raw_debit: unknown; raw_credit: unknown }>;
    const rawDebit = this.toNumber(rows[0]?.raw_debit);
    const rawCredit = this.toNumber(rows[0]?.raw_credit);
    const sign = this.signFor(account.type);
    return sign * (rawDebit - rawCredit);
  }

  /** Duplicated from GeneralLedgerService.signFor — see this file's top
   * comment for why (cross-module-coupling convention). +1 for a
   * DEBIT-normal type (ASSET, EXPENSE), -1 for a CREDIT-normal type
   * (LIABILITY, EQUITY, REVENUE). */
  private signFor(type: ChartOfAccount["type"]): 1 | -1 {
    return type === "ASSET" || type === "EXPENSE" ? 1 : -1;
  }

  private async summaryFor(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    parentImport: PaymentProviderSettlementImport,
  ): Promise<PaymentProviderSettlementImportSummary> {
    const { providerSettlementTotalMinor, glMovementMinor, differenceMinor } =
      await this.differenceForImport(tx, tenantId, legalEntityId, parentImport);

    const settlements = await tx
      .select({ matchStatus: paymentProviderSettlements.matchStatus })
      .from(paymentProviderSettlements)
      .where(
        eq(paymentProviderSettlements.settlementImportId, parentImport.id),
      );

    return {
      providerSettlementTotalMinor,
      clearingAccountGlMovementMinor: glMovementMinor,
      differenceMinor,
      totalSettlements: settlements.length,
      matchedSettlements: settlements.filter((s) => s.matchStatus === "MATCHED")
        .length,
      partiallyMatchedSettlements: settlements.filter(
        (s) => s.matchStatus === "PARTIALLY_MATCHED",
      ).length,
      unmatchedSettlements: settlements.filter(
        (s) => s.matchStatus === "UNMATCHED",
      ).length,
      ignoredSettlements: settlements.filter((s) => s.matchStatus === "IGNORED")
        .length,
    };
  }

  private dateToleranceWindow(
    settlementDate: string,
    toleranceDays: number,
  ): [string, string] {
    const base = new Date(`${settlementDate}T00:00:00Z`);
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

  // -------------------------------------------------------------------
  // GENERIC_SETTLEMENT_CSV parsing (§14) — a documented, fixed contract:
  // `settlement_id,settlement_date,gross_amount,fee_amount,
  // adjustment_amount,net_amount,description`. Hand-rolled, RFC4180-
  // aware, mirroring BankReconciliationService's own
  // parseCsvGeneric/splitCsvRows/parseDecimalToMinorUnits exactly (no
  // CSV library exists anywhere in this monorepo to depend on) —
  // duplicated locally rather than imported, since bank-reconciliation
  // .service.ts does not export these as a shared utility (this
  // codebase's established cross-module-coupling-by-duplication
  // convention, same reasoning as glMovementForAccount/glBookBalance
  // above).
  // -------------------------------------------------------------------

  private parseGenericSettlementCsv(content: string): CsvParseResult {
    const rawRows = this.splitCsvRows(content);
    if (rawRows.length === 0) {
      return { rows: [], errors: ["The file is empty."] };
    }

    const header = rawRows[0]!.map((h) => h.trim().toLowerCase());
    const expected = [
      "settlement_id",
      "settlement_date",
      "gross_amount",
      "fee_amount",
      "adjustment_amount",
      "net_amount",
      "description",
    ];
    if (
      header.length !== expected.length ||
      !expected.every((col, i) => header[i] === col)
    ) {
      return {
        rows: [],
        errors: [
          `Header row must be exactly "${expected.join(",")}" (case-insensitive) — found "${rawRows[0]!.join(",")}".`,
        ],
      };
    }

    const errors: string[] = [];
    const rows: ParsedSettlementRow[] = [];
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i]!;
      const rowNumber = i + 1; // 1-based, including the header.
      if (row.length === 1 && row[0]!.trim() === "") continue; // trailing blank line.
      if (row.length !== expected.length) {
        errors.push(
          `Row ${rowNumber}: expected ${expected.length} columns, found ${row.length}.`,
        );
        continue;
      }
      const [
        settlementIdRaw,
        settlementDateRaw,
        grossRaw,
        feeRaw,
        adjustmentRaw,
        netRaw,
        descriptionRaw,
      ] = row;

      const settlementId = settlementIdRaw!.trim();
      if (settlementId === "") {
        errors.push(`Row ${rowNumber}: "settlement_id" must not be empty.`);
        continue;
      }
      const settlementDate = settlementDateRaw!.trim();
      if (
        !dateRegex.test(settlementDate) ||
        Number.isNaN(Date.parse(`${settlementDate}T00:00:00Z`))
      ) {
        errors.push(
          `Row ${rowNumber}: "settlement_date" must be a valid YYYY-MM-DD date.`,
        );
        continue;
      }

      const grossAmountMinor = this.parseDecimalToMinorUnits(grossRaw!.trim());
      if (grossAmountMinor === null || grossAmountMinor <= 0) {
        errors.push(
          `Row ${rowNumber}: "gross_amount" must be a positive decimal amount (found "${grossRaw}").`,
        );
        continue;
      }
      // fee_amount/adjustment_amount may be blank, meaning 0.
      const feeRawTrimmed = feeRaw!.trim();
      const feeAmountMinor =
        feeRawTrimmed === "" ? 0 : this.parseDecimalToMinorUnits(feeRawTrimmed);
      if (feeAmountMinor === null || feeAmountMinor < 0) {
        errors.push(
          `Row ${rowNumber}: "fee_amount" must be a non-negative decimal amount (found "${feeRaw}").`,
        );
        continue;
      }
      const adjustmentRawTrimmed = adjustmentRaw!.trim();
      const adjustmentAmountMinor =
        adjustmentRawTrimmed === ""
          ? 0
          : this.parseSignedDecimalToMinorUnits(adjustmentRawTrimmed);
      if (adjustmentAmountMinor === null) {
        errors.push(
          `Row ${rowNumber}: "adjustment_amount" must be a decimal amount, optionally signed (found "${adjustmentRaw}").`,
        );
        continue;
      }
      const netAmountMinor = this.parseSignedDecimalToMinorUnits(
        netRaw!.trim(),
      );
      if (netAmountMinor === null) {
        errors.push(
          `Row ${rowNumber}: "net_amount" must be a decimal amount (found "${netRaw}").`,
        );
        continue;
      }

      const computedNet =
        grossAmountMinor - feeAmountMinor + adjustmentAmountMinor;
      if (computedNet !== netAmountMinor) {
        errors.push(
          `Row ${rowNumber}: arithmetic mismatch — gross_amount (${grossAmountMinor}) - fee_amount (${feeAmountMinor}) + adjustment_amount (${adjustmentAmountMinor}) = ${computedNet}, which does not equal the declared net_amount (${netAmountMinor}).`,
        );
        continue;
      }

      const description = descriptionRaw!.trim();
      rows.push({
        rowNumber,
        providerSettlementId: settlementId,
        settlementDate,
        grossAmountMinor,
        feeAmountMinor,
        adjustmentAmountMinor,
        netAmountMinor,
        rawDescription: description === "" ? null : description,
      });
    }

    return { rows, errors };
  }

  /** Parses a decimal string (e.g. "1000.50") into integer minor units
   * (100050), assuming exactly 2 decimal places — the same minor-unit
   * convention every amountMinor column in this schema already uses.
   * Rejects a leading sign (use parseSignedDecimalToMinorUnits for a
   * column that may legitimately be negative). */
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

  /** Same as parseDecimalToMinorUnits, but accepts an optional leading
   * "-" — adjustment_amount/net_amount may legitimately be negative
   * (§9's "signed adjustment" field). */
  private parseSignedDecimalToMinorUnits(raw: string): number | null {
    const negative = raw.startsWith("-");
    const unsigned = negative ? raw.slice(1) : raw;
    const value = this.parseDecimalToMinorUnits(unsigned);
    if (value === null) return null;
    return negative ? -value : value;
  }

  /** RFC4180-aware CSV row splitter — identical to
   * BankReconciliationService's own splitCsvRows. */
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
