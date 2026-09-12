ALTER TABLE "customer_credit_note_lines" ADD COLUMN "resolved_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD COLUMN "resolved_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "resolved_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_debit_note_lines" ADD COLUMN "resolved_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "ap_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "ar_tax_account_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_resolved_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("resolved_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_resolved_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("resolved_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_resolved_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("resolved_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_resolved_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("resolved_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_ap_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("ap_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_ar_tax_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("ar_tax_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
