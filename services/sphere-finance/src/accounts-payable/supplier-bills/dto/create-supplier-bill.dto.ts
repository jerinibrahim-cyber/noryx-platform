import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { CreateSupplierBillLineDto } from "./create-supplier-bill-line.dto";

/**
 * docs/finance-work-item-1b-supplier-bills-proposal.md §17.
 *
 * currencyCode/status/paymentStatus/internalReference/journalEntryId/
 * periodId/subtotalMinor/taxMinor/totalMinor/paidMinor are deliberately
 * absent — all server-resolved/server-computed, never client input,
 * same convention as every existing Finance DTO.
 *
 * `lines` requires at least 1 entry (unlike CreateJournalEntryDto's
 * optional/unbounded lines) — a bill with zero lines is not a valid
 * business document even as a draft, unlike a journal entry draft which
 * may be built up incrementally before it ever needs to balance.
 */
export class CreateSupplierBillDto {
  @IsUUID()
  supplierId!: string;

  // The supplier's own external invoice/bill number — deliberately no
  // @Matches charset restriction, unlike chart_of_accounts.code/
  // suppliers.code: this is the supplier's own reference text, not an
  // internal identifier this system generates or joins on structurally.
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  supplierBillNumber!: string;

  @IsDateString()
  billDate!: string;

  // Server computes a default (billDate + supplier.paymentTermsDays) if
  // omitted; an explicit value always wins.
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
  @Type(() => CreateSupplierBillLineDto)
  lines!: CreateSupplierBillLineDto[];
}
