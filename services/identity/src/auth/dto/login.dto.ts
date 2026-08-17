import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  /// Required when logging into a TENANT_INTERNAL/TENANT_EXTERNAL account —
  /// resolves which tenant's row to check, since email is only unique
  /// per-tenant (schema.ts users_tenant_email_unique constraint).
  /// Omitted for PLATFORM_OPERATOR accounts.
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  /// Present once the account has MFA enabled and the first factor already
  /// succeeded in a prior request (see AuthService.login's MFA_REQUIRED flow).
  @IsOptional()
  @IsString()
  mfaCode?: string;
}
