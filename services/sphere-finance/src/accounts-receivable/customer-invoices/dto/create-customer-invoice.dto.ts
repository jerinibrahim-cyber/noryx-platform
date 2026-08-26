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
import { CreateCustomerInvoiceLineDto } from "./create-customer-invoice-line.dto";

/**
 * docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §5.
 *
 * currencyCode/status/paymentStatus/internalReference/journalEntryId/
 * periodId/subtotalMinor/taxMinor/totalMinor/paidMinor are deliberately
 * absent — all server-resolved/server-computed, never client input,
 * same convention as CreateSupplierBillDto. Unlike CreateSupplierBillDto,
 * there is no client-supplied external-number field either (proposal §2
 * decision 1): a customer invoice is a document WE originate, so
 * internalReference — assigned only at posting — is its only number.
 *
 * `lines` requires at least 1 entry — an invoice with zero lines is not
 * a valid business document even as a draft, same reasoning as
 * CreateSupplierBillDto.lines.
 */
export class CreateCustomerInvoiceDto {
  @IsUUID()
  customerId!: string;

  @IsDateString()
  invoiceDate!: string;

  // Server computes a default (invoiceDate + customer.paymentTermsDays)
  // if omitted; an explicit value always wins.
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerInvoiceLineDto)
  lines!: CreateCustomerInvoiceLineDto[];
}
