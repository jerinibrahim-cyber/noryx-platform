import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateSupplierDebitNoteLineDto } from "./create-supplier-debit-note-line.dto";
import { CreateSupplierDebitNoteAllocationDto } from "./create-supplier-debit-note-allocation.dto";

/**
 * docs/finance-work-item-credit-debit-notes-proposal.md §14. All fields
 * optional — a PATCH only touches what it sends. `lines`/`allocations`,
 * if present, each fully replace the existing set; if omitted, the
 * existing set is left untouched. supplierId is deliberately not
 * editable — same posture as UpdateSupplierPaymentDto.supplierId.
 */
export class UpdateSupplierDebitNoteDto {
  @IsOptional()
  @IsDateString()
  debitNoteDate?: string;

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
  @Type(() => CreateSupplierDebitNoteLineDto)
  lines?: CreateSupplierDebitNoteLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierDebitNoteAllocationDto)
  allocations?: CreateSupplierDebitNoteAllocationDto[];
}
