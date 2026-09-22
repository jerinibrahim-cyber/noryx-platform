import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

// Generic Deferral Recognition Engine — Phase 2 Implementation Contract
// (docs/work-items/deferral-recognition-engine/CONTRACT.md §1/§4).
// Occurrence amounts/dates are always explicit, client-supplied, never
// computed by even division (discovery §7/§9, CONTRACT.md §1) — one DTO
// entry per occurrence.
export class CreateDeferralOccurrenceDto {
  @IsDateString()
  targetDate!: string;

  @IsInt()
  @Min(1)
  amountMinor!: number;
}

// deferralType is a Phase 3 implementation micro-decision (see
// schema.ts's deferralTypeEnum doc comment) resolving CONTRACT.md §6's
// "debit/credit determined by the schedule's configured direction"
// into an explicit, client-supplied field — never inferred from account
// type, matching this schema's existing journalLineTaxDirectionEnum
// convention.
export class CreateDeferralScheduleDto {
  @IsString()
  @MaxLength(2000)
  memo!: string;

  @IsIn(["EXPENSE_RECOGNITION", "REVENUE_RECOGNITION"])
  deferralType!: "EXPENSE_RECOGNITION" | "REVENUE_RECOGNITION";

  @IsUUID()
  deferredAccountId!: string;

  @IsUUID()
  recognitionAccountId!: string;

  @IsInt()
  @Min(1)
  totalAmountMinor!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateDeferralOccurrenceDto)
  occurrences!: CreateDeferralOccurrenceDto[];
}
