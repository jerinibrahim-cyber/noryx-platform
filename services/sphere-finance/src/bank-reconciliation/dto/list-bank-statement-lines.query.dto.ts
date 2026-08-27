import { IsIn, IsOptional } from "class-validator";
import { BANK_STATEMENT_LINE_MATCH_STATUSES } from "./bank-reconciliation-enums";

export class ListBankStatementLinesQueryDto {
  @IsOptional()
  @IsIn(BANK_STATEMENT_LINE_MATCH_STATUSES)
  matchStatus?: (typeof BANK_STATEMENT_LINE_MATCH_STATUSES)[number];
}
