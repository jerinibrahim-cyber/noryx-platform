import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { AccountsService } from "./accounts.service";
import { CreateAccountDto } from "./dto/create-account.dto";

/**
 * finance.viewer OR finance.admin can read; only finance.admin can write.
 * This is the server-side enforcement — the API Gateway's manifest-level
 * requiredRoles is only a coarse "can this caller reach Finance at all"
 * pre-filter (docs/plug-and-play-modules.md), not a substitute for this.
 *
 * tenantId always comes from the verified JWT (CurrentUser), never from a
 * request param/body — a caller cannot ask to act as a different tenant.
 */
@Controller("accounts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateAccountDto,
  ) {
    return this.accounts.create(this.requireTenantId(user), user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    return this.accounts.list(
      this.requireTenantId(user),
      includeInactive === "true",
    );
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.accounts.findOne(this.requireTenantId(user), id);
  }

  @Patch(":id/archive")
  @Roles("finance.admin")
  archive(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.accounts.archive(this.requireTenantId(user), user.userId, id);
  }

  /** PLATFORM_OPERATOR tokens carry tenantId: null (System Architecture v1
   * §3.2) — Chart of Accounts is inherently tenant-owned data, so there is
   * no meaningful cross-tenant operation here. A platform operator would
   * need to impersonate a specific tenant (out of scope for this
   * milestone) rather than call these routes directly. */
  private requireTenantId(user: AuthenticatedRequestUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException(
        "This token has no tenant context; Chart of Accounts requires a tenant-scoped token.",
      );
    }
    return user.tenantId;
  }
}
