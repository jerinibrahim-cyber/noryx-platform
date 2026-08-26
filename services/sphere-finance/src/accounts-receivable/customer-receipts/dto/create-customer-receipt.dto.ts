import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateCustomerReceiptAllocationDto } from "./create-customer-receipt-allocation.dto";

// Mirrors AP-1c's PAYMENT_METHODS list exactly — this DTO reuses the
// existing payment_method enum's value set (CTO-approved decision 2,
// proposal §14); no separate RECEIPT_METHODS list with a different
// value set would even be meaningful here.
const RECEIPT_METHODS = [
  "BANK_TRANSFER",
  "CHEQUE",
  "CASH",
  "CARD",
  "OTHER",
] as const;

/**
 * docs/finance-work-item-1c-customer-receipts-proposal.md §6/§18.
 *
 * currencyCode/status/internalReference/journalEntryId/periodId are
 * deliberately absent — all server-resolved, never client input, same
 * convention as every existing Finance DTO. `allocations` requires at
 * least 1 entry (§13 step 3 — a receipt must allocate to post; no bare
 * unapplied receipt in this Work Item), same posture as
 * CreateSupplierPaymentDto.allocations' ArrayMinSize(1).
 */
export class CreateCustomerReceiptDto {
  @IsUUID()
  customerId!: string;

  @IsDateString()
  receiptDate!: string;

  @IsInt()
  @Min(1)
  receiptAmountMinor!: number;

  @IsIn(RECEIPT_METHODS)
  receiptMethod!: (typeof RECEIPT_METHODS)[number];

  @IsUUID()
  bankCashAccountId!: string;

  // Free-text external reference (cheque number, transfer reference) —
  // deliberately no @Matches charset restriction, same reasoning as
  // CreateSupplierPaymentDto.reference.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerReceiptAllocationDto)
  allocations!: CreateCustomerReceiptAllocationDto[];
}
