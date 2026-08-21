import { Type } from "class-transformer";
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { IsSameOrAfterDate } from "../../common/validators/is-same-or-after-date.validator";

/**
 * `periodId` is mutually exclusive with an explicit `dateFrom`/`dateTo`
 * — §2.1.2's final decision
 * (docs/finance-2d-general-ledger-read-layer-proposal.md §0.1/§0.2):
 * "cannot combine periodId with an explicit date range". Attached to
 * `periodId` so the 400 fires whichever of `dateFrom`/`dateTo` (or both)
 * is also present — approved as final in review, not open for
 * reconsideration.
 */
@ValidatorConstraint({ name: "periodIdExcludesDateRange", async: false })
class PeriodIdExcludesDateRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no periodId — nothing to conflict with
    const obj = args.object as LedgerQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other (§2.1.2)";
  }
}

/**
 * `GET /accounts/:id/ledger` query params — §2.1.2/§2.1.7 of the 2d
 * proposal. `page`/`pageSize` default via plain class-field
 * initializers, applied by the global `ValidationPipe({transform:
 * true})` the same way `@Type(() => Number)` coerces the incoming
 * query-string values to numbers before `@IsInt`/`@Min`/`@Max` run.
 */
export class LedgerQueryDto {
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 50;
}
