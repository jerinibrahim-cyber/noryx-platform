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
import { CustomerInvoicesService } from "./customer-invoices.service";
import { CreateCustomerInvoiceDto } from "./dto/create-customer-invoice.dto";
import { UpdateCustomerInvoiceDto } from "./dto/update-customer-invoice.dto";

/**
 * docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §5.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post) — matches SupplierBillsController's
 * split, not AR-1a's CustomersController/ArSettingsController
 * admin-writes split: invoices are a transactional/posting document
 * like supplier bills, not master data/configuration like customers or
 * AR settings, so the role split follows the nature of the object
 * rather than the module it lives in.
 *
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as every other Finance
 * controller. `/post` returns 200 (not Nest's `@Post()` default 201)
 * since it transitions an existing resource rather than creating one —
 * same reasoning as SupplierBillsController.post().
 */
@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerInvoicesController {
  constructor(private readonly invoices: CustomerInvoicesService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateCustomerInvoiceDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer invoices require",
    );
    return this.invoices.create(tenantId, legalEntityId, user.userId, dto);
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
      "Customer invoices require",
    );
    return this.invoices.list(tenantId, legalEntityId, {
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
      "Customer invoices require",
    );
    return this.invoices.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateCustomerInvoiceDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer invoices require",
    );
    return this.invoices.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Delete(":id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer invoices require",
    );
    return this.invoices.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customer invoices require",
    );
    return this.invoices.post(tenantId, legalEntityId, user.userId, id);
  }
}
