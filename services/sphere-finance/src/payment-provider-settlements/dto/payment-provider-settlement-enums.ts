/// Mirrors the pgEnum values in ../../db/schema.ts. class-validator's
/// IsIn/IsEnum needs a plain array, not the Drizzle pgEnum value itself —
/// same approach as BANK_CASH_ACCOUNT_KINDS/BANK_STATEMENT_SOURCE_FORMATS.
export const PAYMENT_PROVIDER_SETTLEMENT_IMPORT_STATUSES = [
  "PENDING",
  "VALIDATED",
  "FAILED",
] as const;

export const PAYMENT_SETTLEMENT_RECONCILIATION_STATUSES = [
  "OPEN",
  "COMPLETED",
] as const;

export const PAYMENT_SETTLEMENT_MATCH_STATUSES = [
  "UNMATCHED",
  "PARTIALLY_MATCHED",
  "MATCHED",
  "IGNORED",
] as const;
