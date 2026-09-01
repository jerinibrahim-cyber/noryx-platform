import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-banking-1e-proposal.md §19, CTO-approved.
 * `POST /payment-provider-settlements/:id/create-settlement-transactions`
 * — the settlement itself is identified by the route's `:id`; this body
 * supplies the two legs the settlement's own record cannot infer on its
 * own: which REAL Bank/Cash Account received the net transfer, and
 * which EXPENSE account the fee should be debited to. Both created
 * `bank_transactions` are DRAFT-only (§19, §29 Rule 6) — this action
 * never posts.
 */
export class CreateSettlementTransactionsDto {
  /// The REAL Bank/Cash Account (purpose = OPERATING, typically) that
  /// received the net settlement transfer — distinct from the
  /// settlement's own Clearing Account. Re-validated as an active
  /// Bank/Cash Account by BankTransactionsService.create() itself.
  @IsUUID()
  destinationBankCashAccountId!: string;

  /// Required unless the settlement's feeAmountMinor is 0 (validated in
  /// the service — a DTO-level @ValidateIf against another field's
  /// runtime value it cannot see is unreliable, same reasoning
  /// CreateBankTransactionDto's own custom validator documents).
  @IsOptional()
  @IsUUID()
  feeGlAccountId?: string;

  /// Defaults to the settlement's own settlementDate when omitted.
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}
