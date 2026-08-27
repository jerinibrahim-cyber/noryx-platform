import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  BANK_CASH_ACCOUNT_KINDS,
  type BankCashAccountKind,
} from "./create-bank-cash-account.dto";

/// `code` is deliberately not editable here — same posture as
/// suppliers/customers/chart_of_accounts treating their own identifying
/// code as set-once. Every other field can change, including `kind` and
/// `glAccountId` (an admin correcting a mis-set GL link, or re-typing a
/// cash till as a bank account, is a legitimate master-data edit — same
/// posture as SuppliersService allowing defaultExpenseAccountId to be
/// re-pointed). A re-supplied glAccountId is re-validated by
/// BankCashAccountsService exactly as at create time (active + ASSET +
/// own legal entity + not already claimed by a DIFFERENT Bank/Cash
/// Account).
export class UpdateBankCashAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsEnum(BANK_CASH_ACCOUNT_KINDS)
  kind?: BankCashAccountKind;

  @IsOptional()
  @IsUUID()
  glAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  maskedAccountNumber?: string;
}
