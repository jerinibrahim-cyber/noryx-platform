import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { DeferralRecognitionService } from "./deferral-recognition.service";
import { CreateDeferralScheduleDto } from "./dto/create-deferral-schedule.dto";
import { CancelDeferralScheduleDto } from "./dto/cancel-deferral-schedule.dto";

/**
 * Generic Deferral Recognition Engine — Phase 2 Implementation Contract
 * (docs/work-items/deferral-recognition-engine/CONTRACT.md §7). Same
 * RBAC convention as ScheduledReversalsController: `finance.poster` for
 * the mutating routes (create, cancel, process-due — process-due
 * creates journal entries via the same posting path `/reverse` and
 * manual `/post` do, so it carries the same role, not a separate
 * operational role that doesn't exist in this codebase's route-role
 * matrix); read routes open to `finance.viewer`/`finance.poster`/
 * `finance.admin`. tenantId/legalEntityId always from the verified JWT
 * via `requireTenantContext()`, never from the request.
 *
 * `/process-due` and `/cancel` return `200` (transitions existing
 * resources) — same convention as `/post` on JournalEntriesController
 * and `/process-due`/`/cancel` on ScheduledReversalsController.
 */
@Controller("deferral-schedules")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeferralRecognitionController {
  constructor(
    private readonly deferralRecognition: DeferralRecognitionService,
  ) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateDeferralScheduleDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.create(
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
  ) {
    if (
      status !== undefined &&
      status !== "ACTIVE" &&
      status !== "COMPLETED" &&
      status !== "CANCELLED"
    ) {
      throw new BadRequestException(
        'status filter must be one of "ACTIVE", "COMPLETED", "CANCELLED".',
      );
    }
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.list(tenantId, legalEntityId, { status });
  }

  // Declared before ":id" — a literal segment must be matched before
  // the single dynamic ":id" route below can shadow it (same discipline
  // ScheduledReversalsController's own "process-due" route follows,
  // there against a two-segment ":id/cancel" route rather than this
  // controller's single-segment ":id").
  @Get("recognitions/by-journal-entry/:journalEntryId")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findRecognitionByJournalEntryId(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("journalEntryId") journalEntryId: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.findRecognitionByJournalEntryId(
      tenantId,
      legalEntityId,
      journalEntryId,
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
      "deferral schedules require",
    );
    return this.deferralRecognition.findOne(tenantId, legalEntityId, id);
  }

  @Get(":id/recognitions")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listRecognitions(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.listRecognitions(
      tenantId,
      legalEntityId,
      id,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @Roles("finance.poster")
  cancel(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: CancelDeferralScheduleDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.cancel(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Post("process-due")
  @HttpCode(200)
  @Roles("finance.poster")
  processDue(@CurrentUser() user: AuthenticatedRequestUser) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "deferral schedules require",
    );
    return this.deferralRecognition.processDue(
      tenantId,
      legalEntityId,
      user.userId,
    );
  }
}
