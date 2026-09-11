ALTER TABLE "supplier_bill_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tax_amount_calculated_minor" bigint;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tax_amount_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD COLUMN "tax_amount_calculated_minor" bigint;--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD COLUMN "tax_amount_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_tax_overridden_requires_code" CHECK ("supplier_bill_lines"."tax_amount_overridden" = false OR "supplier_bill_lines"."tax_code_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_tax_rate_requires_code" CHECK ("supplier_bill_lines"."tax_rate_id" IS NULL OR "supplier_bill_lines"."tax_code_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_tax_overridden_requires_code" CHECK ("supplier_debit_note_lines"."tax_amount_overridden" = false OR "supplier_debit_note_lines"."tax_code_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_tax_rate_requires_code" CHECK ("supplier_debit_note_lines"."tax_rate_id" IS NULL OR "supplier_debit_note_lines"."tax_code_id" IS NOT NULL);