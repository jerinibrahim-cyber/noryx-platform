import { IsInt, IsOptional, IsUUID, Min } from "class-validator";

/// All fields optional — a PATCH only touches what it sends. Changing
/// accountId/periodId re-runs the same account-exists/period-exists/
/// Decision C period-alignment/duplicate-(budget,account,period) checks
/// as create() (contract §5), using the merged (existing + proposed)
/// values under the parent-row lock.
export class UpdateBudgetLineDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsUUID()
  periodId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountMinor?: number;
}
