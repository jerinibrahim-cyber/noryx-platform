import {
  IsDateString,
  IsOptional,
  IsUUID,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { IsSameOrAfterDate } from "../../common/validators/is-same-or-after-date.validator";

/**
 * `asOf` ("as-of a single point") is mutually exclusive with the range
 * inputs `dateFrom`/`dateTo`/`periodId` — §3.1.1: "mixing 'as of a
 * single point' with 'a range' has no coherent combined meaning, so 2d
 * rejects rather than guessing which one wins."
 */
@ValidatorConstraint({ name: "asOfExcludesRange", async: false })
class AsOfExcludesRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no asOf — nothing to conflict with
    const obj = args.object as AccountBalanceQueryDto;
    return (
      obj.dateFrom === undefined &&
      obj.dateTo === undefined &&
      obj.periodId === undefined
    );
  }

  defaultMessage(): string {
    return "cannot combine asOf with dateFrom/dateTo/periodId — asOf is a single-point snapshot, the others describe a range (§3.1.1)";
  }
}

/**
 * `periodId` is independently mutually exclusive with an explicit
 * `dateFrom`/`dateTo` — same §2.1.2 rule reused for Account Balance's
 * own range mode (§3.1.1), so `periodId` + `dateFrom` (with no `asOf`
 * present at all) is still rejected, not merely `periodId` + `asOf`.
 */
@ValidatorConstraint({ name: "periodIdExcludesDateRangeBalance", async: false })
class PeriodIdExcludesDateRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true;
    const obj = args.object as AccountBalanceQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other (§2.1.2)";
  }
}

/**
 * `GET /accounts/:id/balance` query params — §3.1.1 of the 2d proposal.
 * No pagination (single computed answer, §3.1.4).
 */
export class AccountBalanceQueryDto {
  @IsOptional()
  @IsDateString()
  @Validate(AsOfExcludesRangeConstraint)
  asOf?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  @IsSameOrAfterDate("dateFrom", {
    message: "dateTo must be the same date as, or after, dateFrom",
  })
  dateTo?: string;

  @IsOptional()
  @IsUUID()
  @Validate(PeriodIdExcludesDateRangeConstraint)
  periodId?: string;
}
