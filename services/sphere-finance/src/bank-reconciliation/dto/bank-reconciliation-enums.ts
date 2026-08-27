/// Mirrors the DB enums in src/db/schema.ts — kept as plain TS const
/// arrays here (not imported from drizzle's pgEnum) for the same reason
/// BANK_TRANSACTION_TYPES is a local const array in
/// create-bank-transaction.dto.ts: DTO-layer validation (`@IsIn`) is a
/// distinct concern from the DB enum, even though the values match.
export const BANK_STATEMENT_IMPORT_STATUSES = [
  "PENDING",
  "VALIDATED",
  "FAILED",
] as const;
export type BankStatementImportStatus =
  (typeof BANK_STATEMENT_IMPORT_STATUSES)[number];

export const BANK_RECONCILIATION_STATUSES = ["OPEN", "COMPLETED"] as const;
export type BankReconciliationStatus =
  (typeof BANK_RECONCILIATION_STATUSES)[number];

export const BANK_STATEMENT_LINE_MATCH_STATUSES = [
  "UNMATCHED",
  "PARTIALLY_MATCHED",
  "MATCHED",
  "IGNORED",
] as const;
export type BankStatementLineMatchStatus =
  (typeof BANK_STATEMENT_LINE_MATCH_STATUSES)[number];
