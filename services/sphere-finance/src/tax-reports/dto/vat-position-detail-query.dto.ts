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
 * `periodId` is mutually exclusive with an explicit `dateFrom`/`dateTo` —
 * identical rule/shape to `VatPositionQueryDto`'s own
 * `PeriodIdExcludesDateRangeConstraint` (vat-position-query.dto.ts) and
 * `LedgerQueryDto`'s (general-ledger/dto/ledger-query.dto.ts). Tax/VAT
 * Phase 7, CONTRACT.md §8/§21.
 */
@ValidatorConstraint({
  name: "periodIdExcludesDateRangeVatDetail",
  async: false,
})
class PeriodIdExcludesDateRangeConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no periodId — nothing to conflict with
    const obj = args.object as VatPositionDetailQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other";
  }
}

/**
 * `GET /tax-reports/vat-position-detail` query params — Tax/VAT Phase 7
 * (docs/work-items/tax-vat-phase-7-vat-position-detail-drill-down/CONTRACT.md
 * §8, §9, §15). Same required-window shape as `VatPositionQueryDto`
 * (`periodId` XOR `dateFrom`+`dateTo`, validated in the service, not
 * here — identical reasoning to `TaxReportsService.getVatPosition`'s own
 * explicit resolution branch, reused unmodified for this endpoint),
 * plus an optional `taxCodeId` narrow filter (§8) and the exact
 * `page`/`pageSize` pagination shape reused verbatim from
 * `LedgerQueryDto` (§9 — identical defaults, identical bounds, no new
 * pagination validation model invented).
 */
export class VatPositionDetailQueryDto {
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
  @IsUUID()
  taxCodeId?: string;

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
