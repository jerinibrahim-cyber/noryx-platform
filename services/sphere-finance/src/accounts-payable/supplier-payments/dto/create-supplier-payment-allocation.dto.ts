import { IsInt, IsUUID, Min } from "class-validator";

/**
 * docs/finance-work-item-1c-supplier-payments-proposal.md §3/§7. One
 * allocation = "apply this much of the payment to this bill". billId
 * shape-validated at create/edit time (exists, same supplier/tenant/
 * legal entity — 400); sufficient-remaining-balance is re-validated
 * under lock at posting time (422), same create-time-vs-post-time split
 * AP-1b established for bill line accounts.
 */
export class CreateSupplierPaymentAllocationDto {
  @IsUUID()
  billId!: string;

  @IsInt()
  @Min(1)
  allocatedAmountMinor!: number;
}
