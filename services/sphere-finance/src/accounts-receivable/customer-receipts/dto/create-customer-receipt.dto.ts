import { Type } from "class-transformer";
import {
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
 * convention as every existing Finance DTO.
 *
 * `allocations` is a required array field but MAY be empty
 * (`allocations: []`) — see `CreateSupplierPaymentDto.allocations`'s own
 * comment for the full reasoning (byte-mirror on the AR side): the
 * On-Account (Unapplied) Supplier Payments & Customer Receipts work item
 * (docs/finance-work-item-on-account-payments-proposal.md, CTO
 * Architecture Gate, approved) requires "initial zero-allocation
 * posting" to be reachable through the standard create->post flow, which
 * the original `ArrayMinSize(1)` here would have blocked with a 400
 * before `post()`'s own (now-relaxed) Step 3 guard is ever reached.
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
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerReceiptAllocationDto)
  allocations!: CreateCustomerReceiptAllocationDto[];
}
