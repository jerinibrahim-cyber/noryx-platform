import {
  Body,
  Controller,
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
import { TaxCodesService } from "./tax-codes.service";
import { TaxRatesService } from "./tax-rates.service";
import { CreateTaxCodeDto } from "./dto/create-tax-code.dto";
import { CreateTaxRateDto } from "./dto/create-tax-rate.dto";
import { UpdateTaxCodeGlAccountsDto } from "./dto/update-tax-code-gl-accounts.dto";

/**
 * Tax / VAT MVP Phase 1 — Tax Configuration (CTO-approved architecture
 * proposal §3/§7/§11, CTO decision turn). Tax Codes are master data
 * (SuppliersController's read/write RBAC split: finance.viewer/
 * finance.poster/finance.admin can read, only finance.admin can write);
 * Tax Rates hang off a tax code as a sub-resource
 * (`/tax-codes/:taxCodeId/rates`), same single-controller-with-nested-
 * sub-action shape ScheduledReversalsController uses for `/:id/cancel`
 * and AccountingPeriodsController uses for `/:id/close`, rather than a
 * second top-level controller. No PATCH/DELETE for rates at all — they
 * are create-only (§3/§7's "no PATCH — corrections are new rows"
 * decision).
 *
 * tenantId/legalEntityId always come from the verified JWT
 * (requireTenantContext), never from a request param/body — same
 * convention as every other Finance controller.
 */
@Controller("tax-codes")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TaxCodesController {
  constructor(
    private readonly taxCodes: TaxCodesService,
    private readonly taxRates: TaxRatesService,
  ) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateTaxCodeDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.list(
      tenantId,
      legalEntityId,
      includeInactive === "true",
    );
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id/deactivate")
  @Roles("finance.admin")
  deactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.deactivate(tenantId, legalEntityId, user.userId, id);
  }

  @Patch(":id/reactivate")
  @Roles("finance.admin")
  reactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.reactivate(tenantId, legalEntityId, user.userId, id);
  }

  /** Tax/VAT Phase 5
   * (docs/finance-work-item-tax-vat-phase-5-proposal.md §9) — sets/
   * clears this tax code's optional per-direction GL account overrides.
   * finance.admin only, same write-side role as create/deactivate/
   * reactivate above — this is master-data configuration, not a
   * transactional document write. */
  @Patch(":id/gl-accounts")
  @Roles("finance.admin")
  setGlAccounts(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateTaxCodeGlAccountsDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax codes require",
    );
    return this.taxCodes.setGlAccounts(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Post(":taxCodeId/rates")
  @Roles("finance.admin")
  createRate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("taxCodeId") taxCodeId: string,
    @Body() dto: CreateTaxRateDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax rates require",
    );
    return this.taxRates.create(
      tenantId,
      legalEntityId,
      user.userId,
      taxCodeId,
      dto,
    );
  }

  @Get(":taxCodeId/rates")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listRates(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("taxCodeId") taxCodeId: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "tax rates require",
    );
    return this.taxRates.list(tenantId, legalEntityId, taxCodeId);
  }
}
