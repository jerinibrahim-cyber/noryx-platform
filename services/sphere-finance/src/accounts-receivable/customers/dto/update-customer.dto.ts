import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/// `code` is deliberately not editable here — same posture as suppliers,
/// chart_of_accounts, and journal_entries treating their own identifying
/// code/number as set-once. Every other master-data field can change.
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  paymentTermsDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRegistrationNo?: string;

  /// Nullable-in-effect: passing an empty string is rejected by @IsUUID,
  /// so clearing this field is out of scope for AR-1a's PATCH (no partial
  /// "unset" semantics implemented) — matches UpdateSupplierDto's
  /// identical posture on defaultExpenseAccountId.
  @IsOptional()
  @IsUUID()
  defaultRevenueAccountId?: string;
}
