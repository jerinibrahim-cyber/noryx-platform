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

/**
 * `asOf` and `periodId` are mutually exclusive on Balance Sheet — same
 * rule, same reasoning, and the same constraint shape as
 * `TrialBalanceQueryDto`'s `AsOfExcludesPeriodIdConstraint`
 * (general-ledger/dto/trial-balance-query.dto.ts): a Balance Sheet, like
 * a Trial Balance, is always a point-in-time snapshot, never a range, so
 * there is no third mode to guard against here either.
 * docs/finance-work-item-financial-statements-proposal.md §5.2.
 */
@ValidatorConstraint({ name: "asOfExcludesPeriodIdBalanceSheet", async: false })
class AsOfExcludesPeriodIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true;
    const obj = args.object as BalanceSheetQueryDto;
    return obj.periodId === undefined;
  }

  defaultMessage(): string {
    return "cannot combine asOf with periodId — periodId resolves its own asOf from the period's endDate, and additionally enables the prior/current earnings split";
  }
}

/**
 * `GET /financial-statements/balance-sheet` query params — §5.2 of the
 * proposal. `asOf` defaults to today (UTC) when neither `asOf` nor
 * `periodId` is given — same defaulting convention as
 * `TrialBalanceQueryDto`, applied in the service.
 *
 * `periodId`, when supplied, additionally enables the prior-period vs.
 * current-period accumulated-earnings split (§9.3 of the proposal) —
 * `asOf`-only mode reports a single cumulative accumulated-earnings
 * figure with no split (§9.3, mirroring `AccountBalanceQueryDto`'s own
 * asOf-mode, which likewise reports no opening/movement split unless a
 * range or period is given).
 */
export class BalanceSheetQueryDto {
  @IsOptional()
  @IsDateString()
  @Validate(AsOfExcludesPeriodIdConstraint)
  asOf?: string;

  @IsOptional()
  @IsUUID()
  periodId?: string;

  /** Mirrors `TrialBalanceQueryDto.includeZeroBalance` (§7.5 of the
   * proposal) — same semantics as `ProfitAndLossQueryDto`'s field of the
   * same name; see that DTO's doc comment. */
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
