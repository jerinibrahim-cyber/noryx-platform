import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateCustomerInvoiceLineDto } from "./create-customer-invoice-line.dto";

/**
 * docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §5. All
 * fields optional — a PATCH only touches what it sends. `lines`, if
 * present, fully replaces the existing line set (no line-level
 * add/remove endpoints), same convention as UpdateSupplierBillDto; if
 * omitted, existing lines are left untouched. customerId is
 * deliberately not editable — same posture as supplierId on
 * UpdateSupplierBillDto: changing which customer an invoice belongs to
 * is a different document, not an edit to this one.
 */
export class UpdateCustomerInvoiceDto {
  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

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
  @Type(() => CreateCustomerInvoiceLineDto)
  lines?: CreateCustomerInvoiceLineDto[];
}
