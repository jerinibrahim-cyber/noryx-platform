import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateCustomerCreditNoteLineDto } from "./create-customer-credit-note-line.dto";
import { CreateCustomerCreditNoteAllocationDto } from "./create-customer-credit-note-allocation.dto";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. All fields
 * optional — a PATCH only touches what it sends. `lines`/`allocations`,
 * if present, each fully replace the existing set (no line/allocation-
 * level add/remove endpoints), same convention as
 * UpdateCustomerInvoiceDto.lines/UpdateCustomerReceiptDto.allocations;
 * if omitted, the existing set is left untouched. customerId is
 * deliberately not editable — same posture as
 * UpdateCustomerReceiptDto.customerId.
 */
export class UpdateCustomerCreditNoteDto {
  @IsOptional()
  @IsDateString()
  creditNoteDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerCreditNoteLineDto)
  lines?: CreateCustomerCreditNoteLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerCreditNoteAllocationDto)
  allocations?: CreateCustomerCreditNoteAllocationDto[];
}
