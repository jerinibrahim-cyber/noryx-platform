import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. Exact
 * mirror of CreateSupplierBillLineDto's shape — a debit-note line is
 * single-sided by nature (one amount, one account), not by a validated
 * two-field invariant, same reasoning as the bill line it corrects.
 *
 * No lineNumber field, deliberately — SupplierDebitNotesService assigns
 * 1..N from array order, same convention as SupplierBillsService.
 */
export class CreateSupplierDebitNoteLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // > 0, not >= 0: a zero-amount debit-note line is meaningless — same
  // reasoning as CreateSupplierBillLineDto.amountMinor.
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  taxAmountMinor?: number;
}
