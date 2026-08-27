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
import { SupplierDebitNotesService } from "./supplier-debit-notes.service";
import { CreateSupplierDebitNoteDto } from "./dto/create-supplier-debit-note.dto";
import { UpdateSupplierDebitNoteDto } from "./dto/update-supplier-debit-note.dto";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §12/§13.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write —
 * matches SupplierPaymentsController's/SupplierBillsController's split.
 *
 * tenantId and legalEntityId always come from the verified JWT. `/post`
 * returns 200 (not Nest's `@Post()` default 201) since it transitions an
 * existing resource rather than creating one.
 */
@Controller("debit-notes")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupplierDebitNotesController {
  constructor(private readonly debitNotes: SupplierDebitNotesService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateSupplierDebitNoteDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier debit notes require",
    );
    return this.debitNotes.create(tenantId, legalEntityId, user.userId, dto);
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
      "Supplier debit notes require",
    );
    return this.debitNotes.list(tenantId, legalEntityId, {
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
      "Supplier debit notes require",
    );
    return this.debitNotes.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateSupplierDebitNoteDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier debit notes require",
    );
    return this.debitNotes.update(
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
      "Supplier debit notes require",
    );
    return this.debitNotes.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Supplier debit notes require",
    );
    return this.debitNotes.post(tenantId, legalEntityId, user.userId, id);
  }
}
