import { IsDateString, IsOptional, IsUUID } from "class-validator";
import { IsSameOrAfterDate } from "../../common/validators/is-same-or-after-date.validator";

/**
 * `GET /payment-provider-settlements/clearing-reconciliation` query
 * params (§13/§20). Mirrors BankCashAccountStatementQueryDto's date-range
 * shape; `bankCashAccountId` is required here (unlike Banking-1d's
 * account-scoped route which takes the account via `:id` in the path —
 * this is a top-level `payment-provider-settlements/` route, §23, so the
 * account is a query param instead).
 */
export class ClearingReconciliationQueryDto {
  @IsUUID()
  bankCashAccountId!: string;

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
