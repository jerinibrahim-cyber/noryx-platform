import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, auditLogs, eq, legalEntities } from "@noryx/db-core";
import { PostgresError } from "postgres";
import {
  accountingPeriods,
  budgetLines,
  budgets,
  type Budget,
} from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateBudgetDto } from "./dto/create-budget.dto";
import type { UpdateBudgetDto } from "./dto/update-budget.dto";

/**
 * Budgeting / Planning — Phase 1 Foundation (CTO-approved implementation
 * authorization, v6). docs/work-items/budgeting-phase-1-foundation/
 * CONTRACT.md §5/§10/§11.
 *
 * Every state-changing operation here (`update()`, `approve()`) takes
 * `SELECT ... FOR UPDATE` on the target `budgets` row as its FIRST
 * transactional statement, before any other check — the parent-row
 * locking pattern established by JournalEntriesService/
 * SupplierBillsService's `findByIdInTx(..., { forUpdate: true })`
 * (contract §0a/§0b/§11), extended here to cover the complete budget
 * aggregate (header + lines): `BudgetLinesService`'s create/update/
 * delete take the identical lock on the same `budgets.id` row as their
 * own first statement, so all five state-changing operations on one
 * budget serialize through one lock, in the codebase's default
 * `READ COMMITTED` isolation (no `txConfig` override — contract §11 v6).
 */
@Injectable()
export class BudgetsService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateBudgetDto,
  ): Promise<Budget> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const currencyCode = await this.resolveCurrency(
        tx,
        tenantId,
        legalEntityId,
      );

      let created: Budget;
      try {
        const [row] = await tx
          .insert(budgets)
          .values({
            tenantId,
            legalEntityId,
            code: dto.code,
            name: dto.name,
            startDate: dto.startDate,
            endDate: dto.endDate,
            currencyCode,
            createdBy: actorUserId ?? undefined,
          })
          .returning();
        created = row!;
      } catch (err) {
        // Closes the race a pre-check SELECT can't (§0a category 1 —
        // DB uniqueness constraint is the real guarantee; this is the
        // clean-error-message translation of it, identical shape to
        // AccountingPeriodsService.create()/TaxCodesService.create()).
        if (err instanceof PostgresError && err.code === "23505") {
          throw new ConflictException(
            `A budget with code "${dto.code}" already exists for this legal entity.`,
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "budget",
        entityId: created.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  async list(tenantId: string, legalEntityId: string): Promise<Budget[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      return tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.tenantId, tenantId),
            eq(budgets.legalEntityId, legalEntityId),
          ),
        );
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<Budget> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const found = await this.findByIdInTx(tx, tenantId, legalEntityId, id);
      if (!found) {
        throw new NotFoundException(`No budget found with id ${id}.`);
      }
      return found;
    });
  }

  /**
   * Header PATCH — joins the same parent-row serialization model as
   * `approve()`/line mutations (contract §0b Gap 1, CTO DECISION, v4):
   * `SELECT ... FOR UPDATE` on `budgets.id` is the first transactional
   * statement, before any other check.
   *
   * Gap 2 (contract §0b, CTO DECISION, v4): whenever `startDate` and/or
   * `endDate` is changing, every EXISTING `budget_lines` row under this
   * budget is re-validated against the PROPOSED new dates, under the
   * same lock, in the same transaction as the mutation. If any existing
   * line's period would fall outside the proposed range, the entire
   * PATCH is rejected (422) with NO mutation at all — not even to
   * unrelated fields in the same payload (contract §0b/§10, acceptance
   * BUD-053).
   */
  async update(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    dto: UpdateBudgetDto,
  ): Promise<Budget> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // (1) Acquire the parent-row lock FIRST, before any other check —
      // contract §0b Gap 1 / §11.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No budget found with id ${id}.`);
      }
      // (2) Already-APPROVED budgets are immutable at the application
      // layer (contract §10, BUD-006).
      if (before.status !== "DRAFT") {
        throw new ConflictException(
          "Cannot edit a budget that is already APPROVED.",
        );
      }

      const proposedStartDate = dto.startDate ?? before.startDate;
      const proposedEndDate = dto.endDate ?? before.endDate;
      const datesChanging =
        dto.startDate !== undefined || dto.endDate !== undefined;

      if (datesChanging) {
        if (
          new Date(proposedEndDate).getTime() <=
          new Date(proposedStartDate).getTime()
        ) {
          throw new UnprocessableEntityException(
            "endDate must be after startDate.",
          );
        }

        // (3) Gap 2 re-validation — every EXISTING line under this
        // budget, checked against the PROPOSED (not current) dates,
        // still under the lock acquired in step (1). Zero rows queried
        // is the trivial/success case (no lines yet, or a widening
        // change — contract §5's "does not need to special-case
        // widening" note).
        const existingLinesWithPeriods = await tx
          .select({
            lineId: budgetLines.id,
            periodStart: accountingPeriods.startDate,
            periodEnd: accountingPeriods.endDate,
          })
          .from(budgetLines)
          .innerJoin(
            accountingPeriods,
            eq(budgetLines.periodId, accountingPeriods.id),
          )
          .where(
            and(
              eq(budgetLines.budgetId, id),
              eq(budgetLines.tenantId, tenantId),
            ),
          );

        const violating = existingLinesWithPeriods.filter(
          (line) =>
            line.periodStart < proposedStartDate ||
            line.periodEnd > proposedEndDate,
        );

        if (violating.length > 0) {
          // (3a) Reject the WHOLE patch — no partial mutation, not even
          // to unrelated fields (contract §0b Gap 2, CTO DECISION —
          // 422). ROLLBACK happens implicitly: nothing has been
          // written yet.
          throw new UnprocessableEntityException(
            `Proposed date range would invalidate ${violating.length} existing budget line(s) whose accounting period would fall outside the new dates.`,
          );
        }
      }

      const headerPatch: Partial<typeof budgets.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.name !== undefined) headerPatch.name = dto.name;
      if (dto.startDate !== undefined) headerPatch.startDate = dto.startDate;
      if (dto.endDate !== undefined) headerPatch.endDate = dto.endDate;

      // (5) Mutation, still holding the lock from step (1).
      await tx
        .update(budgets)
        .set(headerPatch)
        .where(
          and(
            eq(budgets.id, id),
            eq(budgets.tenantId, tenantId),
            eq(budgets.legalEntityId, legalEntityId),
          ),
        );

      const after = await this.findByIdInTx(tx, tenantId, legalEntityId, id);

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "UPDATE",
        entityType: "budget",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: after as unknown as Record<string, unknown>,
      });

      // (6) COMMIT — releases the lock (implicit, transaction end).
      return after!;
    });
  }

  /**
   * `approve()` — the corrected (contract §0a) parent-row-lock design:
   * `SELECT ... FOR UPDATE` on the parent `budgets` row is the FIRST
   * transactional statement, before any check — this, not the `EXISTS`
   * check below by itself, is what closes the approve-vs-final-line-
   * delete race (contract §11, BUD-051).
   */
  async approve(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<Budget> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // (1) Lock first.
      const before = await this.findByIdInTx(tx, tenantId, legalEntityId, id, {
        forUpdate: true,
      });
      if (!before) {
        throw new NotFoundException(`No budget found with id ${id}.`);
      }
      // (3) status != 'DRAFT' -> 409 (already APPROVED — BUD-009).
      if (before.status !== "DRAFT") {
        throw new ConflictException("This budget is already APPROVED.");
      }

      // (4) CTO Decision B — an APPROVED budget must contain >=1 line.
      // Re-read under the lock held since step (1), never a snapshot
      // taken before it (BUD-046). A plain existence check (not a
      // COUNT) is sufficient and cheaper — the invariant only needs
      // ">= 1", never the exact number.
      const oneLine = await tx
        .select({ id: budgetLines.id })
        .from(budgetLines)
        .where(eq(budgetLines.budgetId, id))
        .limit(1);
      if (oneLine.length === 0) {
        throw new UnprocessableEntityException(
          "Cannot approve a budget with zero lines.",
        );
      }

      const [updated] = await tx
        .update(budgets)
        .set({
          status: "APPROVED",
          approvedAt: new Date(),
          approvedBy: actorUserId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(budgets.id, id),
            eq(budgets.tenantId, tenantId),
            eq(budgets.legalEntityId, legalEntityId),
          ),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "APPROVE",
        entityType: "budget",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }

  /** Scoped by (id, tenantId, legalEntityId) — RLS already restricts to
   * the caller's tenant, but this additionally stops a direct-by-id
   * lookup from leaking a budget belonging to a different legal entity
   * within the same tenant (same convention as AccountingPeriodsService/
   * JournalEntriesService's own findByIdInTx).
   *
   * `options.forUpdate` acquires `SELECT ... FOR UPDATE` on the row —
   * used by every mutating operation (`update`, `approve`, and — via the
   * identical pattern in BudgetLinesService — every line mutation) as
   * their first statement (contract §0a/§0b/§11). Plain reads
   * (`findOne`, the "after" snapshot inside `update()`) never lock. */
  async findByIdInTx(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Budget | undefined> {
    const condition = and(
      eq(budgets.id, id),
      eq(budgets.tenantId, tenantId),
      eq(budgets.legalEntityId, legalEntityId),
    );
    const rows = options.forUpdate
      ? await tx.select().from(budgets).where(condition).for("update").limit(1)
      : await tx.select().from(budgets).where(condition).limit(1);
    return rows[0];
  }

  /** Resolves the caller's legal entity's functional currency — never
   * client-supplied. Identical query/reasoning to
   * SupplierBillsService.resolveCurrency/JournalEntriesService.resolveCurrency,
   * duplicated locally (private to this class, same repo-wide pattern). */
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
