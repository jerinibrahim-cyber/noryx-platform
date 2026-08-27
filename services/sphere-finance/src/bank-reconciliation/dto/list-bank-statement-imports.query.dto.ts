import { IsIn, IsOptional, IsUUID } from "class-validator";
import {
  BANK_STATEMENT_IMPORT_STATUSES,
  BANK_RECONCILIATION_STATUSES,
} from "./bank-reconciliation-enums";

export class ListBankStatementImportsQueryDto {
  @IsOptional()
  @IsUUID()
  bankCashAccountId?: string;

  @IsOptional()
  @IsIn(BANK_STATEMENT_IMPORT_STATUSES)
  status?: (typeof BANK_STATEMENT_IMPORT_STATUSES)[number];

  @IsOptional()
  @IsIn(BANK_RECONCILIATION_STATUSES)
  reconciliationStatus?: (typeof BANK_RECONCILIATION_STATUSES)[number];
}
