import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { ApiSuccessWithMeta } from "../common/interceptors/response.interceptor";
import { GeneralLedgerService } from "./general-ledger.service";
import { LedgerQueryDto } from "./dto/ledger-query.dto";
import { AccountBalanceQueryDto } from "./dto/account-balance-query.dto";
import { TrialBalanceQueryDto } from "./dto/trial-balance-query.dto";

/**
 * 2d — General Ledger read layer: Account Ledger, Account Balance,
 * Trial Balance. docs/finance-2d-general-ledger-read-layer-proposal.md
 * §2/§3/§5/§8.
 *
 * Every route is read-only and open to all three finance roles — same
 * `@Roles("finance.viewer", "finance.poster", "finance.admin")` as every
 * other read route in this service (`GET /accounts`,
 * `GET /journal-entries`, `GET /accounting-periods`). No mutation route
 * exists here, so there is no write-side RBAC distinction to make (§8).
 *
 * `tenantId`/`legalEntityId` always come from the verified JWT, never
 * from a request param/body — identical convention to every other
 * Finance controller.
 *
 * Account Ledger and Trial Balance both need top-level `meta` in the
 * response envelope (pagination info, resolved dates/totals) — see
 * `ApiSuccessWithMeta`'s doc comment for how that reaches the shared
 * `ResponseInterceptor` without changing any other route's behavior.
 * Account Balance returns a single computed answer with no `meta`
 * (§3.1.4), so it returns its plain result object.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class GeneralLedgerController {
  constructor(private readonly generalLedger: GeneralLedgerService) {}

  @Get("accounts/:id/ledger")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async ledger(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: LedgerQueryDto,
  ) {
    const result = await this.generalLedger.getLedger(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      id,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  @Get("accounts/:id/balance")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  balance(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: AccountBalanceQueryDto,
  ) {
    return this.generalLedger.getBalance(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      id,
      query,
    );
  }

  @Get("trial-balance")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async trialBalance(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: TrialBalanceQueryDto,
  ) {
    const result = await this.generalLedger.getTrialBalance(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }

  private requireTenantId(user: AuthenticatedRequestUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException(
        "This token has no tenant context; the general ledger requires a tenant-scoped token.",
      );
    }
    return user.tenantId;
  }

  private requireLegalEntityId(user: AuthenticatedRequestUser): string {
    if (!user.legalEntityId) {
      throw new ForbiddenException(
        "This token has no legal-entity context; the general ledger requires a legal-entity-scoped token.",
      );
    }
    return user.legalEntityId;
  }
}
