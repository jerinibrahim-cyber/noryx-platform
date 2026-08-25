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
 * docs/finance-work-item-1c-supplier-payments-proposal.md §3/§5/§11. All
 * fields optional — a PATCH only touches what it sends. `allocations`,
 * if present, fully replaces the existing allocation set (no
 * allocation-level add/remove endpoints), same convention as
 * UpdateSupplierBillDto.lines; if omitted, existing allocations are left
 * untouched. supplierId is deliberately not editable — same posture as
 * UpdateSupplierBillDto.supplierId.
 */
export class UpdateSupplierPaymentDto {
  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  paymentAmountMinor?: number;

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: (typeof PAYMENT_METHODS)[number];

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
  @Type(() => CreateSupplierPaymentAllocationDto)
  allocations?: CreateSupplierPaymentAllocationDto[];
}
