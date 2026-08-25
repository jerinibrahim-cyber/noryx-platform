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
 * convention as every existing Finance DTO. `allocations` requires at
 * least 1 entry (§8 step 3 — a payment must allocate to post; no bare
 * unapplied payment in this Work Item), same posture as
 * CreateSupplierBillDto.lines' ArrayMinSize(1).
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
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierPaymentAllocationDto)
  allocations!: CreateSupplierPaymentAllocationDto[];
}
