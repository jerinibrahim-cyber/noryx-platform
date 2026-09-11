import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. Exact
 * mirror of CreateCustomerInvoiceLineDto's shape — a credit-note line is
 * single-sided by nature (one amount, one account), not by a validated
 * two-field invariant, same reasoning as the invoice line it corrects.
 *
 * No lineNumber field, deliberately — CustomerCreditNotesService assigns
 * 1..N from array order, same convention as CustomerInvoicesService.
 *
 * taxCodeId — Tax/VAT Phase 3
 * (docs/finance-work-item-tax-vat-phase-3-discovery.md §6/§8). Optional,
 * same semantics as CreateCustomerInvoiceLineDto.taxCodeId. Resolved
 * independently per line by the credit note's OWN creditNoteDate —
 * CustomerCreditNotesService.resolveLineTax() never reads this DTO's
 * sibling allocations array, mirroring CreateSupplierDebitNoteLineDto's
 * identical no-inheritance posture from Phase 2.
 */
export class CreateCustomerCreditNoteLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // > 0, not >= 0: a zero-amount credit-note line is meaningless — same
  // reasoning as CreateCustomerInvoiceLineDto.amountMinor.
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
