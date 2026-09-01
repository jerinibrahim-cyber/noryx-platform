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
import { ScheduledReversalsService } from "./scheduled-reversals.service";
import { CreateScheduledReversalDto } from "./dto/create-scheduled-reversal.dto";
import { CancelScheduledReversalDto } from "./dto/cancel-scheduled-reversal.dto";

/**
 * Scheduled Reversal for Accruals and Other Timing Adjustments — Final
 * Implementation Specification (Revision 2), §8. Five routes, same
 * RBAC convention as JournalEntriesController: `finance.poster` for the
 * three mutating routes (create, cancel, process-due — process-due
 * creates journal entries via the same posting path `/reverse` does, so
 * it carries the same role as `/reverse`, not a separate operational
 * role that doesn't exist in this codebase's route-role-matrix); read
 * routes open to `finance.viewer`/`finance.poster`/`finance.admin`.
 * tenantId/legalEntityId always from the verified JWT via
 * `requireTenantContext()`, never from the request.
 *
 * `/process-due` returns `200` (transitions existing resources, same
 * convention as `/post` on JournalEntriesController) — it does not
 * itself represent one created resource, unlike `/reverse`'s `201`.
 * `/cancel` also returns `200` for the same reason.
 */
@Controller("scheduled-reversals")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ScheduledReversalsController {
  constructor(private readonly scheduledReversals: ScheduledReversalsService) {}

  @Post()
  @Roles("finance.poster")
  create(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: CreateScheduledReversalDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "scheduled reversals require",
    );
    return this.scheduledReversals.create(
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
      status !== "SCHEDULED" &&
      status !== "EXECUTED" &&
      status !== "FAILED" &&
      status !== "CANCELLED"
    ) {
      throw new BadRequestException(
        'status filter must be one of "SCHEDULED", "EXECUTED", "FAILED", "CANCELLED".',
      );
    }
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "scheduled reversals require",
    );
    return this.scheduledReversals.list(tenantId, legalEntityId, { status });
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "scheduled reversals require",
    );
    return this.scheduledReversals.findOne(tenantId, legalEntityId, id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @Roles("finance.poster")
  cancel(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: CancelScheduledReversalDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "scheduled reversals require",
    );
    return this.scheduledReversals.cancel(
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
      "scheduled reversals require",
    );
    return this.scheduledReversals.processDue(
      tenantId,
      legalEntityId,
      user.userId,
    );
  }
}
