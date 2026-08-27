import { IsDateString, IsOptional, IsUUID } from "class-validator";

/**
 * `GET /bank-reports/unreconciled-transactions` query params —
 * Banking-1d (docs/finance-work-item-banking-1d-proposal.md §2.3).
 * `bankCashAccountId` is optional — omitted means legal-entity-wide,
 * evaluating every POSTED bank transaction on its primary leg and, for
 * TRANSFER, additionally on its counterparty leg (§2.3); supplied means
 * scoped to that one account/leg only. `asOf` defaults to today
 * (`transactionDate <= asOf`), the same convention as AP-1d/AR-1d
 * ageing's own `asOf`.
 */
export class UnreconciledTransactionsQueryDto {
  @IsOptional()
  @IsUUID()
  bankCashAccountId?: string;

  @IsOptional()
  @IsDateString()
  asOf?: string;
}
