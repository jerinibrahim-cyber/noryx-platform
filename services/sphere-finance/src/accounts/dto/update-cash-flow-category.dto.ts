import { IsIn } from "class-validator";

// Mirrors cashFlowCategoryEnum in ../../db/schema.ts. class-validator's
// IsIn needs a plain array, not the Drizzle pgEnum value itself — same
// posture as CreateAccountDto's ACCOUNT_TYPES mirroring accountTypeEnum.
export const CASH_FLOW_CATEGORIES = [
  "OPERATING",
  "INVESTING",
  "FINANCING",
] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

/**
 * `PATCH /accounts/:id/cash-flow-category` body — Cash Flow Statement
 * work item (docs/finance-work-item-cash-flow-statement-proposal.md
 * §14.3/§20 of the proposal's numbering in its Rev 1/2 form, §7/§15.1 in
 * this revision). `cashFlowCategory` is deliberately a REQUIRED field
 * (not `@IsOptional()`) that explicitly accepts `null` as one of its
 * valid values — this is not an update-some-fields PATCH like
 * `UpdateBankCashAccountDto`; it has exactly one purpose, setting or
 * clearing this one classification, so there is no "omit it to leave
 * unchanged" case to support. Passing `null` explicitly un-classifies
 * the account, reverting it to the honestly-surfaced "Unclassified"
 * bucket (proposal §14) — this route is the only way to move an account
 * both into and back out of a classification.
 */
export class UpdateCashFlowCategoryDto {
  @IsIn([...CASH_FLOW_CATEGORIES, null])
  cashFlowCategory!: CashFlowCategory | null;
}
