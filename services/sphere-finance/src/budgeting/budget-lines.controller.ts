import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { BudgetLinesService } from "./budget-lines.service";
import { CreateBudgetLineDto } from "./dto/create-budget-line.dto";
import { UpdateBudgetLineDto } from "./dto/update-budget-line.dto";

/**
 * Budgeting / Planning — Phase 1 Foundation, budget line routes,
 * nested under their parent budget (`/budgets/:budgetId/lines`) —
 * mirrors how a child is meaningless without its parent elsewhere in
 * this repo (contract §5/§7). Line create/update/delete are
 * `finance.poster` + `finance.admin` (the same transactional-write
 * split as every other line-level mutation in this repo, e.g.
 * SupplierBillsController's line handling, distinct from the header's
 * finance.admin-only governance actions). GET is open to every
 * finance.* role.
 */
@Controller("budgets/:budgetId/lines")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BudgetLinesController {
  constructor(private readonly lines: BudgetLinesService) {}

  @Post()
  @Roles("finance.poster", "finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("budgetId") budgetId: string,
    @Body() dto: CreateBudgetLineDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budget lines require",
    );
    return this.lines.create(
      tenantId,
      legalEntityId,
      user.userId,
      budgetId,
      dto,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("budgetId") budgetId: string,
    @Query("accountId") accountId?: string,
    @Query("periodId") periodId?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budget lines require",
    );
    return this.lines.list(tenantId, legalEntityId, budgetId, {
      accountId,
      periodId,
    });
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("budgetId") budgetId: string,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budget lines require",
    );
    return this.lines.findOne(tenantId, legalEntityId, budgetId, id);
  }

  @Patch(":id")
  @Roles("finance.poster", "finance.admin")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("budgetId") budgetId: string,
    @Param("id") id: string,
    @Body() dto: UpdateBudgetLineDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budget lines require",
    );
    return this.lines.update(
      tenantId,
      legalEntityId,
      user.userId,
      budgetId,
      id,
      dto,
    );
  }

  @Delete(":id")
  @Roles("finance.poster", "finance.admin")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("budgetId") budgetId: string,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budget lines require",
    );
    return this.lines.remove(
      tenantId,
      legalEntityId,
      user.userId,
      budgetId,
      id,
    );
  }
}
