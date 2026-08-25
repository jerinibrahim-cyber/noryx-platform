import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-1b-supplier-bills-proposal.md §17. Mirrors
 * CreateJournalLineDto's shape, not its single-sided debit/credit
 * constraint — bill lines are single-sided by nature (one amount, one
 * account), not by a validated two-field invariant.
 *
 * No lineNumber field, deliberately — SupplierBillsService assigns
 * 1..N from array order, same convention as JournalEntriesService.
 */
export class CreateSupplierBillLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // > 0, not >= 0: a zero-amount bill line is meaningless — matches
  // journal_lines_nonzero's spirit, expressed here as a plain Min(1)
  // since a bill line has only one side, not the two-sided
  // single-sided/nonzero constraint journal lines need.
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  taxAmountMinor?: number;
}
