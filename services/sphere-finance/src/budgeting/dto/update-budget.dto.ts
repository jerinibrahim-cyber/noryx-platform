import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/// All fields optional — a PATCH only touches what it sends. name/
/// startDate/endDate may each be omitted independently. Cross-field
/// end-after-start validation is NOT expressed with @IsAfterDate here
/// (unlike CreateBudgetDto) because a PATCH may change only one of the
/// two dates, or neither — the real end-after-start check, and the
/// Decision C existing-line re-validation, both require the CURRENT
/// persisted row merged with whatever the PATCH proposes, which only
/// BudgetsService.update() has (under the parent-row lock) — see
/// contract §0b/§5.
export class UpdateBudgetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
