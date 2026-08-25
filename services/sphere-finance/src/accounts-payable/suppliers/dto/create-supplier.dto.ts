import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/// Same code shape/validation as CreateAccountDto (../../accounts/dto/create-account.dto.ts)
/// — reusing the established "safe identifier" convention rather than
/// inventing a second one for AP.
export class CreateSupplierDto {
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

  /// Net payment terms in days (e.g. 30 for "Net 30"). Bounded to a
  /// generous but finite range to reject nonsense input, not to encode
  /// any real business rule.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  paymentTermsDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRegistrationNo?: string;

  @IsOptional()
  @IsUUID()
  defaultExpenseAccountId?: string;
}
