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
 * `asOf` and `periodId` are mutually exclusive on Trial Balance — §5.1.2
 * (final decision, §0.1/§0.2): "do not accept periodId together with
 * asOf". Trial Balance deliberately has no `dateFrom`/`dateTo` at all
 * (§4.5) — it is always a point-in-time snapshot, never a movement
 * window, so there is no third range mode to guard against here.
 */
@ValidatorConstraint({ name: "asOfExcludesPeriodId", async: false })
class AsOfExcludesPeriodIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true;
    const obj = args.object as TrialBalanceQueryDto;
    return obj.periodId === undefined;
  }

  defaultMessage(): string {
    return "cannot combine asOf with periodId — periodId resolves its own asOf from the period's endDate (§5.1.2)";
  }
}

/**
 * `GET /trial-balance` query params — §5.1.1/§5.1.2/§4.6 of the 2d
 * proposal. No pagination (§5.1.5 — the whole point of a trial balance
 * is an internally-consistent grand total over the full response).
 */
export class TrialBalanceQueryDto {
  @IsOptional()
  @IsDateString()
  @Validate(AsOfExcludesPeriodIdConstraint)
  asOf?: string;

  @IsOptional()
  @IsUUID()
  periodId?: string;

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
