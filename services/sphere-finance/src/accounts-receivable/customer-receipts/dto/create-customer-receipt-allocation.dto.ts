import { IsInt, IsUUID, Min } from "class-validator";

/**
 * docs/finance-work-item-1c-customer-receipts-proposal.md §6/§10. One
 * allocation = "apply this much of the receipt to this invoice".
 * invoiceId shape-validated at create/edit time (exists, same
 * customer/tenant/legal entity — 400); sufficient-remaining-balance is
 * re-validated under lock at posting time (422), same create-time-vs-
 * post-time split AP-1c established for bill allocations.
 */
export class CreateCustomerReceiptAllocationDto {
  @IsUUID()
  invoiceId!: string;

  @IsInt()
  @Min(1)
  allocatedAmountMinor!: number;
}
