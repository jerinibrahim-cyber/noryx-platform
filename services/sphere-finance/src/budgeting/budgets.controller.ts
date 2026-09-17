import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { BudgetsService } from "./budgets.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";

/**
 * Budgeting / Planning — Phase 1 Foundation, budget header routes
 * (CTO-approved implementation authorization, v6, contract §7/§9).
 * Create/update/approve are `finance.admin`-only — mirrors
 * AccountingPeriodsController's create/close split (a budget approval
 * is a governance action, same class as a period close). GET is open to
 * every finance.* role. tenantId/legalEntityId always come from the
 * verified JWT, never a request param/body.
 */
@Controller("budgets")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateBudgetDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budgets require",
    );
    return this.budgets.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(@CurrentUser() user: AuthenticatedRequestUser) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budgets require",
    );
    return this.budgets.list(tenantId, legalEntityId);
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budgets require",
    );
    return this.budgets.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.admin")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budgets require",
    );
    return this.budgets.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Post(":id/approve")
  @HttpCode(200)
  // Mutates an existing resource rather than creating a new one — same
  // repo-wide convention as every other action-style POST route
  // (JournalEntriesController's post/reverse, SupplierBillsController's
  // approve/post, BankReconciliationController's match routes, etc.),
  // which all explicitly override Nest's default 201 with 200.
  @Roles("finance.admin")
  approve(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "budgets require",
    );
    return this.budgets.approve(tenantId, legalEntityId, user.userId, id);
  }
}
