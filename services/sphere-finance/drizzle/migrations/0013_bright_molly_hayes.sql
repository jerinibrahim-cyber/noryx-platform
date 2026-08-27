CREATE TYPE "public"."bank_transaction_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."bank_transaction_type" AS ENUM('TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'INTEREST');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_transaction_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bank_transaction_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"internal_reference" varchar(20),
	"status" "bank_transaction_status" DEFAULT 'DRAFT' NOT NULL,
	"type" "bank_transaction_type" NOT NULL,
	"transaction_date" date NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"counterparty_bank_cash_account_id" uuid,
	"gl_account_id" uuid,
	"currency_code" varchar(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reference" varchar(100),
	"memo" text,
	"journal_entry_id" uuid,
	"period_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_amount_positive" CHECK ("bank_transactions"."amount_minor" > 0),
	CONSTRAINT "bank_transactions_transfer_counterparty_shape" CHECK (("bank_transactions"."type" = 'TRANSFER' AND "bank_transactions"."counterparty_bank_cash_account_id" IS NOT NULL AND "bank_transactions"."gl_account_id" IS NULL)
       OR ("bank_transactions"."type" != 'TRANSFER' AND "bank_transactions"."counterparty_bank_cash_account_id" IS NULL AND "bank_transactions"."gl_account_id" IS NOT NULL)),
	CONSTRAINT "bank_transactions_transfer_distinct_accounts" CHECK ("bank_transactions"."counterparty_bank_cash_account_id" IS NULL OR "bank_transactions"."counterparty_bank_cash_account_id" != "bank_transactions"."bank_cash_account_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_counterparty_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("counterparty_bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_gl_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_tenant_entity_idx" ON "bank_transactions" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_bank_cash_account_idx" ON "bank_transactions" USING btree ("bank_cash_account_id");