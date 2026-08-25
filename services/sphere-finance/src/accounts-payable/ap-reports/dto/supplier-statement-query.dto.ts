import { IsDateString, IsOptional } from "class-validator";
import { IsSameOrAfterDate } from "../../../common/validators/is-same-or-after-date.validator";

/**
 * `GET /suppliers/:id/statement` query params — AP-1d
 * (docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.2). Both bounds optional — an omitted `dateFrom` starts the statement
 * from inception (opening balance 0, same convention as
 * `GeneralLedgerService.getLedger`'s own `effectiveDateFrom`); an omitted
 * `dateTo` defaults to today (resolved in the service, the same
 * `todayUtc()` pattern the GL read layer uses).
 */
export class SupplierStatementQueryDto {
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
