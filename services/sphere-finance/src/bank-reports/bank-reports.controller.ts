import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ApiSuccessWithMeta } from "../common/interceptors/response.interceptor";
import { BankReportsService } from "./bank-reports.service";
import { CashPositionQueryDto } from "./dto/cash-position-query.dto";
import { BankCashAccountStatementQueryDto } from "./dto/bank-cash-account-statement-query.dto";
import { UnreconciledTransactionsQueryDto } from "./dto/unreconciled-transactions-query.dto";

/**
 * Banking-1d — Cash Position, Bank/Cash Account Statement, Unreconciled
 * Transactions. docs/finance-work-item-banking-1d-proposal.md §4.
 *
 * Every route is read-only and open to all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as every
 * other read route in this service (GeneralLedgerController,
 * ApReportsController, ArReportsController). No mutation route exists
 * here, so there is no write-side RBAC distinction to make.
 *
 * `@Controller()` with full per-method paths, not a single path prefix —
 * routes are deliberately split across two prefixes (proposal §2.1's
 * routing-collision note): `bank-cash-accounts/:id/statement` (the
 * per-account route, nested under Banking-1a's own master-data prefix,
 * a safe 2-segment shape identical to `accounts/:id/ledger`/
 * `suppliers/:id/statement`) and `bank-reports/...` (the two
 * legal-entity-wide routes, never nested as a bare single segment under
 * `bank-cash-accounts/` — that prefix already owns a `:id` route at that
 * exact depth in `BankCashAccountsController`, the same routing hazard
 * AP-1d avoided by giving `ap/ageing`/`ap/reconciliation` their own
 * prefix instead of nesting under `suppliers/`).
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never
 * from a request param/body — identical convention to every other
 * Finance controller.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BankReportsController {
  constructor(private readonly reports: BankReportsService) {}

  @Get("bank-reports/cash-position")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async cashPosition(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: CashPositionQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Cash position requires",
    );
    const result = await this.reports.getCashPosition(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("bank-cash-accounts/:id/statement")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async statement(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: BankCashAccountStatementQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Account statement requires",
    );
    const result = await this.reports.getStatement(
      tenantId,
      legalEntityId,
      id,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("bank-reports/unreconciled-transactions")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async unreconciledTransactions(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: UnreconciledTransactionsQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Unreconciled transactions requires",
    );
    const result = await this.reports.getUnreconciledTransactions(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }
}
