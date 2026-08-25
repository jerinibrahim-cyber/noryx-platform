import { IsDateString, IsOptional } from "class-validator";

/**
 * `GET /suppliers/:id/balance` query params — AP-1d
 * (docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.1). No `asOf` — current mode: totals are summed directly from
 * `supplier_bills.total_minor`/`paid_minor`. `asOf` given — as-of mode: a
 * historical reconstruction using `bill_date`/`payment_date` instead of
 * today's stored `paid_minor` (§6.1's full reasoning).
 */
export class SupplierBalanceQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;
}
