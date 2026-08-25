import { IsDateString, IsOptional, IsUUID } from "class-validator";

/**
 * `GET /ap/ageing` query params — AP-1d
 * (docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §6.3). `asOf` only changes which bucket a bill's `due_date` falls into —
 * outstanding amounts are always each bill's current `total_minor -
 * paid_minor` (§6.3's full reasoning for why this is deliberately not a
 * historical reconstruction). `supplierId` is an optional convenience
 * filter, not part of the AP Foundation proposal's original route sketch —
 * additive, narrows the report to one supplier without needing a second
 * endpoint.
 */
export class ApAgeingQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;
}
