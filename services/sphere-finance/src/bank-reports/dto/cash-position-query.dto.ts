import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsOptional } from "class-validator";

/**
 * `GET /bank-reports/cash-position` query params — Banking-1d
 * (docs/finance-work-item-banking-1d-proposal.md §2.1). `asOf` defaults
 * to today (resolved in the service, the same `todayUtc()` pattern
 * GL/AP-1d/AR-1d already use). `includeInactive` defaults `false` and
 * uses the identical string-coercion `Transform` shape
 * `TrialBalanceQueryDto.includeZeroBalance` already established, mirroring
 * `BankCashAccountsService.list`'s own `includeInactive` semantics
 * exactly — a deactivated Bank/Cash Account is excluded from the position
 * by default.
 */
export class CashPositionQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value; // let @IsBoolean report anything else as invalid
  })
  @IsBoolean()
  includeInactive: boolean = false;
}
