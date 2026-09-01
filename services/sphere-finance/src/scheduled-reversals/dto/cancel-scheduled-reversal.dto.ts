import { IsOptional, IsString, MaxLength } from "class-validator";

// §8: optional free-text reason, purely informational — carried into
// the CANCEL audit row (§14). No other field: cancellation never
// accepts a target status/date override — cancel-then-recreate is the
// supported way to change a schedule (§8's deliberate API-minimalism
// decision).
export class CancelScheduledReversalDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
