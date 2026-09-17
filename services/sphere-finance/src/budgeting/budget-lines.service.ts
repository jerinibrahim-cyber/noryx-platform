import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, auditLogs, eq } from "@noryx/db-core";
import { PostgresError } from "postgres";
import {
  accountingPeriods,
  budgetLines,
  chartOfAccounts,
  type BudgetLine,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { BudgetsService } from "./budgets.service";
import type { CreateBudgetLineDto } from "./dto/create-budget-line.dto";
import type { UpdateBudgetLineDto } from "./dto/update-budget-line.dto";

/**
 * Budgeting / Planning — Phase 1 Foundation, budget line CRUD
 * (CTO-approved implementation authorization, v6). docs/work-items/
 * budgeting-phase-1-foundation/CONTRACT.md §5/§10/§11.
 *
 * `create()`, `update()`, `delete()` each take `SELECT ... FOR UPDATE`
 * on the PARENT `budgets` row — not on the `budget_lines` row itself —
 * as their first transactional statement, via
 * `BudgetsService.findByIdInTx(..., { forUpdate: true })`. This is the
 * identical lock, on the identical row, that `BudgetsService.approve()`/
 * `update()` also acquire first: all five state-changing operations on
 * one budget aggregate serialize through this single parent-row lock
 * (contract §0a/§0b/§11).
 */
@Injectable()
export class BudgetLinesService {
  constructor(private readonly budgetsService: BudgetsService) {}

  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    budgetId: string,
    dto: CreateBudgetLineDto,
  ): Promise<BudgetLine> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // (1) Lock the PARENT budget row first, before any other check —
      // contract §0a/§11: the parent row is the serialization point for
      // the whole aggregate, not just for BudgetsService's own methods.
      const budget = await this.budgetsService.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        { forUpdate: true },
      );
      if (!budget) {
        throw new NotFoundException(`No budget found with id ${budgetId}.`);
      }
      // (2) Parent must be DRAFT (BUD-024).
      if (budget.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot add a line to a budget that is already APPROVED.",
        );
      }

      // (3) account_id must exist, be active, and belong to this legal
      // entity (BUD-021) — same validation shape as
      // SupplierBillsService.findInvalidAccountIds.
      const [account] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, dto.accountId),
            eq(chartOfAccounts.tenantId, tenantId),
            eq(chartOfAccounts.legalEntityId, legalEntityId),
            eq(chartOfAccounts.isActive, true),
          ),
        )
        .limit(1);
      if (!account) {
        throw new UnprocessableEntityException(
          `accountId ${dto.accountId} is not an active account in this legal entity.`,
        );
      }

      // (4) period_id must exist and belong to this legal entity
      // (BUD-022).
      const [period] = await tx
        .select({
          id: accountingPeriods.id,
          startDate: accountingPeriods.startDate,
          endDate: accountingPeriods.endDate,
        })
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.id, dto.periodId),
            eq(accountingPeriods.tenantId, tenantId),
            eq(accountingPeriods.legalEntityId, legalEntityId),
          ),
        )
        .limit(1);
      if (!period) {
        throw new UnprocessableEntityException(
          `periodId ${dto.periodId} is not a valid accounting period in this legal entity.`,
        );
      }

      // (5) CTO Decision C — period alignment: the period's complete
      // date range must fall within the budget's own dates (BUD-047,
      // BUD-048, BUD-049) — 400, not 422: this is a malformed
      // combination of otherwise-valid input values, not a conflict
      // with existing related data.
      if (
        period.startDate < budget.startDate ||
        period.endDate > budget.endDate
      ) {
        // CTO Decision C (contract §5/§10) — 400, not 422: a malformed
        // combination of otherwise-valid input values, distinct from
        // the 422s used elsewhere for "valid request, but conflicts
        // with existing related data" (BUD-046, header-PATCH Gap 2).
        throw new BadRequestException(
          `Accounting period ${dto.periodId} (${period.startDate}..${period.endDate}) is not fully contained within budget ${budgetId}'s dates (${budget.startDate}..${budget.endDate}).`,
        );
      }

      let created: BudgetLine;
      try {
        const [row] = await tx
          .insert(budgetLines)
          .values({
            tenantId,
            legalEntityId,
            budgetId,
            accountId: dto.accountId,
            periodId: dto.periodId,
            amountMinor: dto.amountMinor,
          })
          .returning();
        created = row!;
      } catch (err) {
        // (6) Duplicate (budget_id, account_id, period_id) — DB
        // uniqueness constraint is the real guarantee (BUD-025,
        // CONC-002); the lock from step (1) additionally fully
        // serializes two concurrent create() calls for the same
        // budget, so the SECOND insert is deterministically the one
        // that loses to the unique index, never a nondeterministic
        // race between two uncommitted inserts (contract §11's
        // "strengthens, not replaces" note).
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            `A budget line for account ${dto.accountId} / period ${dto.periodId} already exists on this budget.`,
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "budget_line",
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
    budgetId: string,
    filters: { accountId?: string; periodId?: string } = {},
  ): Promise<BudgetLine[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const conditions = [
        eq(budgetLines.tenantId, tenantId),
        eq(budgetLines.legalEntityId, legalEntityId),
        eq(budgetLines.budgetId, budgetId),
      ];
      if (filters.accountId) {
        conditions.push(eq(budgetLines.accountId, filters.accountId));
      }
      if (filters.periodId) {
        conditions.push(eq(budgetLines.periodId, filters.periodId));
      }
      return tx
        .select()
        .from(budgetLines)
        .where(and(...conditions));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    budgetId: string,
    id: string,
  ): Promise<BudgetLine> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        id,
      );
      if (!found) {
        throw new NotFoundException(`No budget line found with id ${id}.`);
      }
      return found;
    });
  }

  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    budgetId: string,
    id: string,
    dto: UpdateBudgetLineDto,
  ): Promise<BudgetLine> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // (1) Lock the PARENT budget row first — identical mechanism to
      // create()/delete() and to BudgetsService.approve()/update().
      const budget = await this.budgetsService.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        { forUpdate: true },
      );
      if (!budget) {
        throw new NotFoundException(`No budget found with id ${budgetId}.`);
      }
      if (budget.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot edit a line on a budget that is already APPROVED.",
        );
      }

      const before = await this.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        id,
      );
      if (!before) {
        throw new NotFoundException(`No budget line found with id ${id}.`);
      }

      const proposedAccountId = dto.accountId ?? before.accountId;
      const proposedPeriodId = dto.periodId ?? before.periodId;
      const proposedAmountMinor = dto.amountMinor ?? before.amountMinor;

      if (dto.accountId !== undefined) {
        const [account] = await tx
          .select({ id: chartOfAccounts.id })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.id, proposedAccountId),
              eq(chartOfAccounts.tenantId, tenantId),
              eq(chartOfAccounts.legalEntityId, legalEntityId),
              eq(chartOfAccounts.isActive, true),
            ),
          )
          .limit(1);
        if (!account) {
          throw new UnprocessableEntityException(
            `accountId ${proposedAccountId} is not an active account in this legal entity.`,
          );
        }
      }

      if (dto.periodId !== undefined) {
        const [period] = await tx
          .select({
            id: accountingPeriods.id,
            startDate: accountingPeriods.startDate,
            endDate: accountingPeriods.endDate,
          })
          .from(accountingPeriods)
          .where(
            and(
              eq(accountingPeriods.id, proposedPeriodId),
              eq(accountingPeriods.tenantId, tenantId),
              eq(accountingPeriods.legalEntityId, legalEntityId),
            ),
          )
          .limit(1);
        if (!period) {
          throw new UnprocessableEntityException(
            `periodId ${proposedPeriodId} is not a valid accounting period in this legal entity.`,
          );
        }
        if (
          period.startDate < budget.startDate ||
          period.endDate > budget.endDate
        ) {
          throw new BadRequestException(
            `Accounting period ${proposedPeriodId} (${period.startDate}..${period.endDate}) is not fully contained within budget ${budgetId}'s dates (${budget.startDate}..${budget.endDate}).`,
          );
        }
      }

      let updated: BudgetLine;
      try {
        const [row] = await tx
          .update(budgetLines)
          .set({
            accountId: proposedAccountId,
            periodId: proposedPeriodId,
            amountMinor: proposedAmountMinor,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(budgetLines.id, id),
              eq(budgetLines.tenantId, tenantId),
              eq(budgetLines.legalEntityId, legalEntityId),
              eq(budgetLines.budgetId, budgetId),
            ),
          )
          .returning();
        updated = row!;
      } catch (err) {
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            `A budget line for account ${proposedAccountId} / period ${proposedPeriodId} already exists on this budget.`,
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "budget_line",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated;
    });
  }

  async remove(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    budgetId: string,
    id: string,
  ): Promise<BudgetLine> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // (1) Lock the PARENT budget row first — this is precisely the
      // mechanism that closes the approve()-vs-final-line-delete race
      // (contract §11 Case A/B, BUD-051): a concurrent approve() on the
      // SAME budget cannot interleave with this delete because both
      // take the same lock on the same row as their first statement.
      const budget = await this.budgetsService.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        { forUpdate: true },
      );
      if (!budget) {
        throw new NotFoundException(`No budget found with id ${budgetId}.`);
      }
      if (budget.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot delete a line from a budget that is already APPROVED.",
        );
      }

      const before = await this.findByIdInTx(
        tx,
        tenantId,
        legalEntityId,
        budgetId,
        id,
      );
      if (!before) {
        throw new NotFoundException(`No budget line found with id ${id}.`);
      }

      await tx
        .delete(budgetLines)
        .where(
          and(
            eq(budgetLines.id, id),
            eq(budgetLines.tenantId, tenantId),
            eq(budgetLines.legalEntityId, legalEntityId),
            eq(budgetLines.budgetId, budgetId),
          ),
        );

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "DELETE",
        entityType: "budget_line",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: null,
      });

      return before;
    });
  }

  /** Scoped by (id, tenantId, legalEntityId, budgetId) — same
   * defense-in-depth convention as BudgetsService.findByIdInTx: RLS
   * already restricts to the caller's tenant, but this additionally
   * stops a direct-by-id lookup from leaking a line belonging to a
   * different legal entity or a different budget. Never locks — locking
   * for line mutations is always taken on the PARENT budgets row via
   * BudgetsService.findByIdInTx, never on this table. */
  private async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    budgetId: string,
    id: string,
  ): Promise<BudgetLine | undefined> {
    const rows = await tx
      .select()
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.id, id),
          eq(budgetLines.tenantId, tenantId),
          eq(budgetLines.legalEntityId, legalEntityId),
          eq(budgetLines.budgetId, budgetId),
        ),
      )
      .limit(1);
    return rows[0];
  }
}
