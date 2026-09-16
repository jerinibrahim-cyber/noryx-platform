import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  ValidateNested,
} from "class-validator";
import { CreateSupplierPaymentAllocationDto } from "./create-supplier-payment-allocation.dto";

/**
 * docs/finance-work-item-on-account-payments-proposal.md §8.2/§9.4
 * (CTO Architecture Gate, approved). Applies one or more NEW allocations
 * to an already-POSTED supplier payment —
 * `SupplierPaymentsService.applyAllocation()`, §9.1.
 *
 * `allocations` reuses `CreateSupplierPaymentAllocationDto` verbatim
 * (billId + allocatedAmountMinor, same @IsUUID/@IsInt @Min(1)) — this
 * endpoint's own `ArrayMinSize(1)` is intentional and distinct from the
 * create-time DTO's own (now relaxed to allow an empty array, §5 of the
 * implementation authorization): this endpoint's entire purpose is
 * applying at least one new allocation, so a caller with nothing to
 * allocate should not call it at all.
 *
 * `allocationDate` — defaults to todayUtc() if omitted; must not be
 * earlier than the payment's own paymentDate; must NOT be later than
 * todayUtc() (no future-effective allocation — CTO Architecture Gate,
 * Option A, §9.4 Rule 2); must fall in an OPEN accounting period
 * covering that date. Full rules: proposal §9.4.
 */
export class ApplySupplierPaymentAllocationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierPaymentAllocationDto)
  allocations!: CreateSupplierPaymentAllocationDto[];

  @IsOptional()
  @IsDateString()
  allocationDate?: string;
}
