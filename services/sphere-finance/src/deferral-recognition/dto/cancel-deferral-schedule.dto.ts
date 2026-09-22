import { IsOptional, IsString, MaxLength } from "class-validator";

// Direct copy of CancelScheduledReversalDto's shape/reasoning
// (scheduled-reversals/dto/cancel-scheduled-reversal.dto.ts) — optional
// free-text reason, purely informational, carried into the CANCEL audit
// row. No other field: cancellation never accepts an amendment; per
// CONTRACT.md §4/Phase 1.4 (Model B), amendment is cancel-then-create,
// composed by the caller.
export class CancelDeferralScheduleDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
