import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { JournalEntriesService } from "./journal-entries.service";
import { CreateJournalEntryDto } from "./dto/create-journal-entry.dto";
import { UpdateJournalEntryDto } from "./dto/update-journal-entry.dto";

/**
 * 2c-1 scope only: draft CRUD. No /post or /reverse routes exist yet —
 * those are 2c-2, a separate, not-yet-approved increment
 * (docs/finance-2c-journal-entry-service-proposal.md §0.1/§12/§8).
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft) — §9 of the 2c proposal. tenantId and
 * legalEntityId always come from the verified JWT, never from a request
 * param/body, same convention as AccountsController.
 */
@Controller("journal-entries")
@UseGuards(JwtAuthGuard, RolesGuard)
export class JournalEntriesController {
  constructor(private readonly journalEntries: JournalEntriesService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.journalEntries.create(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      dto,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query("status") status?: string,
    @Query("periodId") periodId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    if (status !== undefined && status !== "DRAFT" && status !== "POSTED") {
      throw new BadRequestException(
        'status filter must be "DRAFT" or "POSTED".',
      );
    }
    return this.journalEntries.list(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      { status, periodId, dateFrom, dateTo },
    );
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    return this.journalEntries.findOne(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      id,
    );
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateJournalEntryDto,
  ) {
    return this.journalEntries.update(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
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
    return this.journalEntries.remove(
      this.requireTenantId(user),
      this.requireLegalEntityId(user),
      user.userId,
      id,
    );
  }

  private requireTenantId(user: AuthenticatedRequestUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException(
        "This token has no tenant context; journal entries require a tenant-scoped token.",
      );
    }
    return user.tenantId;
  }

  private requireLegalEntityId(user: AuthenticatedRequestUser): string {
    if (!user.legalEntityId) {
      throw new ForbiddenException(
        "This token has no legal-entity context; journal entries require a legal-entity-scoped token.",
      );
    }
    return user.legalEntityId;
  }
}
