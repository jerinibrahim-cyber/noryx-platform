import { IsDateString, IsOptional, IsUUID } from "class-validator";

/**
 * `GET /ar/ageing` query params — AR-1d
 * (docs/finance-work-item-1d-ar-reports-proposal.md §8). `asOf` only
 * changes which bucket an invoice's `due_date` falls into — outstanding
 * amounts are always each invoice's current `total_minor - paid_minor`
 * (§8's full reasoning for why this is deliberately not a historical
 * reconstruction). `customerId` is an optional convenience filter —
 * additive, narrows the report to one customer without needing a second
 * endpoint, mirroring `ApAgeingQueryDto.supplierId`. Unlike
 * `/ar/reconciliation`, `/ar/ageing` is a bucketed report filter, not a
 * GL-reconciliation invariant, so it deliberately keeps this filter
 * (§9.3, §14 decision 3).
 */
export class ArAgeingQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
