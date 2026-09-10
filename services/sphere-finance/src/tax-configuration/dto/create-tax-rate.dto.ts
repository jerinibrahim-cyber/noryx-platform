import { IsDateString, IsInt, IsOptional, Max, Min } from "class-validator";
import { IsAfterDate } from "../../common/validators/is-after-date.validator";

/**
 * Tax Rate — create-only (no PATCH/DELETE route exists at all; a
 * correction is a new row, not an edit — schema.ts's doc comment on
 * taxRates). `rateBasisPoints` is bounded to [0, 10000] (0%-100%) as a
 * sanity bound only, same posture as CreateSupplierDto.paymentTermsDays
 * — not an encoding of any real statutory rate ceiling.
 *
 * `effectiveTo` is optional (open-ended/still-current when omitted) and,
 * when supplied, must be strictly after `effectiveFrom` — @IsAfterDate
 * is the same friendly pre-check CreateAccountingPeriodDto.endDate uses;
 * it does not replace the real DB constraint
 * (tax_rates_end_after_start / tax_rates_no_overlap), only gives a
 * clean 400 before the request reaches Postgres.
 */
export class CreateTaxRateDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  rateBasisPoints!: number;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  @IsAfterDate("effectiveFrom", {
    message: "effectiveTo must be after effectiveFrom",
  })
  effectiveTo?: string;
}
