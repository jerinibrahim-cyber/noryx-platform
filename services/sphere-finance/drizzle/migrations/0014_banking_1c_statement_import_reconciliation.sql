CREATE TYPE "public"."bank_reconciliation_match_status" AS ENUM('ACTIVE', 'UNDONE');--> statement-breakpoint
CREATE TYPE "public"."bank_reconciliation_match_type" AS ENUM('DETERMINISTIC_MATCH', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."bank_reconciliation_status" AS ENUM('OPEN', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_import_status" AS ENUM('PENDING', 'VALIDATED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_line_direction" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_line_match_status" AS ENUM('UNMATCHED', 'PARTIALLY_MATCHED', 'MATCHED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_source_format" AS ENUM('CSV_GENERIC');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_reconciliation_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"matched_amount_minor" bigint NOT NULL,
	"match_type" "bank_reconciliation_match_type" NOT NULL,
	"status" "bank_reconciliation_match_status" DEFAULT 'ACTIVE' NOT NULL,
	"matched_by" uuid,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_matches_amount_positive" CHECK ("bank_reconciliation_matches"."matched_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"source_format" "bank_statement_source_format" NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"statement_date_from" date NOT NULL,
	"statement_date_to" date NOT NULL,
	"opening_balance_minor" bigint,
	"closing_balance_minor" bigint,
	"status" "bank_statement_import_status" DEFAULT 'PENDING' NOT NULL,
	"reconciliation_status" "bank_reconciliation_status" DEFAULT 'OPEN' NOT NULL,
	"parse_warnings" jsonb,
	"parse_errors" jsonb,
	"imported_by" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_imports_account_file_hash_unique" UNIQUE("tenant_id","legal_entity_id","bank_cash_account_id","file_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"statement_import_id" uuid NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"line_date" date NOT NULL,
	"value_date" date,
	"direction" "bank_statement_line_direction" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"external_reference" varchar(100),
	"raw_description" text,
	"line_fingerprint" varchar(64) NOT NULL,
	"match_status" "bank_statement_line_match_status" DEFAULT 'UNMATCHED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_amount_positive" CHECK ("bank_statement_lines"."amount_minor" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_reconciliation_matches_line_idx" ON "bank_reconciliation_matches" USING btree ("statement_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_reconciliation_matches_bank_txn_idx" ON "bank_reconciliation_matches" USING btree ("bank_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_imports_tenant_entity_idx" ON "bank_statement_imports" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_imports_bank_cash_account_idx" ON "bank_statement_imports" USING btree ("bank_cash_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_lines_import_idx" ON "bank_statement_lines" USING btree ("statement_import_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_lines_account_idx" ON "bank_statement_lines" USING btree ("bank_cash_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_lines_fingerprint_idx" ON "bank_statement_lines" USING btree ("bank_cash_account_id","line_fingerprint");