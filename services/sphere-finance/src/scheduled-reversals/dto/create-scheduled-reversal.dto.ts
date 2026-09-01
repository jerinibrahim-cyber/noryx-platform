import { IsDateString, IsUUID } from "class-validator";

// Scheduled Reversal for Accruals and Other Timing Adjustments — Final
// Implementation Specification (Revision 2), §8. Both fields required:
// `originalJournalEntryId` is the entry to reverse (validated at
// creation time — must be POSTED, not already reversed, not itself a
// reversal, in the caller's own tenant/legal entity — never trusted
// from the client beyond its shape); `targetDate` is resolved lazily
// against accounting periods at execution time, never client-supplied
// as a periodId (§9/§13).
export class CreateScheduledReversalDto {
  @IsUUID()
  originalJournalEntryId!: string;

  @IsDateString()
  targetDate!: string;
}
