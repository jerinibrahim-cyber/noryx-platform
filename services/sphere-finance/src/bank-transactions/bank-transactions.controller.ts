import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { BankTransactionsService } from "./bank-transactions.service";
import {
  BANK_TRANSACTION_TYPES,
  CreateBankTransactionDto,
} from "./dto/create-bank-transaction.dto";
import { UpdateBankTransactionDto } from "./dto/update-bank-transaction.dto";

/**
 * docs/finance-work-item-banking-1b-proposal.md §11/§13.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post) — Bank Transaction is a document
 * (has a DRAFT->POSTED lifecycle, posts a journal entry), matching
 * SupplierPaymentsController's/CustomerReceiptsController's split, NOT
 * BankCashAccountsController's master-data (finance.admin-writes) split.
 *
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as every other Finance
 * controller. `/post` returns 200 (not Nest's `@Post()` default 201)
 * since it transitions an existing resource rather than creating one.
 */
@Controller("bank-transactions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BankTransactionsController {
  constructor(private readonly bankTransactions: BankTransactionsService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateBankTransactionDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.create(
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
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("bankCashAccountId") bankCashAccountId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    if (status !== undefined && status !== "DRAFT" && status !== "POSTED") {
      throw new BadRequestException(
        'status filter must be "DRAFT" or "POSTED".',
      );
    }
    if (
      type !== undefined &&
      !(BANK_TRANSACTION_TYPES as readonly string[]).includes(type)
    ) {
      throw new BadRequestException(
        `type filter must be one of: ${BANK_TRANSACTION_TYPES.join(", ")}.`,
      );
    }
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.list(tenantId, legalEntityId, {
      status: status as "DRAFT" | "POSTED" | undefined,
      type: type as (typeof BANK_TRANSACTION_TYPES)[number] | undefined,
      bankCashAccountId,
      dateFrom,
      dateTo,
    });
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateBankTransactionDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.update(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Delete(":id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.remove(
      tenantId,
      legalEntityId,
      user.userId,
      id,
    );
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank transactions require",
    );
    return this.bankTransactions.post(tenantId, legalEntityId, user.userId, id);
  }
}
