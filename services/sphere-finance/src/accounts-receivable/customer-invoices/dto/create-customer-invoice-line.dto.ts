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
}
