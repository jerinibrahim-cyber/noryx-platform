import { IsDateString, IsOptional, IsUUID, Validate } from "class-validator";
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { IsSameOrAfterDate } from "../../common/validators/is-same-or-after-date.validator";

/**
 * `periodId` is mutually exclusive with an explicit `dateFrom`/`dateTo` —
 * identical rule/reasoning/shape to `ProfitAndLossQueryDto`'s
 * `PeriodIdExcludesDateRangeConstraint` (profit-and-loss-query.dto.ts) —
 * `periodId` resolves its own `dateFrom`/`dateTo` from the period's
 * `startDate`/`endDate`, so combining it with an explicit range has no
 * coherent meaning.
 * docs/finance-work-item-cash-flow-statement-proposal.md §15.1.
 */
@ValidatorConstraint({
  name: "periodIdExcludesDateRangeCashFlow",
  async: false,
})
class PeriodIdExcludesDateRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no periodId — nothing to conflict with
    const obj = args.object as CashFlowQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other";
  }
}

/**
 * `GET /financial-statements/cash-flow` query params —
 * docs/finance-work-item-cash-flow-statement-proposal.md §15.1/§4. A
 * Cash Flow Statement is unambiguously a MOVEMENT statement (proposal
 * §4 of the earlier revisions, unchanged) — like `ProfitAndLossQueryDto`,
 * and unlike `BalanceSheetQueryDto`, there is no coherent single-point-
 * in-time "cash flow," so this DTO deliberately has no `asOf` field.
 *
 * `dateFrom` defaults to open-ended (from account inception, opening
 * cash treated as `0`) when omitted, `dateTo` defaults to today (UTC)
 * when omitted — identical defaulting convention to
 * `ProfitAndLossQueryDto`, applied in the service, not this DTO.
 */
export class CashFlowQueryDto {
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
