import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Delete,
  HttpCode,
  Param,
  ParseFilePipeBuilder,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Express } from "express";
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  requireTenantContext,
} from "@noryx/auth-core";
import type { AuthenticatedRequestUser } from "@noryx/shared-types";
import { PaymentProviderSettlementsService } from "./payment-provider-settlements.service";
import { ImportPaymentProviderSettlementDto } from "./dto/import-payment-provider-settlement.dto";
import { ListPaymentProviderSettlementImportsQueryDto } from "./dto/list-payment-provider-settlement-imports.query.dto";
import { ListPaymentProviderSettlementsQueryDto } from "./dto/list-payment-provider-settlements.query.dto";
import { CreatePaymentSettlementMatchDto } from "./dto/create-payment-settlement-match.dto";
import { CreateSettlementTransactionsDto } from "./dto/create-settlement-transactions.dto";
import { ClearingReconciliationQueryDto } from "./dto/clearing-reconciliation-query.dto";

/// Same explicit, bounded synchronous-upload cap as
/// BankReconciliationController (§14/§23) — no queue/async import exists
/// to defer larger files to.
const MAX_SETTLEMENT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * docs/finance-work-item-banking-1e-proposal.md §21/§23, CTO-approved
 * (implementation-authorization turn). Same finance.poster-writes/
 * any-role-reads RBAC split as BankReconciliationController — a payment
 * provider settlement import is a DOCUMENT (import lifecycle A +
 * reconciliation lifecycle B), not master data.
 *
 * `@Controller()` with full per-method paths, not a single path prefix —
 * routes are deliberately split across two prefixes per §23:
 * `payment-provider-settlement-imports/...` (the import/header
 * resource) and `payment-provider-settlements/...` (the settlement
 * record resource) — same routing-collision avoidance as
 * BankReportsController.
 *
 * tenantId/legalEntityId always come from the verified JWT, never from a
 * request param/body, same convention as every other Finance controller.
 *
 * `GET /payment-provider-settlements/:id/matches` is included alongside
 * §23's explicit 11-route list — it mirrors
 * BankReconciliationController's own `GET :id/matches` exactly (the
 * service's `listMatches()` method already exists to back it), and
 * omitting a read-only listing route the proposal's own data model
 * implies would be a gap, not a scope reduction; it introduces no write
 * capability and no new domain behavior.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentProviderSettlementsController {
  constructor(
    private readonly settlements: PaymentProviderSettlementsService,
  ) {}

  // -------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------

  @Post("payment-provider-settlement-imports")
  @Roles("finance.poster")
  @UseInterceptors(FileInterceptor("file"))
  upload(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: ImportPaymentProviderSettlementDto,
    // Deliberately NOT using ParseFilePipeBuilder#addFileTypeValidator —
    // identical reasoning to BankReconciliationController.upload: Nest's
    // built-in FileTypeValidator has no signature for plain-text CSV
    // content. File type is validated by extension below instead; size
    // stays enforced via the built-in validator.
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_SETTLEMENT_FILE_BYTES })
        .build({ fileIsRequired: true }),
    )
    file: Express.Multer.File,
  ) {
    if (!/\.(csv|txt)$/i.test(file.originalname)) {
      throw new BadRequestException(
        `Validation failed (expected file extension .csv or .txt, got "${file.originalname}")`,
      );
    }
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.importSettlements(
      tenantId,
      legalEntityId,
      user.userId,
      dto,
      file.buffer,
      file.originalname,
    );
  }

  @Get("payment-provider-settlement-imports")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ListPaymentProviderSettlementImportsQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.list(tenantId, legalEntityId, query);
  }

  @Get("payment-provider-settlement-imports/:id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.findOne(tenantId, legalEntityId, id);
  }

  @Delete("payment-provider-settlement-imports/:id")
  @Roles("finance.poster")
  remove(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post("payment-provider-settlement-imports/:id/complete")
  @HttpCode(200)
  @Roles("finance.poster")
  complete(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.complete(tenantId, legalEntityId, user.userId, id);
  }

  @Get("payment-provider-settlement-imports/:id/settlements")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listSettlements(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: ListPaymentProviderSettlementsQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlement imports require",
    );
    return this.settlements.listSettlements(tenantId, legalEntityId, id, query);
  }

  // -------------------------------------------------------------------
  // Settlement records / matching
  // -------------------------------------------------------------------

  @Get("payment-provider-settlements/:id/suggestions")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  suggestions(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.suggestionsForSettlement(
      tenantId,
      legalEntityId,
      id,
    );
  }

  @Get("payment-provider-settlements/:id/matches")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listMatches(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.listMatches(tenantId, legalEntityId, id);
  }

  @Post("payment-provider-settlements/:id/match")
  @Roles("finance.poster")
  createMatch(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: CreatePaymentSettlementMatchDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.createMatch(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Post("payment-provider-settlements/:id/matches/:matchId/undo")
  @HttpCode(200)
  @Roles("finance.poster")
  undoMatch(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Param("matchId") matchId: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.undoMatch(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      matchId,
    );
  }

  @Post("payment-provider-settlements/:id/create-settlement-transactions")
  @Roles("finance.poster")
  createSettlementTransactions(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: CreateSettlementTransactionsDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.createSettlementTransactions(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  // -------------------------------------------------------------------
  // Reporting (§20)
  // -------------------------------------------------------------------

  @Get("payment-provider-settlements/clearing-reconciliation")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  clearingReconciliation(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ClearingReconciliationQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Payment provider settlements require",
    );
    return this.settlements.clearingReconciliation(
      tenantId,
      legalEntityId,
      query,
    );
  }
}
