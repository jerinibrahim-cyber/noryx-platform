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
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

/**
 * finance.viewer/finance.poster/finance.admin can read; only
 * finance.admin can write — same split SuppliersController uses for AP
 * master data (customers are master data of the same kind). tenantId and
 * legalEntityId always come from the verified JWT (CurrentUser), never
 * from a request param/body — same convention as every other Finance
 * controller.
 *
 * docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §5 (AR-1a routes only — this controller does not implement any later
 * AR Work Item's route).
 */
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @Roles("finance.admin")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateCustomerDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customers require",
    );
    return this.customers.create(tenantId, legalEntityId, user.userId, dto);
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("includeInactive") includeInactive?: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customers require",
    );
    return this.customers.list(
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
      "Customers require",
    );
    return this.customers.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.admin")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customers require",
    );
    return this.customers.update(tenantId, legalEntityId, user.userId, id, dto);
  }

  @Patch(":id/deactivate")
  @Roles("finance.admin")
  deactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customers require",
    );
    return this.customers.deactivate(tenantId, legalEntityId, user.userId, id);
  }

  @Patch(":id/reactivate")
  @Roles("finance.admin")
  reactivate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Customers require",
    );
    return this.customers.reactivate(tenantId, legalEntityId, user.userId, id);
  }
}
