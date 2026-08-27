import { IsInt, IsUUID, Min } from "class-validator";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. One
 * allocation = "apply this much of the debit note to this bill". billId
 * shape-validated at create/edit time (exists, same supplier/tenant/
 * legal entity — 400); sufficient-remaining-outstanding-balance is
 * re-validated under lock at posting time (422) — same create-time-vs-
 * post-time split AP-1c established for payment allocations. Exact
 * mirror of CreateSupplierPaymentAllocationDto.
 */
export class CreateSupplierDebitNoteAllocationDto {
  @IsUUID()
  billId!: string;

  @IsInt()
  @Min(1)
  allocatedAmountMinor!: number;
}
