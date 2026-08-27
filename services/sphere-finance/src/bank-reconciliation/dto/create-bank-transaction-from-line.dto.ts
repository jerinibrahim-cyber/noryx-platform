import {
  Equals,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

/// A statement line is single-sided (one bank_cash_account, no
/// counterparty context) — TRANSFER is deliberately excluded here, same
/// reasoning CreateBankTransactionDto's own shape constraint encodes for
/// every non-TRANSFER type: exactly one external glAccountId leg.
export const CREATE_FROM_LINE_BANK_TRANSACTION_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "FEE",
  "INTEREST",
] as const;
export type CreateFromLineBankTransactionType =
  (typeof CREATE_FROM_LINE_BANK_TRANSACTION_TYPES)[number];

/**
 * docs/finance-work-item-banking-1c-proposal.md §10, CTO-approved.
 * `POST /bank-statement-imports/:id/lines/:lineId/create-bank-transaction`.
 * Pre-fills `transactionDate`/`amountMinor`/`bankCashAccountId` from the
 * statement line itself (service-resolved, not client input here) and
 * calls `BankTransactionsService.create()` verbatim (§10) — the user
 * still explicitly picks `type` and, for every type here, `glAccountId`
 * (the offset leg), exactly as `CreateBankTransactionDto` already
 * requires for a non-TRANSFER type.
 *
 * `acknowledgeDuplicationWarning` must be `true` — the explicit,
 * CTO-flagged AP/AR/manual-journal-duplication warning (§10) is a
 * required, informed user decision, not a passive notice. A request
 * omitting it, or sending `false`, is rejected by the DTO itself before
 * the service runs.
 */
export class CreateBankTransactionFromLineDto {
  @IsIn(CREATE_FROM_LINE_BANK_TRANSACTION_TYPES)
  type!: CreateFromLineBankTransactionType;

  @IsUUID()
  glAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @Equals(true, {
    message:
      "acknowledgeDuplicationWarning must be true — confirm this line has no existing accounting record (Supplier Payment, Customer Receipt, or manual Journal Entry) before creating a new Bank Transaction from it.",
  })
  acknowledgeDuplicationWarning!: boolean;
}
