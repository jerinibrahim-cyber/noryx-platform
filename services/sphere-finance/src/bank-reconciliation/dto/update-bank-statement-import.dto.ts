import { IsInt, IsOptional } from "class-validator";

/**
 * docs/finance-work-item-banking-1c-proposal.md §7/§9/§15. A plain field
 * edit on the import header, available any time
 * `reconciliationStatus = OPEN` (service-enforced) — sets/corrects the
 * balance fields CSV_GENERIC cannot supply at parse time. Not a
 * general-purpose edit endpoint: no other column on
 * `bank_statement_imports` is editable through this DTO.
 */
export class UpdateBankStatementImportDto {
  @IsOptional()
  @IsInt()
  openingBalanceMinor?: number;

  @IsOptional()
  @IsInt()
  closingBalanceMinor?: number;
}
