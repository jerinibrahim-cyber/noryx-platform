import { IsDateString, IsOptional } from "class-validator";

/**
 * `GET /ap/reconciliation` query params — AP-1d
 * (docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.4). Same current-vs-as-of-mode split as Supplier Balance (§6.1),
 * applied legal-entity-wide instead of per-supplier.
 */
export class ApReconciliationQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;
}
