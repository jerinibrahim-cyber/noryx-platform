import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";

export const BANK_TRANSACTION_TYPES = [
  "TRANSFER",
  "DEPOSIT",
  "WITHDRAWAL",
  "FEE",
  "INTEREST",
] as const;
export type BankTransactionType = (typeof BANK_TRANSACTION_TYPES)[number];

/**
 * DTO-layer mirror of the `bank_transactions_transfer_counterparty_shape`
 * DB CHECK constraint (schema.ts, proposal §6.1): TRANSFER requires
 * exactly `counterpartyBankCashAccountId` (and forbids `glAccountId`);
 * every other type requires exactly `glAccountId` (and forbids
 * `counterpartyBankCashAccountId`).
 *
 * A single custom constraint, not a stack of `@ValidateIf` pairs, is used
 * deliberately: `@ValidateIf` only *skips* a field's own validators when
 * its condition is false — it does not, by itself, reject the field being
 * present when it shouldn't be (a TRANSFER payload that wrongly supplies
 * `glAccountId` instead of `counterpartyBankCashAccountId` would sail
 * through `@ValidateIf`-only validation, since `glAccountId` is a
 * declared, whitelisted property and its own `@IsUUID()` would simply be
 * skipped). No `@ValidateIf` precedent exists anywhere else in this
 * codebase to mirror instead (repo-wide grep, proposal §2.9) — this is a
 * genuinely new DTO-validation shape, so it is built explicit and
 * self-contained rather than leaning on a fragile decorator-stacking
 * trick.
 */
function IsValidBankTransactionAccountShape(
  validationOptions?: ValidationOptions,
) {
  return function (target: object, propertyName: string) {
    registerDecorator({
      name: "isValidBankTransactionAccountShape",
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const obj = args.object as {
            type?: string;
            counterpartyBankCashAccountId?: unknown;
            glAccountId?: unknown;
          };
          if (obj.type === "TRANSFER") {
            return (
              typeof obj.counterpartyBankCashAccountId === "string" &&
              obj.glAccountId === undefined
            );
          }
          // Any other declared type (an unrecognized `type` value is
          // separately rejected by @IsIn on the `type` field itself —
          // this constraint only governs the shape once `type` is known
          // to be one of the five valid values).
          return (
            typeof obj.glAccountId === "string" &&
            obj.counterpartyBankCashAccountId === undefined
          );
        },
        defaultMessage(_args: ValidationArguments) {
          return (
            "counterpartyBankCashAccountId is required (and glAccountId must be " +
            "omitted) when type is TRANSFER; glAccountId is required (and " +
            "counterpartyBankCashAccountId must be omitted) for every other type."
          );
        },
      },
    });
  };
}

/**
 * docs/finance-work-item-banking-1b-proposal.md §14. currencyCode/status/
 * internalReference/journalEntryId/periodId are deliberately absent — all
 * server-resolved, never client input, same convention as every existing
 * Finance create DTO (e.g. CreateSupplierPaymentDto).
 */
export class CreateBankTransactionDto {
  @IsIn(BANK_TRANSACTION_TYPES)
  @IsValidBankTransactionAccountShape()
  type!: BankTransactionType;

  @IsDateString()
  transactionDate!: string;

  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsUUID()
  bankCashAccountId!: string;

  /// Present only for TRANSFER (enforced by IsValidBankTransactionAccountShape
  /// above, anchored on `type`); format-checked here when present.
  @IsOptional()
  @IsUUID()
  counterpartyBankCashAccountId?: string;

  /// Present for every type except TRANSFER (enforced above); format-
  /// checked here when present. Type-specific chart-of-accounts-type
  /// validation (FEE->EXPENSE, INTEREST->REVENUE, DEPOSIT/WITHDRAWAL->
  /// ASSET/LIABILITY/EQUITY) happens in the service, not here — the same
  /// posture as every other GL-account-type check in this codebase (e.g.
  /// supplier-payments' ASSET check is service-layer, not a decorator).
  @IsOptional()
  @IsUUID()
  glAccountId?: string;

  // Free-text external reference (bank reference number, cheque number) —
  // deliberately no @Matches charset restriction, same reasoning as
  // CreateSupplierPaymentDto.reference.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;
}
