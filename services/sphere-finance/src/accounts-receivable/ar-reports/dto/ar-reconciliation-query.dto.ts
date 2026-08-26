import { IsDateString, IsOptional } from "class-validator";

/**
 * `GET /ar/reconciliation` query params — AR-1d
 * (docs/finance-work-item-1d-ar-reports-proposal.md §9). Same
 * current-vs-as-of-mode split as Customer Balance (§6), applied
 * legal-entity-wide instead of per-customer. Mode dispatch is on
 * whether `asOf` was supplied at all — never a comparison of the
 * supplied value against today (§9.1's CTO correction). Deliberately
 * no `customerId` field — CTO decision 3 (§14, resolved): reconciliation
 * is always legal-entity-wide, since the GL doesn't sub-account the AR
 * control account per customer. A `customerId` filter remains available
 * only on `/ar/ageing`.
 */
export class ArReconciliationQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;
}
