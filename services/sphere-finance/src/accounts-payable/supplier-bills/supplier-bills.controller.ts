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
import { SupplierBillsService } from "./supplier-bills.service";
import { CreateSupplierBillDto } from "./dto/create-supplier-bill.dto";
import { UpdateSupplierBillDto } from "./dto/update-supplier-bill.dto";

/**
 * docs/finance-work-item-1b-supplier-bills-proposal.md §14/§16.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post) — matches JournalEntriesController's
 * split, not AP-1a's SuppliersController/ApSettingsController
 * admin-writes split (proposal §24 item 4, approved): bills are a
 * transactional/posting document like journal entries, not master data/
 * configuration like suppliers or AP settings, so the role split follows
 * the nature of the object rather than the module it lives in.
 *
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as every other Finance
 * controller. `/post` returns 200 (not Nest's `@Post()` default 201)
 * since it transitions an existing resource rather than creating one —
 * same reasoning as JournalEntriesController.post().
 */
@Controller("bills")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupplierBillsController {
  constructor(private readonly bills: SupplierBillsService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateSupplierBillDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier bills require",
    );
    return this.bills.create(tenantId, legalEntityId, user.userId, dto);
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
      "Supplier bills require",
    );
    return this.bills.list(tenantId, legalEntityId, {
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
      "Supplier bills require",
    );
    return this.bills.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateSupplierBillDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier bills require",
    );
    return this.bills.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Delete(":id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier bills require",
    );
    return this.bills.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier bills require",
    );
    return this.bills.post(tenantId, legalEntityId, user.userId, id);
  }
}
