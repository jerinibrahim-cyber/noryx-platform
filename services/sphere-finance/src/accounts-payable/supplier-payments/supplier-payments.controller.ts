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
import { SupplierPaymentsService } from "./supplier-payments.service";
import { CreateSupplierPaymentDto } from "./dto/create-supplier-payment.dto";
import { UpdateSupplierPaymentDto } from "./dto/update-supplier-payment.dto";

/**
 * docs/finance-work-item-1c-supplier-payments-proposal.md §10/§11.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post) — matches SupplierBillsController's/
 * JournalEntriesController's split: payments are a transactional/
 * posting document, not master data.
 *
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as every other Finance
 * controller. `/post` returns 200 (not Nest's `@Post()` default 201)
 * since it transitions an existing resource rather than creating one.
 */
@Controller("payments")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateSupplierPaymentDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier payments require",
    );
    return this.payments.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("status") status?: string,
    @Query("supplierId") supplierId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    if (status !== undefined && status !== "DRAFT" && status !== "POSTED") {
      throw new BadRequestException(
        'status filter must be "DRAFT" or "POSTED".',
      );
    }
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier payments require",
    );
    return this.payments.list(tenantId, legalEntityId, {
      status,
      supplierId,
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
      "Supplier payments require",
    );
    return this.payments.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateSupplierPaymentDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier payments require",
    );
    return this.payments.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Delete(":id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier payments require",
    );
    return this.payments.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier payments require",
    );
    return this.payments.post(tenantId, legalEntityId, user.userId, id);
  }
}
