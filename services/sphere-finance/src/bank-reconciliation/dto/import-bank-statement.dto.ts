import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";

export const BANK_STATEMENT_SOURCE_FORMATS = ["CSV_GENERIC"] as const;
export type BankStatementSourceFormat =
  (typeof BANK_STATEMENT_SOURCE_FORMATS)[number];

/**
 * docs/finance-work-item-banking-1c-proposal.md §5/§6/§7, CTO-approved.
 * The multipart form fields alongside the uploaded file
 * (`POST /bank-statement-imports`, `multipart/form-data`) — the file
 * itself arrives via `@UploadedFile()`
 * (`BankStatementImportsController.upload`), not as a DTO field.
 *
 * currencyCode/tenantId/legalEntityId/fileHash/status/
 * reconciliationStatus are deliberately absent — all server-resolved,
 * never client input, same convention as every other Finance create DTO.
 * openingBalanceMinor/closingBalanceMinor are optional at import time
 * (§7) — CSV_GENERIC carries no balance fields, so a valid import may
 * declare neither; closingBalanceMinor becomes required only at
 * completion time (§9/§15, service-layer, not here).
 *
 * multipart/form-data fields always arrive as strings — `@Type()`
 * coercion is required for the two optional numeric fields (ValidationPipe's
 * `transform: true` alone does not coerce multipart string fields the way
 * it coerces query-string fields).
 */
export class ImportBankStatementDto {
  @IsUUID()
  bankCashAccountId!: string;

  @IsOptional()
  @IsIn(BANK_STATEMENT_SOURCE_FORMATS)
  sourceFormat?: BankStatementSourceFormat; // defaults to CSV_GENERIC — the only MVP value (§7).

  @IsDateString()
  statementDateFrom!: string;

  @IsDateString()
  statementDateTo!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  openingBalanceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  closingBalanceMinor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string; // falls back to the uploaded file's own originalname.
}
