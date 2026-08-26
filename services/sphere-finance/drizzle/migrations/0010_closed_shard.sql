CREATE TYPE "public"."customer_receipt_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ar_receipt_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ar_receipt_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_receipt_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"allocated_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_receipt_allocations_receipt_invoice_unique" UNIQUE("receipt_id","invoice_id"),
	CONSTRAINT "customer_receipt_allocations_amount_positive" CHECK ("customer_receipt_allocations"."allocated_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "customer_receipt_status" DEFAULT 'DRAFT' NOT NULL,
	"receipt_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"receipt_amount_minor" bigint NOT NULL,
	"receipt_method" "payment_method" NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"reference" varchar(100),
	"memo" text,
	"journal_entry_id" uuid,
	"period_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_receipts_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "customer_receipts_amount_positive" CHECK ("customer_receipts"."receipt_amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_invoices" DROP CONSTRAINT "customer_invoices_paid_minor_zero_until_ar1c";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_receipt_id_customer_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."customer_receipts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_bank_cash_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_receipt_allocations_invoice_idx" ON "customer_receipt_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_receipts_tenant_entity_idx" ON "customer_receipts" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_receipts_customer_idx" ON "customer_receipts" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_paid_minor_within_total" CHECK ("customer_invoices"."paid_minor" >= 0 AND "customer_invoices"."paid_minor" <= "customer_invoices"."total_minor");