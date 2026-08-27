import { IsDateString, IsOptional } from "class-validator";
import { IsSameOrAfterDate } from "../../common/validators/is-same-or-after-date.validator";

/**
 * `GET /bank-cash-accounts/:id/statement` query params — Banking-1d
 * (docs/finance-work-item-banking-1d-proposal.md §2.2). Both bounds
 * optional — an omitted `dateFrom` starts the statement from inception
 * (opening balance 0, same convention as
 * `GeneralLedgerService.getLedger`/`ArReportsService.getCustomerStatement`'s
 * own `dateFrom`); an omitted `dateTo` defaults to today (resolved in
 * the service). Identical shape to `CustomerStatementQueryDto`.
 */
export class BankCashAccountStatementQueryDto {
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
