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
 *
 * taxCodeId — Tax/VAT Phase 2
 * (docs/finance-work-item-tax-vat-phase-2-discovery.md §3/§6). Optional:
 * omitted preserves 100% of pre-Phase-2 behavior (taxAmountMinor stays
 * a plain manual value). When supplied, SupplierBillsService resolves
 * and snapshots the effective tax rate and treats taxAmountMinor (if
 * also supplied) as an explicit override — see that service's
 * insertLines() doc comment. taxRateId/taxAmountCalculatedMinor/
 * taxAmountOverridden are server-computed, never client-supplied, so
 * they are deliberately not DTO fields.
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

  @IsOptional()
  @IsUUID()
  taxCodeId?: string;
}
