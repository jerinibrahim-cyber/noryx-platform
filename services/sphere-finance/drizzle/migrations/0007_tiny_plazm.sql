CREATE TYPE "public"."payment_method" AS ENUM('BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."supplier_payment_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_payment_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ap_payment_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"allocated_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payment_allocations_payment_bill_unique" UNIQUE("payment_id","bill_id"),
	CONSTRAINT "supplier_payment_allocations_amount_positive" CHECK ("supplier_payment_allocations"."allocated_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "supplier_payment_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"payment_amount_minor" bigint NOT NULL,
	"payment_method" "payment_method" NOT NULL,
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
	CONSTRAINT "supplier_payments_tenant_entity_reference_unique" UNIQUE("tenant_id","legal_entity_id","internal_reference"),
	CONSTRAINT "supplier_payments_amount_positive" CHECK ("supplier_payments"."payment_amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_bills" DROP CONSTRAINT "supplier_bills_paid_minor_zero_until_ap1c";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_cash_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payment_allocations_bill_idx" ON "supplier_payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_tenant_entity_idx" ON "supplier_payments" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_paid_minor_within_total" CHECK ("supplier_bills"."paid_minor" >= 0 AND "supplier_bills"."paid_minor" <= "supplier_bills"."total_minor");