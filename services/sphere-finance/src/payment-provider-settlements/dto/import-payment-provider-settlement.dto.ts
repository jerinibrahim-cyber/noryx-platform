import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export const PAYMENT_PROVIDER_SETTLEMENT_FORMATS = [
  "GENERIC_SETTLEMENT_CSV",
] as const;
export type PaymentProviderSettlementFormat =
  (typeof PAYMENT_PROVIDER_SETTLEMENT_FORMATS)[number];

/**
 * docs/finance-work-item-banking-1e-proposal.md §14, CTO-approved
 * (implementation-authorization turn). The multipart form fields
 * alongside the uploaded file (`POST /payment-provider-settlement-imports`,
 * `multipart/form-data`) — the file itself arrives via `@UploadedFile()`
 * (PaymentProviderSettlementsController.upload), not as a DTO field.
 *
 * tenantId/legalEntityId/fileHash/status/reconciliationStatus are
 * deliberately absent — all server-resolved, never client input, same
 * convention as ImportBankStatementDto. `bankCashAccountId` must refer
 * to a `purpose = CLEARING` account (§7) — validated server-side, not
 * here, mirroring every other cross-table validation in this codebase.
 */
export class ImportPaymentProviderSettlementDto {
  @IsUUID()
  bankCashAccountId!: string;

  @IsOptional()
  @IsIn(PAYMENT_PROVIDER_SETTLEMENT_FORMATS)
  providerFormat?: PaymentProviderSettlementFormat; // defaults to GENERIC_SETTLEMENT_CSV — the only MVP value (§14).

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string; // falls back to the uploaded file's own originalname.
}
