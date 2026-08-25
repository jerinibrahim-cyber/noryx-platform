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
import { ApReportsService } from "./ap-reports.service";
import { SupplierBalanceQueryDto } from "./dto/supplier-balance-query.dto";
import { SupplierStatementQueryDto } from "./dto/supplier-statement-query.dto";
import { ApAgeingQueryDto } from "./dto/ap-ageing-query.dto";
import { ApReconciliationQueryDto } from "./dto/ap-reconciliation-query.dto";

/**
 * AP-1d — Supplier Balance, Supplier Statement, AP Ageing, AP/GL
 * Reconciliation. docs/finance-work-item-1d-supplier-balance-statement-
 * ageing-proposal.md §5.
 *
 * Every route is read-only and open to all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as every
 * other read route in this service, including GeneralLedgerController
 * (there is no write-side RBAC distinction to make here, since nothing in
 * this controller mutates — unlike SupplierBillsController/
 * SupplierPaymentsController's poster-writes split, which exists
 * specifically for transactional/posting documents).
 *
 * `@Controller()` with full per-method paths, not a single path prefix —
 * routes live under two different prefixes (`suppliers/:id/...` and
 * `ap/...`) inside one controller, the identical shape
 * GeneralLedgerController already uses for `accounts/:id/...` +
 * `trial-balance`.
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never from
 * a request param/body — identical convention to every other Finance
 * controller.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApReportsController {
  constructor(private readonly reports: ApReportsService) {}

  @Get("suppliers/:id/balance")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  balance(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: SupplierBalanceQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier balance requires",
    );
    return this.reports.getSupplierBalance(tenantId, legalEntityId, id, query);
  }

  @Get("suppliers/:id/statement")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async statement(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: SupplierStatementQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier statement requires",
    );
    const result = await this.reports.getSupplierStatement(
      tenantId,
      legalEntityId,
      id,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("ap/ageing")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async ageing(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ApAgeingQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AP ageing requires",
    );
    const result = await this.reports.getApAgeing(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("ap/reconciliation")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  reconciliation(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ApReconciliationQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AP reconciliation requires",
    );
    return this.reports.getApReconciliation(tenantId, legalEntityId, query);
  }
}
