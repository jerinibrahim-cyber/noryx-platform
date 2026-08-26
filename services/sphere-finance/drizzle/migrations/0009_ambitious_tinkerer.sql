CREATE TYPE "public"."customer_invoice_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."invoice_payment_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ar_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ar_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" varchar(500),
	"amount_minor" bigint NOT NULL,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_invoice_lines_invoice_line_number_unique" UNIQUE("invoice_id","line_number"),
	CONSTRAINT "customer_invoice_lines_amount_positive" CHECK ("customer_invoice_lines"."amount_minor" > 0),
	CONSTRAINT "customer_invoice_lines_tax_amount_non_negative" CHECK ("customer_invoice_lines"."tax_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "customer_invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_status" "invoice_payment_status" DEFAULT 'UNPAID' NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"currency_code" varchar(3) NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"paid_minor" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"period_id" uuid,
	"memo" text,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_invoices_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "customer_invoices_total_equals_subtotal_plus_tax" CHECK ("customer_invoices"."total_minor" = "customer_invoices"."subtotal_minor" + "customer_invoices"."tax_minor"),
	CONSTRAINT "customer_invoices_amounts_non_negative" CHECK ("customer_invoices"."subtotal_minor" >= 0 AND "customer_invoices"."tax_minor" >= 0 AND "customer_invoices"."total_minor" >= 0),
	CONSTRAINT "customer_invoices_paid_minor_zero_until_ar1c" CHECK ("customer_invoices"."paid_minor" = 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_invoice_lines_account_idx" ON "customer_invoice_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_invoices_tenant_entity_idx" ON "customer_invoices" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_invoices_customer_idx" ON "customer_invoices" USING btree ("customer_id");