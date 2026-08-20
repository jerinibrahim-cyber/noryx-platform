import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

// Both fields optional (§6 of the 2c proposal): `transactionDate`
// defaults to "now", `memo` defaults to "Reversal of
// {originalJournalNumber}" — both resolved server-side in
// JournalEntriesService.reverse(), not here. No other fields accepted:
// the reversal target is always the URL's `:id`, and every other value
// (accounts, amounts, tenant/entity) is derived from the original entry,
// never client-supplied (§6 steps 1/6, §7.3).
export class ReverseJournalEntryDto {
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;
}
