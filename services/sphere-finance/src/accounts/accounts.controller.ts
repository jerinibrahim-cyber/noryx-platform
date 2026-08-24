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
 *
 * Milestone 3.2 Stage 2 — the tenant/legal-entity presence check below is
 * now the shared `requireTenantContext()` from `@noryx/auth-core`
 * (previously this controller's own private requireTenantId()/
 * requireLegalEntityId() methods; docs/hardening/milestone-3.2-proposal.md
 * §9 item 2). Behavior, including the exact message wording below and the
 * PLATFORM_OPERATOR reasoning in this doc comment, is unchanged:
 * PLATFORM_OPERATOR tokens carry tenantId: null (System Architecture v1
 * §3.2) — Chart of Accounts is inherently tenant-owned data, so there is
 * no meaningful cross-tenant operation here. A platform operator would
 * need to impersonate a specific tenant (out of scope for this
 * milestone) rather than call these routes directly.
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
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Chart of Accounts requires",
    );
    return this.accounts.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Chart of Accounts requires",
    );
    return this.accounts.list(
      tenantId,
      legalEntityId,
      includeInactive === "true",
    );
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Chart of Accounts requires",
    );
    return this.accounts.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id/archive")
  @Roles("finance.admin")
  archive(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Chart of Accounts requires",
    );
    return this.accounts.archive(tenantId, legalEntityId, user.userId, id);
  }
}
