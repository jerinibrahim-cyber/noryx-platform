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
import { CustomerReceiptsService } from "./customer-receipts.service";
import { CreateCustomerReceiptDto } from "./dto/create-customer-receipt.dto";
import { UpdateCustomerReceiptDto } from "./dto/update-customer-receipt.dto";

/**
 * docs/finance-work-item-1c-customer-receipts-proposal.md §16/§18.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post) — matches
 * SupplierPaymentsController's split: receipts are a transactional/
 * posting document, not master data.
 *
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as every other Finance
 * controller. `/post` returns 200 (not Nest's `@Post()` default 201)
 * since it transitions an existing resource rather than creating one —
 * same reasoning as SupplierPaymentsController.post().
 */
@Controller("receipts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerReceiptsController {
  constructor(private readonly receipts: CustomerReceiptsService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateCustomerReceiptDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer receipts require",
    );
    return this.receipts.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
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
      "Customer receipts require",
    );
    return this.receipts.list(tenantId, legalEntityId, {
      status,
      customerId,
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
      "Customer receipts require",
    );
    return this.receipts.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateCustomerReceiptDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer receipts require",
    );
    return this.receipts.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Delete(":id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer receipts require",
    );
    return this.receipts.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer receipts require",
    );
    return this.receipts.post(tenantId, legalEntityId, user.userId, id);
  }
}
