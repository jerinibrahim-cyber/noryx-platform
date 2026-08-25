import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ArSettingsService } from "./ar-settings.service";
import { UpsertArSettingsDto } from "./dto/upsert-ar-settings.dto";

/**
 * finance.admin only for the upsert (write) — configuring the AR control
 * account is structural setup, same posture ApSettingsController takes
 * for the AP control account. Any finance.* role can read.
 *
 * docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §5.
 */
@Controller("ar/settings")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ArSettingsController {
  constructor(private readonly arSettings: ArSettingsService) {}

  @Post()
  @Roles("finance.admin")
  upsert(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: UpsertArSettingsDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AR settings require",
    );
    return this.arSettings.upsert(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(@CurrentUser() user: AuthenticatedRequestUser) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AR settings require",
    );
    return this.arSettings.findOne(tenantId, legalEntityId);
  }
}
