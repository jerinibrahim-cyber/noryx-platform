import { IsInt, IsUUID, Min } from "class-validator";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. One
 * allocation = "apply this much of the credit note to this invoice".
 * invoiceId shape-validated at create/edit time (exists, same customer/
 * tenant/legal entity — 400); sufficient-remaining-outstanding-balance
 * is re-validated under lock at posting time (422) — same create-time-
 * vs-post-time split AR-1c established for receipt allocations. Exact
 * mirror of CreateCustomerReceiptAllocationDto.
 */
export class CreateCustomerCreditNoteAllocationDto {
  @IsUUID()
  invoiceId!: string;

  @IsInt()
  @Min(1)
  allocatedAmountMinor!: number;
}
