CREATE TYPE "public"."journal_line_tax_direction" AS ENUM('INPUT', 'OUTPUT');--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "tax_direction" "journal_line_tax_direction";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_direction_requires_code" CHECK ("journal_lines"."tax_direction" IS NULL OR "journal_lines"."tax_code_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_code_requires_direction" CHECK ("journal_lines"."tax_code_id" IS NULL OR "journal_lines"."tax_direction" IS NOT NULL);