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

// All fields optional — a PATCH only touches what it sends. `lines`, if
// present, fully replaces the existing line set (no line-level
// add/remove/reorder endpoints — §4.3 of the 2c proposal); if omitted,
// existing lines are left untouched.
export class UpdateJournalEntryDto {
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

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
