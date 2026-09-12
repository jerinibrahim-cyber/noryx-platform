import { IsOptional, IsUUID, ValidateIf } from "class-validator";

/// Tax/VAT Phase 5 (docs/finance-work-item-tax-vat-phase-5-proposal.md
/// §5/§9) — PATCH-only DTO for setting/clearing a tax code's two
/// optional per-direction GL account overrides. Both fields are
/// independently optional (a tax code may be used on AP documents, AR
/// documents, or both — schema.ts's own doc comment on
/// taxCodes.apTaxAccountId). Distinct from CreateTaxCodeDto — GL account
/// configuration is not part of tax-code creation, mirroring how
/// ap_settings/ar_settings configuration is its own separate resource
/// from the documents that read it.
///
/// `null` explicitly clears an override back to "use the AP/AR settings
/// singleton" (today's Phase 2-4 behavior); `undefined`/omitted leaves
/// that field's current value untouched — same optional-PATCH-field
/// convention as UpdateSupplierBillDto. IsUUID is skipped (not merely
/// made optional) when the value is null, since IsUUID would otherwise
/// reject an explicit null.
export class UpdateTaxCodeGlAccountsDto {
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  apTaxAccountId?: string | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  arTaxAccountId?: string | null;
}
