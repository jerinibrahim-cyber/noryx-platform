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
 * tenantId and legalEntityId always come from the verified JWT
 * (CurrentUser), never from a request param/body — a caller cannot ask
 * to act as a different tenant or a different legal entity within their
 * own tenant. Since the 2a retrofit
 * (docs/finance-journal-engine-proposal.md §1.1), Chart of Accounts is
 * scoped to the caller's own legal entity only — no cross-entity
 * selector, no entity switching. That's a deliberate non-goal for this
 * increment, not an oversight.
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
    return this.accounts.create(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      dto,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    return this.accounts.list(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      includeInactive === "true",
    );
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.accounts.findOne(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      id,
    );
  }

  @Patch(":id/archive")
  @Roles("finance.admin")
  archive(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.accounts.archive(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      id,
    );
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

  /** Same reasoning as requireTenantId, one level down: a token with no
   * legal-entity context (e.g. a PLATFORM_OPERATOR token, which also has
   * tenantId: null and would already be rejected above) cannot act
   * against a legal-entity-scoped resource. */
  private requireLegalEntityId(user: AuthenticatedRequestUser): string {
    if (!user.legalEntityId) {
      throw new ForbiddenException(
        "This token has no legal-entity context; Chart of Accounts requires a legal-entity-scoped token.",
      );
    }
    return user.legalEntityId;
  }
}
