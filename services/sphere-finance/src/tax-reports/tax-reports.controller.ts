import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ApiSuccessWithMeta } from "../common/interceptors/response.interceptor";
import { TaxReportsService } from "./tax-reports.service";
import { VatPositionQueryDto } from "./dto/vat-position-query.dto";

/**
 * Tax/VAT Phase 4 — VAT Position Report.
 * docs/finance-work-item-tax-vat-phase-4-discovery.md §6.1/§6.2 (module
 * placement resolved per the discovery's own recommendation, §11
 * decision 1): a top-level Accounting Core sibling of
 * `GeneralLedgerController`/`FinancialStatementsController` — this
 * report reads across both AP and AR subledgers, the identical
 * cross-cutting reasoning `FinancialStatementsController`'s own doc
 * comment already gives for its own top-level placement.
 *
 * Read-only, all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as
 * every other read route in this service, including
 * `GeneralLedgerController`/`ApReportsController`/`ArReportsController`/
 * `FinancialStatementsController` (no write-side RBAC distinction to
 * make here, since nothing in this controller mutates).
 *
 * `@Controller()` with a full per-method path, not a controller-level
 * prefix — same shape every other top-level report controller uses.
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never
 * from a request param/body — identical convention to every other
 * Finance controller.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class TaxReportsController {
  constructor(private readonly reports: TaxReportsService) {}

  @Get("tax-reports/vat-position")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async vatPosition(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: VatPositionQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "The VAT position report requires",
    );
    const result = await this.reports.getVatPosition(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(
      {
        outputByTaxCode: result.outputByTaxCode,
        inputByTaxCode: result.inputByTaxCode,
      },
      result.meta,
    );
  }
}
