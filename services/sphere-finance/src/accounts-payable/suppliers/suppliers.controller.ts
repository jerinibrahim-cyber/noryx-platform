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
import { SuppliersService } from "./suppliers.service";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";

/**
 * finance.viewer/finance.poster/finance.admin can read; only
 * finance.admin can write — same split AccountsController uses for
 * Chart of Accounts master data (suppliers are master data of the same
 * kind). tenantId and legalEntityId always come from the verified JWT
 * (CurrentUser), never from a request param/body — same convention as
 * every other Finance controller.
 *
 * docs/finance-work-item-1-ap-foundation-proposal.md §16 (AP-1a routes
 * only — this controller does not implement any AP-1b/1c/1d route).
 */
@Controller("suppliers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateSupplierDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Suppliers require",
    );
    return this.suppliers.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Suppliers require",
    );
    return this.suppliers.list(
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
      "Suppliers require",
    );
    return this.suppliers.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.admin")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Suppliers require",
    );
    return this.suppliers.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Patch(":id/deactivate")
  @Roles("finance.admin")
  deactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Suppliers require",
    );
    return this.suppliers.deactivate(tenantId, legalEntityId, user.userId, id);
  }

  @Patch(":id/reactivate")
  @Roles("finance.admin")
  reactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Suppliers require",
    );
    return this.suppliers.reactivate(tenantId, legalEntityId, user.userId, id);
  }
}
