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
 * `periodId` is mutually exclusive with an explicit `dateFrom`/`dateTo` —
 * identical rule, reasoning, and shape to `ProfitAndLossQueryDto`'s own
 * `PeriodIdExcludesDateRangeConstraint`
 * (financial-statements/dto/profit-and-loss-query.dto.ts) and
 * `LedgerQueryDto`'s `PeriodIdExcludesDateRangeConstraint`
 * (general-ledger/dto/ledger-query.dto.ts): `periodId` resolves its own
 * `dateFrom`/`dateTo` from the period's `startDate`/`endDate`, so
 * combining it with an explicit range has no coherent meaning.
 * docs/finance-work-item-tax-vat-phase-4-discovery.md §3.4/§6.2.
 */
@ValidatorConstraint({ name: "periodIdExcludesDateRangeVat", async: false })
class PeriodIdExcludesDateRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no periodId — nothing to conflict with
    const obj = args.object as VatPositionQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other";
  }
}

/**
 * `GET /tax-reports/vat-position` query params —
 * docs/finance-work-item-tax-vat-phase-4-discovery.md §3.4/§6.2. VAT
 * position is a MOVEMENT report (§3.4 of the discovery, mirroring
 * `ProfitAndLossQueryDto`'s own reasoning): only documents dated
 * strictly within `[dateFrom, dateTo]` count, never a cumulative-since-
 * inception snapshot — unlike Trial Balance/Balance Sheet/Account
 * Balance's `asOf` mode, there is no coherent single-point-in-time VAT
 * position, so this DTO deliberately has no `asOf` field at all.
 *
 * `dateFrom`/`dateTo` are both REQUIRED when `periodId` is not supplied
 * (validated in the service, not here — see
 * `TaxReportsService.getVatPosition`'s explicit resolution branch):
 * unlike P&L's open-ended-by-default `dateFrom`, a VAT position report
 * with no lower bound at all would aggregate every posted document ever
 * created, which is never a coherent "VAT position" for a filing
 * period — so the discovery's recommendation (§6.2) is to require an
 * explicit window one way or the other, not silently default it.
 */
export class VatPositionQueryDto {
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
