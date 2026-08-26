import { Transform } from "class-transformer";
import {
  IsBoolean,
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
 * same rule, same reasoning, and the same constraint shape as
 * `LedgerQueryDto`'s `PeriodIdExcludesDateRangeConstraint`
 * (general-ledger/dto/ledger-query.dto.ts) — `periodId` resolves its own
 * `dateFrom`/`dateTo` from the period's `startDate`/`endDate`, so
 * combining it with an explicit range has no coherent meaning.
 * docs/finance-work-item-financial-statements-proposal.md §5.1.
 */
@ValidatorConstraint({ name: "periodIdExcludesDateRangePnl", async: false })
class PeriodIdExcludesDateRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true; // no periodId — nothing to conflict with
    const obj = args.object as ProfitAndLossQueryDto;
    return obj.dateFrom === undefined && obj.dateTo === undefined;
  }

  defaultMessage(): string {
    return "cannot combine periodId with an explicit dateFrom/dateTo — supply one or the other";
  }
}

/**
 * `GET /financial-statements/profit-and-loss` query params — §5.1 of the
 * proposal. P&L is a MOVEMENT statement (§6.1/§6.2): unlike Balance
 * Sheet/Trial Balance/Account Balance's `asOf` mode, there is no
 * coherent single-point-in-time P&L, so this DTO deliberately has no
 * `asOf` field at all.
 *
 * `dateFrom` defaults to open-ended (from account inception) when
 * omitted, `dateTo` defaults to today (UTC) when omitted — identical
 * defaulting convention to `GeneralLedgerService.getLedger`'s
 * `effectiveDateFrom`/`effectiveDateTo` resolution (§2.8 of the
 * proposal), applied in the service, not this DTO.
 */
export class ProfitAndLossQueryDto {
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

  /** Mirrors `TrialBalanceQueryDto.includeZeroBalance` (§7.5 of the
   * proposal) — a node with a zero own-balance and no included
   * descendant is dropped from the response by default; a zero-balance
   * node that is a necessary structural ancestor of an included node is
   * never dropped regardless of this flag (§7.5's "structural ancestor"
   * rule, applied in the service, not this DTO). */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value; // let @IsBoolean report anything else as invalid
  })
  @IsBoolean()
  includeZeroBalance: boolean = false;
}
