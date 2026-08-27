import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseFilePipeBuilder,
  Patch,
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
import { BankReconciliationService } from "./bank-reconciliation.service";
import { ImportBankStatementDto } from "./dto/import-bank-statement.dto";
import { UpdateBankStatementImportDto } from "./dto/update-bank-statement-import.dto";
import { CreateBankReconciliationMatchDto } from "./dto/create-bank-reconciliation-match.dto";
import { IgnoreBankStatementLineDto } from "./dto/ignore-bank-statement-line.dto";
import { CreateBankTransactionFromLineDto } from "./dto/create-bank-transaction-from-line.dto";
import { ListBankStatementImportsQueryDto } from "./dto/list-bank-statement-imports.query.dto";
import { ListBankStatementLinesQueryDto } from "./dto/list-bank-statement-lines.query.dto";

/// An explicit, bounded synchronous-upload cap (§5) — no queue/async
/// import exists to defer larger files to (§2.11/§20). 5 MB is generous
/// for the documented CSV_GENERIC contract's row shape while keeping
/// synchronous, in-request processing safely bounded.
const MAX_STATEMENT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * docs/finance-work-item-banking-1c-proposal.md §13, CTO-approved
 * (implementation-authorization turn). Same finance.poster-writes/
 * any-role-reads split as BankTransactionsController/
 * SupplierPaymentsController — a bank statement import is a DOCUMENT
 * (has a PENDING->VALIDATED/FAILED lifecycle and, separately, an
 * OPEN->COMPLETED reconciliation lifecycle), not master data like
 * bank-cash-accounts itself (§13).
 *
 * tenantId/legalEntityId always come from the verified JWT, never from a
 * request param/body, same convention as every other Finance controller.
 */
@Controller("bank-statement-imports")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BankReconciliationController {
  constructor(private readonly reconciliation: BankReconciliationService) {}

  @Post()
  @Roles("finance.poster")
  @UseInterceptors(FileInterceptor("file"))
  upload(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Body() dto: ImportBankStatementDto,
    // Deliberately NOT using ParseFilePipeBuilder#addFileTypeValidator:
    // Nest's built-in FileTypeValidator sniffs magic numbers via the
    // `file-type` package, which has no signature for plain-text
    // CSV/TXT content and always fails the check regardless of actual
    // extension/content — unsuitable for the CSV_GENERIC format (§7).
    // File type is instead validated by extension against the original
    // filename below; size stays enforced via the built-in validator.
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_STATEMENT_FILE_BYTES })
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
      "Bank statement imports require",
    );
    return this.reconciliation.importStatement(
      tenantId,
      legalEntityId,
      user.userId,
      dto,
      file.buffer,
      file.originalname,
    );
  }

  @Get()
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  list(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query() query: ListBankStatementImportsQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.list(tenantId, legalEntityId, query);
  }

  @Get(":id")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  findOne(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.findOne(tenantId, legalEntityId, id);
  }

  @Patch(":id")
  @Roles("finance.poster")
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateBankStatementImportDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.update(
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
      "Bank statement imports require",
    );
    return this.reconciliation.remove(tenantId, legalEntityId, user.userId, id);
  }

  @Post(":id/complete")
  @HttpCode(200)
  @Roles("finance.poster")
  complete(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.complete(
      tenantId,
      legalEntityId,
      user.userId,
      id,
    );
  }

  @Get(":id/lines")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listLines(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Query() query: ListBankStatementLinesQueryDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.listLines(tenantId, legalEntityId, id, query);
  }

  @Get(":id/lines/:lineId/suggestions")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  suggestions(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Param("lineId") lineId: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.suggestionsForLine(
      tenantId,
      legalEntityId,
      id,
      lineId,
    );
  }

  @Post(":id/lines/:lineId/ignore")
  @HttpCode(200)
  @Roles("finance.poster")
  ignoreLine(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Param("lineId") lineId: string,
    @Body() dto: IgnoreBankStatementLineDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.ignoreLine(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      lineId,
      dto,
    );
  }

  @Post(":id/lines/:lineId/create-bank-transaction")
  @Roles("finance.poster")
  createBankTransactionFromLine(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Param("lineId") lineId: string,
    @Body() dto: CreateBankTransactionFromLineDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.createBankTransactionFromLine(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      lineId,
      dto,
    );
  }

  @Get(":id/matches")
  @Roles("finance.viewer", "finance.poster", "finance.admin")
  listMatches(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.listMatches(tenantId, legalEntityId, id);
  }

  @Post(":id/matches")
  @Roles("finance.poster")
  createMatch(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Body() dto: CreateBankReconciliationMatchDto,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.createMatch(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      dto,
    );
  }

  @Post(":id/matches/:matchId/undo")
  @HttpCode(200)
  @Roles("finance.poster")
  undoMatch(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param("id") id: string,
    @Param("matchId") matchId: string,
  ) {
    const { tenantId, legalEntityId } = requireTenantContext(
      user,
      "Bank statement imports require",
    );
    return this.reconciliation.undoMatch(
      tenantId,
      legalEntityId,
      user.userId,
      id,
      matchId,
    );
  }
}
