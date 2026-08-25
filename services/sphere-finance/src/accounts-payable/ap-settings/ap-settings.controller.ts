import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ApSettingsService } from "./ap-settings.service";
import { UpsertApSettingsDto } from "./dto/upsert-ap-settings.dto";

/**
 * finance.admin only for the upsert (write) — configuring the AP control
 * account is structural setup, same posture AccountingPeriodsController
 * takes for period create/close. Any finance.* role can read.
 *
 * docs/finance-work-item-1-ap-foundation-proposal.md §16.
 */
@Controller("ap/settings")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApSettingsController {
  constructor(private readonly apSettings: ApSettingsService) {}

  @Post()
  @Roles("finance.admin")
  upsert(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: UpsertApSettingsDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AP settings require",
    );
    return this.apSettings.upsert(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(@CurrentUser() user: AuthenticatedRequestUser) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "AP settings require",
    );
    return this.apSettings.findOne(tenantId, legalEntityId);
  }
}
