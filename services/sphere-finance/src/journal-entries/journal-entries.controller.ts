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
import { JournalEntriesService } from "./journal-entries.service";
import { CreateJournalEntryDto } from "./dto/create-journal-entry.dto";
import { UpdateJournalEntryDto } from "./dto/update-journal-entry.dto";
import { ReverseJournalEntryDto } from "./dto/reverse-journal-entry.dto";

/**
 * 2c-1 (draft CRUD) + 2c-2 (posting, reversal) —
 * docs/finance-2c-journal-entry-service-proposal.md §0.3/§5/§6/§8.
 *
 * finance.viewer/poster/admin can read; only finance.poster can write
 * (create/edit/delete a draft, post, reverse) — §9 of the 2c proposal.
 * tenantId and legalEntityId always come from the verified JWT, never
 * from a request param/body, same convention as AccountsController.
 *
 * `/post` returns `200` (not Nest's `@Post()` default of `201`) since it
 * transitions an existing resource rather than creating one — matches
 * the concurrent-posting test's expected "winner 200 / loser 409" shape
 * (§11). `/reverse` keeps the `201` default since it does create a new
 * journal entry.
 *
 * Milestone 3.2 Stage 2 — the tenant/legal-entity presence check below is
 * now the shared `requireTenantContext()` from `@noryx/auth-core`
 * (previously this controller's own private requireTenantId()/
 * requireLegalEntityId() methods). Behavior and message wording are
 * unchanged.
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
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "journal entries require",
    );
    return this.journalEntries.create(
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
    @Query("periodId") periodId?: string,
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
      "journal entries require",
    );
    return this.journalEntries.list(tenantId, legalEntityId, {
      status,
      periodId,
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
      "journal entries require",
    );
    return this.journalEntries.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateJournalEntryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "journal entries require",
    );
    return this.journalEntries.update(
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
      "journal entries require",
    );
    return this.journalEntries.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/post")
  @HttpCode(200)
  @Roles("finance.poster")
  post(@CurrentUser() user: AuthenticatedRequestUser, @Param("id") id: string) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "journal entries require",
    );
    return this.journalEntries.post(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/reverse")
  @Roles("finance.poster")
  reverse(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: ReverseJournalEntryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "journal entries require",
    );
    return this.journalEntries.reverse(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }
}
