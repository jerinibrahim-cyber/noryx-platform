import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/// tax_treatment enum, mirrored from schema.ts (no reverse charge in
/// MVP — CTO-approved architecture proposal §3/§6).
export enum TaxTreatment {
  STANDARD = "STANDARD",
  ZERO_RATED = "ZERO_RATED",
  EXEMPT = "EXEMPT",
}

/// Same "safe identifier" code shape as CreateSupplierDto — reusing the
/// established convention rather than inventing a second one for Tax
/// Configuration.
export class CreateTaxCodeDto {
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

  @IsEnum(TaxTreatment, {
    message: "treatment must be one of STANDARD, ZERO_RATED, EXEMPT",
  })
  treatment!: TaxTreatment;
}
