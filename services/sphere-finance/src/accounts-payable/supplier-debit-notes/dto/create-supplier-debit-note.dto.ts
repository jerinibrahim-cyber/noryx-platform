import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateSupplierDebitNoteLineDto } from "./create-supplier-debit-note-line.dto";
import { CreateSupplierDebitNoteAllocationDto } from "./create-supplier-debit-note-allocation.dto";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. Exact AP
 * mirror of CreateCustomerCreditNoteDto — combines
 * CreateSupplierBillDto's `lines` shape with
 * CreateSupplierPaymentDto's `allocations` shape.
 *
 * currencyCode/status/internalReference/journalEntryId/periodId/
 * subtotalMinor/taxMinor/totalMinor are deliberately absent — all
 * server-resolved/server-computed. `lines` and `allocations` each
 * require at least 1 entry — no bare unapplied debit note, mirroring
 * AP-1c's own "no payment on account" posture (CTO-approved).
 */
export class CreateSupplierDebitNoteDto {
  @IsUUID()
  supplierId!: string;

  @IsDateString()
  debitNoteDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierDebitNoteLineDto)
  lines!: CreateSupplierDebitNoteLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierDebitNoteAllocationDto)
  allocations!: CreateSupplierDebitNoteAllocationDto[];
}
