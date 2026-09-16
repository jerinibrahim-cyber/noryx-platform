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
import { CreateSupplierPaymentAllocationDto } from "./create-supplier-payment-allocation.dto";

const PAYMENT_METHODS = [
  "BANK_TRANSFER",
  "CHEQUE",
  "CASH",
  "CARD",
  "OTHER",
] as const;

/**
 * docs/finance-work-item-1c-supplier-payments-proposal.md §3/§11.
 *
 * currencyCode/status/internalReference/journalEntryId/periodId are
 * deliberately absent — all server-resolved, never client input, same
 * convention as every existing Finance DTO.
 *
 * `allocations` is a required array field but MAY be empty
 * (`allocations: []`) — the original AP-1c convention required at least
 * one entry (`@ArrayMinSize(1)`, matching CreateSupplierBillDto.lines),
 * because a payment was required to allocate in full to post at all.
 * The On-Account (Unapplied) Supplier Payments & Customer Receipts work
 * item (docs/finance-work-item-on-account-payments-proposal.md, CTO
 * Architecture Gate, approved) explicitly requires supporting "initial
 * zero-allocation posting" — a payment created and posted with no
 * allocations at all — which this DTO-level `ArrayMinSize(1)` would
 * reject with a 400 before `post()`'s own (now-relaxed) Step 3 guard is
 * ever reached. Removing it here is the smallest adjustment that makes
 * the approved architecture reachable through the standard create->post
 * flow; `post()`'s own guards remain the authoritative posting-time
 * business rules (proposal §3.3/§9.2). Matches
 * UpdateSupplierPaymentDto.allocations' existing (already-unrestricted)
 * shape.
 */
export class CreateSupplierPaymentDto {
  @IsUUID()
  supplierId!: string;

  @IsDateString()
  paymentDate!: string;

  @IsInt()
  @Min(1)
  paymentAmountMinor!: number;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: (typeof PAYMENT_METHODS)[number];

  @IsUUID()
  bankCashAccountId!: string;

  // Free-text external reference (cheque number, transfer reference) —
  // deliberately no @Matches charset restriction, same reasoning as
  // CreateSupplierBillDto.supplierBillNumber.
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
  @Type(() => CreateSupplierPaymentAllocationDto)
  allocations!: CreateSupplierPaymentAllocationDto[];
}
