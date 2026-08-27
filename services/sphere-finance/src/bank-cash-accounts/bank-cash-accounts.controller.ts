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
import { BankCashAccountsService } from "./bank-cash-accounts.service";
import { CreateBankCashAccountDto } from "./dto/create-bank-cash-account.dto";
import { UpdateBankCashAccountDto } from "./dto/update-bank-cash-account.dto";

/**
 * finance.viewer/finance.poster/finance.admin can read; only
 * finance.admin can write — same split SuppliersController/
 * CustomersController use for their own master data (locked CTO
 * decision, proposal §12: mirrors the customers/suppliers/settings RBAC
 * precedent, not Chart of Accounts' narrower viewer+admin-only-reads
 * precedent, because a finance.poster needs to select a Bank/Cash
 * Account operationally the same way it already selects a
 * supplier/customer). tenantId and legalEntityId always come from the
 * verified JWT (CurrentUser), never from a request param/body — same
 * convention as every other Finance controller.
 *
 * docs/finance-work-item-banking-cash-management-proposal.md §12/§13/§20,
 * CTO-approved (Banking-1a routes only — no Banking-1b/1c route exists).
 * No DELETE route — this is master data with a
 * create/read/update/deactivate/reactivate lifecycle only, never a
 * DRAFT/POSTED document (locked CTO decision, §5/§9).
 */
@Controller("bank-cash-accounts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BankCashAccountsController {
  constructor(private readonly bankCashAccounts: BankCashAccountsService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateBankCashAccountDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.create(
      tenantId,
      legalEntityId,
      user.userId,
      dto,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.list(
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
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.admin")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateBankCashAccountDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.update(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Patch(":id/deactivate")
  @Roles("finance.admin")
  deactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.deactivate(
      tenantId,
      legalEntityId,
      user.userId,
      id,
    );
  }

  @Patch(":id/reactivate")
  @Roles("finance.admin")
  reactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank/Cash Accounts require",
    );
    return this.bankCashAccounts.reactivate(
      tenantId,
      legalEntityId,
      user.userId,
      id,
    );
  }
}
