import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §5. Mirrors
 * CreateSupplierBillLineDto's shape — invoice lines are single-sided by
 * nature (one amount, one account), not by a validated two-field
 * invariant.
 *
 * No lineNumber field, deliberately — CustomerInvoicesService assigns
 * 1..N from array order, same convention as SupplierBillsService.
 *
 * taxCodeId — Tax/VAT Phase 3
 * (docs/finance-work-item-tax-vat-phase-3-discovery.md §6/§7). Optional:
 * omitted preserves 100% of pre-Phase-3 behavior (taxAmountMinor stays
 * a plain manual value). When supplied, CustomerInvoicesService resolves
 * and snapshots the effective tax rate and treats taxAmountMinor (if
 * also supplied) as an explicit override — identical semantics to
 * CreateSupplierBillLineDto.taxCodeId. taxRateId/taxAmountCalculatedMinor/
 * taxAmountOverridden are server-computed, never client-supplied, so
 * they are deliberately not DTO fields.
 */
export class CreateCustomerInvoiceLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // > 0, not >= 0: a zero-amount invoice line is meaningless — matches
  // CreateSupplierBillLineDto.amountMinor's identical reasoning.
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  taxAmountMinor?: number;

  @IsOptional()
  @IsUUID()
  taxCodeId?: string;
}
