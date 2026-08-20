import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
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
    return this.periods.create(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      dto,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.periods.list(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
    );
  }

  @Patch(":id/close")
  @Roles("finance.admin")
  close(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.periods.close(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      id,
    );
  }

  private requireTenantId(user: AuthenticatedRequestUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException(
        "This token has no tenant context; accounting periods require a tenant-scoped token.",
      );
    }
    return user.tenantId;
  }

  private requireLegalEntityId(user: AuthenticatedRequestUser): string {
    if (!user.legalEntityId) {
      throw new ForbiddenException(
        "This token has no legal-entity context; accounting periods require a legal-entity-scoped token.",
      );
    }
    return user.legalEntityId;
  }
}
