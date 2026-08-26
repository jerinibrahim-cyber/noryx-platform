import { IsDateString, IsOptional } from "class-validator";
import { IsSameOrAfterDate } from "../../../common/validators/is-same-or-after-date.validator";

/**
 * `GET /customers/:id/statement` query params — AR-1d
 * (docs/finance-work-item-1d-ar-reports-proposal.md §7). Both bounds
 * optional — an omitted `dateFrom` starts the statement from inception
 * (opening balance 0, same convention as
 * `GeneralLedgerService.getLedger`'s own `effectiveDateFrom`); an
 * omitted `dateTo` defaults to today (resolved in the service, the same
 * `todayUtc()` pattern the GL/AP-1d read layer uses).
 */
export class CustomerStatementQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  @IsSameOrAfterDate("dateFrom", {
    message: "dateTo must be the same date as, or after, dateFrom",
  })
  dateTo?: string;
}
