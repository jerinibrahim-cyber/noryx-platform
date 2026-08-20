DROP INDEX IF EXISTS "journal_lines_journal_entry_idx";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_line_number_unique" UNIQUE("journal_entry_id","line_number");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_nonzero" CHECK ("journal_lines"."debit_minor" > 0 OR "journal_lines"."credit_minor" > 0);