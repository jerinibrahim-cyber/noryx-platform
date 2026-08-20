CREATE TYPE "public"."accounting_period_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "accounting_period_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_periods_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code"),
	CONSTRAINT "accounting_periods_end_after_start" CHECK ("accounting_periods"."end_date" > "accounting_periods"."start_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"journal_number" varchar(20),
	"status" "journal_entry_status" DEFAULT 'DRAFT' NOT NULL,
	"transaction_date" date NOT NULL,
	"period_id" uuid,
	"currency_code" varchar(3) NOT NULL,
	"memo" text,
	"reversal_of_journal_entry_id" uuid,
	"reversed_by_journal_entry_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_tenant_entity_number_unique" UNIQUE("tenant_id","legal_entity_id","journal_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_amounts_non_negative" CHECK ("journal_lines"."debit_minor" >= 0 AND "journal_lines"."credit_minor" >= 0),
	CONSTRAINT "journal_lines_single_sided" CHECK (NOT ("journal_lines"."debit_minor" > 0 AND "journal_lines"."credit_minor" > 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_number_counters" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"last_assigned_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "journal_number_counters_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_fk" FOREIGN KEY ("reversal_of_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_fk" FOREIGN KEY ("reversed_by_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_periods_tenant_entity_idx" ON "accounting_periods" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_tenant_entity_idx" ON "journal_entries" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_period_idx" ON "journal_entries" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_journal_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");