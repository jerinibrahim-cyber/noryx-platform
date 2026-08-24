import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
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
 *
 * Milestone 3.2 Stage 2 — the tenant/legal-entity presence check below is
 * now the shared `requireTenantContext()` from `@noryx/auth-core`
 * (previously this controller's own private requireTenantId()/
 * requireLegalEntityId() methods). Behavior and message wording are
 * unchanged.
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
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "the general ledger requires",
    );
    const result = await this.generalLedger.getLedger(
      tenantId,
      legalEntityId,
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
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "the general ledger requires",
    );
    return this.generalLedger.getBalance(tenantId, legalEntityId, id, query);
  }

  @Get("trial-balance")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  async trialBalance(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: TrialBalanceQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "the general ledger requires",
    );
    const result = await this.generalLedger.getTrialBalance(
      tenantId,
      legalEntityId,
      query,
    );
    return new ApiSuccessWithMeta(result.rows, result.meta);
  }
}
