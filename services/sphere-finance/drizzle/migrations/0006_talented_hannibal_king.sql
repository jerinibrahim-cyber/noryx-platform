CREATE TYPE "public"."bill_payment_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."supplier_bill_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ap_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" varchar(500),
	"amount_minor" bigint NOT NULL,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_bill_lines_bill_line_number_unique" UNIQUE("bill_id","line_number"),
	CONSTRAINT "supplier_bill_lines_amount_positive" CHECK ("supplier_bill_lines"."amount_minor" > 0),
	CONSTRAINT "supplier_bill_lines_tax_amount_non_negative" CHECK ("supplier_bill_lines"."tax_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_bill_number" varchar(50) NOT NULL,
	"internal_reference" varchar(20),
	"status" "supplier_bill_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_status" "bill_payment_status" DEFAULT 'UNPAID' NOT NULL,
	"bill_date" date NOT NULL,
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
	CONSTRAINT "supplier_bills_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "supplier_bills_total_equals_subtotal_plus_tax" CHECK ("supplier_bills"."total_minor" = "supplier_bills"."subtotal_minor" + "supplier_bills"."tax_minor"),
	CONSTRAINT "supplier_bills_amounts_non_negative" CHECK ("supplier_bills"."subtotal_minor" >= 0 AND "supplier_bills"."tax_minor" >= 0 AND "supplier_bills"."total_minor" >= 0),
	CONSTRAINT "supplier_bills_paid_minor_zero_until_ap1c" CHECK ("supplier_bills"."paid_minor" = 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_bill_lines_account_idx" ON "supplier_bill_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_bills_tenant_entity_idx" ON "supplier_bills" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_bills_supplier_idx" ON "supplier_bills" USING btree ("supplier_id");