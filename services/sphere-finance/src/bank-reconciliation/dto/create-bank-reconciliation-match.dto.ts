import { IsIn, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export const BANK_RECONCILIATION_MATCH_TYPES = [
  "DETERMINISTIC_MATCH",
  "MANUAL",
] as const;
export type BankReconciliationMatchType =
  (typeof BANK_RECONCILIATION_MATCH_TYPES)[number];

/**
 * docs/finance-work-item-banking-1c-proposal.md §8/§9, CTO-approved.
 * `POST /bank-statement-imports/:id/matches`. Covers both the manual
 * multi-select flow (`matchType: "MANUAL"`, the default) and confirming
 * a `DETERMINISTIC_MATCH`-tier suggestion (`matchType:
 * "DETERMINISTIC_MATCH"`) through the SAME endpoint — the service
 * independently re-verifies the deterministic rule (same account/amount/
 * direction, `transactionDate` within tolerance of `lineDate`, exactly
 * one qualifying candidate) whenever `matchType = "DETERMINISTIC_MATCH"`
 * is requested, rather than trusting the client's own claim (proposal
 * §8's "every suggestion is reproducible from the same inputs" —
 * verified server-side, not merely computed once and handed to the
 * client). A client cannot force a DETERMINISTIC_MATCH row into
 * existence for a pair that does not actually satisfy the rule.
 *
 * `matchedAmountMinor` is always explicit, even for a full-amount
 * automatic match — no implicit "whatever's left" default, matching
 * `matchedAmountMinor`'s load-bearing role in partial-matching (§8).
 */
export class CreateBankReconciliationMatchDto {
  @IsUUID()
  statementLineId!: string;

  @IsUUID()
  bankTransactionId!: string;

  @IsInt()
  @Min(1)
  matchedAmountMinor!: number;

  @IsOptional()
  @IsIn(BANK_RECONCILIATION_MATCH_TYPES)
  matchType?: BankReconciliationMatchType; // defaults to MANUAL.
}
