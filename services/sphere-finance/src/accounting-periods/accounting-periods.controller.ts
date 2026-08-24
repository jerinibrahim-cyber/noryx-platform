import {
  Body,
  Controller,
  Get,
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
import { AccountingPeriodsService } from "./accounting-periods.service";
import { CreateAccountingPeriodDto } from "./dto/create-accounting-period.dto";

/**
 * finance.admin only for create/close (write). GET (list) is open to
 * any finance.* role — finance.viewer, finance.poster, and
 * finance.admin can all read periods, matching the read model already
 * used for journal entries. §3/§9 of the 2c proposal.
 * tenantId/legalEntityId always come from the verified JWT, never from
 * a request param/body — same convention as AccountsController.
 *
 * Milestone 3.2 Stage 2 — the tenant/legal-entity presence check below is
 * now the shared `requireTenantContext()` from `@noryx/auth-core`
 * (previously this controller's own private requireTenantId()/
 * requireLegalEntityId() methods). Behavior and message wording are
 * unchanged.
 */
@Controller("accounting-periods")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountingPeriodsController {
  constructor(private readonly periods: AccountingPeriodsService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateAccountingPeriodDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "accounting periods require",
    );
    return this.periods.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(@CurrentUser() user: AuthenticatedRequestUser) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "accounting periods require",
    );
    return this.periods.list(tenantId, legalEntityId);
  }

  @Patch(":id/close")
  @Roles("finance.admin")
  close(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "accounting periods require",
    );
    return this.periods.close(tenantId, legalEntityId, user.userId, id);
  }
}
