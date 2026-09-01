import { IsIn, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export const PAYMENT_SETTLEMENT_MATCH_TYPES = [
  "DETERMINISTIC_MATCH",
  "MANUAL",
] as const;
export type PaymentSettlementMatchType =
  (typeof PAYMENT_SETTLEMENT_MATCH_TYPES)[number];

/**
 * docs/finance-work-item-banking-1e-proposal.md §10, CTO-approved.
 * `POST /payment-provider-settlements/:id/match` — the settlement is
 * identified by the route's `:id`; this body identifies the bank
 * statement line side of the match. Mirrors
 * CreateBankReconciliationMatchDto exactly: `matchedAmountMinor` is
 * always explicit (no implicit "whatever's left" default),
 * `matchType: "DETERMINISTIC_MATCH"` is independently re-verified
 * server-side against the deterministic rule, never trusted from client
 * input alone.
 */
export class CreatePaymentSettlementMatchDto {
  @IsUUID()
  bankStatementLineId!: string;

  @IsInt()
  @Min(1)
  matchedAmountMinor!: number;

  @IsOptional()
  @IsIn(PAYMENT_SETTLEMENT_MATCH_TYPES)
  matchType?: PaymentSettlementMatchType; // defaults to MANUAL.
}
