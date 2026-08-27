import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/// Mirrors bankCashAccountKindEnum in ../../db/schema.ts. class-validator's
/// IsEnum needs a plain object, not the Drizzle pgEnum value itself — same
/// approach as ACCOUNT_TYPES in ../../accounts/dto/create-account.dto.ts.
export const BANK_CASH_ACCOUNT_KINDS = ["BANK", "CASH"] as const;
export type BankCashAccountKind = (typeof BANK_CASH_ACCOUNT_KINDS)[number];

/// Same code shape/validation as CreateSupplierDto/CreateAccountDto — the
/// established "safe identifier" convention, not a new one.
export class CreateBankCashAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: "code may only contain letters, numbers, '.', '_', '-'",
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsEnum(BANK_CASH_ACCOUNT_KINDS)
  kind!: BankCashAccountKind;

  /// Validated by BankCashAccountsService at write time: must exist, be
  /// ACTIVE, be of type ASSET, belong to the caller's own legal entity,
  /// and not already be claimed by another active Bank/Cash Account
  /// (bank_cash_accounts_gl_account_unique). Never re-checked at read
  /// time — a Bank/Cash Account stays readable even if its GL account is
  /// later deactivated (locked CTO correction).
  @IsUUID()
  glAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  maskedAccountNumber?: string;
}
