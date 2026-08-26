import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { FinancialStatementsService } from "./financial-statements.service";
import { ProfitAndLossQueryDto } from "./dto/profit-and-loss-query.dto";
import { BalanceSheetQueryDto } from "./dto/balance-sheet-query.dto";

/**
 * Financial Statements — Profit & Loss, Balance Sheet.
 * docs/finance-work-item-financial-statements-proposal.md §4.
 *
 * Every route is read-only and open to all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as every
 * other read route in this service (`GeneralLedgerController`,
 * `ApReportsController`, `ArReportsController`). No mutation route
 * exists here, so there is no write-side RBAC distinction to make.
 *
 * `@Controller()` with full per-method paths, not a single path prefix —
 * same shape as `GeneralLedgerController`/`ApReportsController`.
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never
 * from a request param/body — identical convention to every other
 * Finance controller.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinancialStatementsController {
  constructor(private readonly statements: FinancialStatementsService) {}

  @Get("financial-statements/profit-and-loss")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  profitAndLoss(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ProfitAndLossQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "the profit and loss statement requires",
    );
    return this.statements.getProfitAndLoss(tenantId, legalEntityId, query);
  }

  @Get("financial-statements/balance-sheet")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  balanceSheet(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: BalanceSheetQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "the balance sheet requires",
    );
    return this.statements.getBalanceSheet(tenantId, legalEntityId, query);
  }
}
