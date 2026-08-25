import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { CreateSupplierBillLineDto } from "./create-supplier-bill-line.dto";

/**
 * docs/finance-work-item-1b-supplier-bills-proposal.md §17. All fields
 * optional — a PATCH only touches what it sends. `lines`, if present,
 * fully replaces the existing line set (no line-level add/remove
 * endpoints), same convention as UpdateJournalEntryDto; if omitted,
 * existing lines are left untouched. supplierId is deliberately not
 * editable — same posture as chart_of_accounts.code/accountId
 * references elsewhere: changing which supplier a bill belongs to is a
 * different document, not an edit to this one.
 */
export class UpdateSupplierBillDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  supplierBillNumber?: string;

  @IsOptional()
  @IsDateString()
  billDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierBillLineDto)
  lines?: CreateSupplierBillLineDto[];
}
