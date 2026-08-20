import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CreateJournalLineDto } from "./create-journal-line.dto";

// `lines` is optional and unbounded (no minimum) — DRAFT is not required
// to balance or have >=2 lines; that check belongs solely to posting
// (2c-2, not part of this increment).
// `currencyCode` is deliberately absent — never client-supplied, always
// resolved server-side from the caller's legal entity (§4.1).
// `periodId`/`status`/`journalNumber` are likewise absent — all
// server-resolved/server-assigned, never client input.
export class CreateJournalEntryDto {
  @IsDateString()
  transactionDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateJournalLineDto)
  lines?: CreateJournalLineDto[];
}
