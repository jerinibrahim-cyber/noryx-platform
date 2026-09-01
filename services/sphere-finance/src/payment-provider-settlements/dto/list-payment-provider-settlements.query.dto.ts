import { IsIn, IsOptional } from "class-validator";
import { PAYMENT_SETTLEMENT_MATCH_STATUSES } from "./payment-provider-settlement-enums";

/** `GET /payment-provider-settlement-imports/:id/settlements` — mirrors
 * ListBankStatementLinesQueryDto exactly. */
export class ListPaymentProviderSettlementsQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_SETTLEMENT_MATCH_STATUSES)
  matchStatus?: (typeof PAYMENT_SETTLEMENT_MATCH_STATUSES)[number];
}
