import { IsIn, IsOptional, IsUUID } from "class-validator";
import { PAYMENT_PROVIDER_SETTLEMENT_IMPORT_STATUSES } from "./payment-provider-settlement-enums";
import { PAYMENT_SETTLEMENT_RECONCILIATION_STATUSES } from "./payment-provider-settlement-enums";

/** `GET /payment-provider-settlement-imports` — mirrors
 * ListBankStatementImportsQueryDto exactly. */
export class ListPaymentProviderSettlementImportsQueryDto {
  @IsOptional()
  @IsUUID()
  bankCashAccountId?: string;

  @IsOptional()
  @IsIn(PAYMENT_PROVIDER_SETTLEMENT_IMPORT_STATUSES)
  status?: (typeof PAYMENT_PROVIDER_SETTLEMENT_IMPORT_STATUSES)[number];

  @IsOptional()
  @IsIn(PAYMENT_SETTLEMENT_RECONCILIATION_STATUSES)
  reconciliationStatus?: (typeof PAYMENT_SETTLEMENT_RECONCILIATION_STATUSES)[number];
}
