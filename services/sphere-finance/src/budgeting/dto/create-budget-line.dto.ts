import { IsInt, IsUUID, Min } from "class-validator";

/// CTO Decision A (contract §0/§5/§10): amountMinor is a non-negative
/// magnitude, not a signed debit/credit amount — mirrors the @Min(0)
/// shape used for journal_lines' debitMinor/creditMinor, but with no
/// polarity/single-sided rule (there is only one amount, not two).
export class CreateBudgetLineDto {
  @IsUUID()
  accountId!: string;

  @IsUUID()
  periodId!: string;

  @IsInt()
  @Min(0)
  amountMinor!: number;
}
