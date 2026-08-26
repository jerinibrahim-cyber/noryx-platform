import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ApiSuccessWithMeta } from "../../common/interceptors/response.interceptor";
import { ArReportsService } from "./ar-reports.service";
import { CustomerBalanceQueryDto } from "./dto/customer-balance-query.dto";
import { CustomerStatementQueryDto } from "./dto/customer-statement-query.dto";
import { ArAgeingQueryDto } from "./dto/ar-ageing-query.dto";
import { ArReconciliationQueryDto } from "./dto/ar-reconciliation-query.dto";

/**
 * AR-1d — Customer Balance, Customer Statement, AR Ageing, AR/GL
 * Reconciliation. docs/finance-work-item-1d-ar-reports-proposal.md §10.
 *
 * Every route is read-only and open to all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as every
 * other read route in this service, including
 * `ApReportsController`/`GeneralLedgerController` (there is no
 * write-side RBAC distinction to make here, since nothing in this
 * controller mutates — unlike `CustomerInvoicesController`/
 * `CustomerReceiptsController`'s poster-writes split, which exists
 * specifically for transactional/posting documents).
 *
 * `@Controller()` with full per-method paths, not a single path prefix —
 * routes live under two different prefixes (`customers/:id/...` and
 * `ar/...`) inside one controller, the identical shape
 * `ApReportsController` already established for `suppliers/:id/...` +
 * `ap/...`.
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never
 * from a request param/body — identical convention to every other
 * Finance controller.
 *
 * `/ar/reconciliation` deliberately has no `customerId` query param
 * (§9.3, §14 decision 3, resolved) — `ArReconciliationQueryDto` has no
 * such field, so the global `ValidationPipe`'s
 * `whitelist:true`/`forbidNonWhitelisted:true` rejects one with a 400
 * if a caller sends it.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ArReportsController {
  constructor(private readonly reports: ArReportsService) {}

  @Get("customers/:id/balance")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  balance(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: CustomerBalanceQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer balance requires",
    );
    return this.reports.getCustomerBalance(tenantId, legalEntityId, id, query);
  }

  @Get("customers/:id/statement")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async statement(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: CustomerStatementQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer statement requires",
    );
    const result = await this.reports.getCustomerStatement(
      tenantId,
      legalEntityId,
      id,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("ar/ageing")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async ageing(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ArAgeingQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AR ageing requires",
    );
    const result = await this.reports.getArAgeing(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("ar/reconciliation")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  reconciliation(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ArReconciliationQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AR reconciliation requires",
    );
    return this.reports.getArReconciliation(tenantId, legalEntityId, query);
  }
}
