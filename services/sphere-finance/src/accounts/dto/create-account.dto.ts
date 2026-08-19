import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

// Mirrors accountTypeEnum in ../../db/schema.ts. class-validator's IsEnum
// needs a plain object, not the Drizzle pgEnum value itself.
export const ACCOUNT_TYPES = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export class CreateAccountDto {
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

  @IsEnum(ACCOUNT_TYPES)
  type!: AccountType;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
