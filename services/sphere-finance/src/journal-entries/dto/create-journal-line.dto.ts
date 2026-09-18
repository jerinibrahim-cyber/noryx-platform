import {
  IsIn,
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

/**
 * Tax/VAT Phase 6 (docs/finance-work-item-tax-vat-phase-6-manual-journal-tax-coverage-proposal.md,
 * CTO-approved implementation authorization §8.3) — mirrors, but does
 * not replace, journal_lines' two DB CHECK constraints
 * (journal_lines_tax_direction_requires_code,
 * journal_lines_tax_code_requires_direction) added by migration 0024.
 * Same "clean 400 here instead of a raw constraint violation reaching
 * the API, DB constraint remains the real backstop" principle as
 * SingleSidedNonzeroConstraint above.
 */
@ValidatorConstraint({ name: "taxCodeDirectionPairing", async: false })
class TaxCodeDirectionPairingConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreateJournalLineDto;
    const hasCode = obj.taxCodeId !== undefined && obj.taxCodeId !== null;
    const hasDirection =
      obj.taxDirection !== undefined && obj.taxDirection !== null;
    return hasCode === hasDirection;
  }

  defaultMessage(): string {
    return "taxCodeId and taxDirection must both be provided or both omitted";
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

  /** Tax/VAT Phase 6 — optional manual tax classification. Both this
   * and taxDirection must be supplied together or omitted together
   * (TaxCodeDirectionPairingConstraint above); the referenced tax code
   * must exist, be active, and belong to the caller's own legal entity
   * (JournalEntriesService, both at draft time and again at post time —
   * see that service's findInvalidTaxCodeIds()). */
  @IsOptional()
  @IsUUID()
  @Validate(TaxCodeDirectionPairingConstraint)
  taxCodeId?: string;

  /** Tax/VAT Phase 6 — always explicit, never inferred from account,
   * debit/credit polarity, or tax-code configuration (see
   * journalLineTaxDirectionEnum's schema doc comment). The pairing
   * constraint is attached here too, not just on taxCodeId — class-
   * validator's @IsOptional() skips every OTHER decorator on a
   * property when THAT property's own value is undefined/null, so a
   * request supplying taxDirection alone (taxCodeId omitted) would
   * never reach TaxCodeDirectionPairingConstraint at all if it were
   * only attached to taxCodeId; attaching it on both properties
   * guarantees whichever one IS supplied still runs the pairing
   * check. */
  @IsOptional()
  @IsIn(["INPUT", "OUTPUT"])
  @Validate(TaxCodeDirectionPairingConstraint)
  taxDirection?: "INPUT" | "OUTPUT";
}
