import { IsDateString, IsOptional } from "class-validator";

/**
 * `GET /customers/:id/balance` query params — AR-1d
 * (docs/finance-work-item-1d-ar-reports-proposal.md §6). No `asOf` —
 * current mode: totals are summed directly from
 * `customer_invoices.total_minor`/`paid_minor`. `asOf` given — as-of
 * mode: a historical reconstruction using `invoice_date`/`receipt_date`
 * instead of today's stored `paid_minor` (§6's full reasoning). Mode
 * dispatch is on parameter presence alone — never a comparison of the
 * supplied `asOf` against today (§9.1's CTO correction applies
 * identically here).
 */
export class CustomerBalanceQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;
}
