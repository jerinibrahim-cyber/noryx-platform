import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from "class-validator";

/**
 * Mirrors, but does not replace, journal_lines' two DB CHECK constraints
 * from 2b (journal_lines_single_sided, journal_lines_nonzero) — a clean
 * 400 here instead of a raw constraint violation reaching the API, same
 * "better error message, DB constraint remains the real backstop"
 * principle used for accounting-period overlap.
 */
@ValidatorConstraint({ name: "singleSidedNonzero", async: false })
class SingleSidedNonzeroConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreateJournalLineDto;
    const debit = obj.debitMinor;
    const credit = obj.creditMinor;
    if (typeof debit !== "number" || typeof credit !== "number") {
      return true; // let @IsInt on each field report the real type error
    }
    if (debit === 0 && credit === 0) return false; // nonzero rule
    if (debit > 0 && credit > 0) return false; // single-sided rule
    return true;
  }

  defaultMessage(): string {
    return "exactly one of debitMinor/creditMinor must be greater than zero; the other must be exactly zero";
  }
}

// No lineNumber field, deliberately — the service assigns 1..N from
// array order (docs/finance-2c-journal-entry-service-proposal.md §4.1).
export class CreateJournalLineDto {
  @IsUUID()
  accountId!: string;

  @IsInt()
  @Min(0)
  @Validate(SingleSidedNonzeroConstraint)
  debitMinor!: number;

  @IsInt()
  @Min(0)
  creditMinor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
