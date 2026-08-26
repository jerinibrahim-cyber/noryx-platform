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

const RECEIPT_METHODS = [
  "BANK_TRANSFER",
  "CHEQUE",
  "CASH",
  "CARD",
  "OTHER",
] as const;

/**
 * docs/finance-work-item-1c-customer-receipts-proposal.md §6/§8/§18. All
 * fields optional — a PATCH only touches what it sends. `allocations`,
 * if present, fully replaces the existing allocation set (no
 * allocation-level add/remove endpoints), same convention as
 * UpdateSupplierPaymentDto.allocations; if omitted, existing allocations
 * are left untouched. customerId is deliberately not editable — same
 * posture as UpdateSupplierPaymentDto.supplierId.
 */
export class UpdateCustomerReceiptDto {
  @IsOptional()
  @IsDateString()
  receiptDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  receiptAmountMinor?: number;

  @IsOptional()
  @IsIn(RECEIPT_METHODS)
  receiptMethod?: (typeof RECEIPT_METHODS)[number];

  @IsOptional()
  @IsUUID()
  bankCashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerReceiptAllocationDto)
  allocations?: CreateCustomerReceiptAllocationDto[];
}
