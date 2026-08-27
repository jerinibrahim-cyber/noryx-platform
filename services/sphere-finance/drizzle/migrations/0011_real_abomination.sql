CREATE TYPE "public"."customer_credit_note_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."supplier_debit_note_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit_note_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"allocated_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_note_allocations_note_invoice_unique" UNIQUE("credit_note_id","invoice_id"),
	CONSTRAINT "customer_credit_note_allocations_amount_positive" CHECK ("customer_credit_note_allocations"."allocated_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" varchar(500),
	"amount_minor" bigint NOT NULL,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_note_lines_credit_note_line_number_unique" UNIQUE("credit_note_id","line_number"),
	CONSTRAINT "customer_credit_note_lines_amount_positive" CHECK ("customer_credit_note_lines"."amount_minor" > 0),
	CONSTRAINT "customer_credit_note_lines_tax_amount_non_negative" CHECK ("customer_credit_note_lines"."tax_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit_note_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "customer_credit_note_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "customer_credit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"credit_note_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"reason" varchar(500),
	"memo" text,
	"journal_entry_id" uuid,
	"period_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_notes_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "customer_credit_notes_total_equals_subtotal_plus_tax" CHECK ("customer_credit_notes"."total_minor" = "customer_credit_notes"."subtotal_minor" + "customer_credit_notes"."tax_minor")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_debit_note_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"debit_note_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"allocated_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_debit_note_allocations_note_bill_unique" UNIQUE("debit_note_id","bill_id"),
	CONSTRAINT "supplier_debit_note_allocations_amount_positive" CHECK ("supplier_debit_note_allocations"."allocated_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_debit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"debit_note_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" varchar(500),
	"amount_minor" bigint NOT NULL,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_debit_note_lines_debit_note_line_number_unique" UNIQUE("debit_note_id","line_number"),
	CONSTRAINT "supplier_debit_note_lines_amount_positive" CHECK ("supplier_debit_note_lines"."amount_minor" > 0),
	CONSTRAINT "supplier_debit_note_lines_tax_amount_non_negative" CHECK ("supplier_debit_note_lines"."tax_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_debit_note_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "supplier_debit_note_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_debit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "supplier_debit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"debit_note_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"reason" varchar(500),
	"memo" text,
	"journal_entry_id" uuid,
	"period_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_debit_notes_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "supplier_debit_notes_total_equals_subtotal_plus_tax" CHECK ("supplier_debit_notes"."total_minor" = "supplier_debit_notes"."subtotal_minor" + "supplier_debit_notes"."tax_minor")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_note_allocations" ADD CONSTRAINT "customer_credit_note_allocations_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_note_allocations" ADD CONSTRAINT "customer_credit_note_allocations_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_allocations" ADD CONSTRAINT "supplier_debit_note_allocations_debit_note_id_supplier_debit_notes_id_fk" FOREIGN KEY ("debit_note_id") REFERENCES "public"."supplier_debit_notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_allocations" ADD CONSTRAINT "supplier_debit_note_allocations_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_debit_note_id_supplier_debit_notes_id_fk" FOREIGN KEY ("debit_note_id") REFERENCES "public"."supplier_debit_notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_note_lines" ADD CONSTRAINT "supplier_debit_note_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_notes" ADD CONSTRAINT "supplier_debit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_notes" ADD CONSTRAINT "supplier_debit_notes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_debit_notes" ADD CONSTRAINT "supplier_debit_notes_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_credit_note_allocations_invoice_idx" ON "customer_credit_note_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_credit_note_lines_account_idx" ON "customer_credit_note_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_credit_notes_tenant_entity_idx" ON "customer_credit_notes" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_credit_notes_customer_idx" ON "customer_credit_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_debit_note_allocations_bill_idx" ON "supplier_debit_note_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_debit_note_lines_account_idx" ON "supplier_debit_note_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_debit_notes_tenant_entity_idx" ON "supplier_debit_notes" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_debit_notes_supplier_idx" ON "supplier_debit_notes" USING btree ("supplier_id");