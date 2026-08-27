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
import { CreateCustomerCreditNoteLineDto } from "./create-customer-credit-note-line.dto";
import { CreateCustomerCreditNoteAllocationDto } from "./create-customer-credit-note-allocation.dto";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. A credit
 * note combines CreateCustomerInvoiceDto's `lines` shape (it is itself a
 * correction document with its own line items and its own subtotal/tax/
 * total) with CreateCustomerReceiptDto's `allocations` shape (it settles
 * against one or more already-POSTED invoices of the same customer).
 *
 * currencyCode/status/internalReference/journalEntryId/periodId/
 * subtotalMinor/taxMinor/totalMinor are deliberately absent — all
 * server-resolved/server-computed, never client input, same convention
 * as every existing Finance DTO. `lines` and `allocations` each require
 * at least 1 entry (§9/§16 — a credit note must have content and must
 * allocate to post; no bare unapplied credit note, mirroring AR-1c's own
 * "no receipt on account" posture — CTO-approved).
 */
export class CreateCustomerCreditNoteDto {
  @IsUUID()
  customerId!: string;

  @IsDateString()
  creditNoteDate!: string;

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
  @Type(() => CreateCustomerCreditNoteLineDto)
  lines!: CreateCustomerCreditNoteLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerCreditNoteAllocationDto)
  allocations!: CreateCustomerCreditNoteAllocationDto[];
}
