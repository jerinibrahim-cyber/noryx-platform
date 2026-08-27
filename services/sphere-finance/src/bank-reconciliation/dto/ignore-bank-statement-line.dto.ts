import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * docs/finance-work-item-banking-1c-proposal.md §9/§10. `IGNORED` is an
 * explicit, recorded user action — never a default/inferred state
 * (§9) — for a line the user has determined needs no NoryX-side
 * counterpart at all. `reason` is optional free text, stored for audit
 * context only (proposal introduces no required-reason business rule).
 */
export class IgnoreBankStatementLineDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
