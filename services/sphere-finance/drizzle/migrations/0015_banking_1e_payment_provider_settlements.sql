CREATE TYPE "public"."bank_cash_account_purpose" AS ENUM('OPERATING', 'CLEARING');--> statement-breakpoint
CREATE TYPE "public"."payment_provider_settlement_format" AS ENUM('GENERIC_SETTLEMENT_CSV');--> statement-breakpoint
CREATE TYPE "public"."payment_provider_settlement_import_status" AS ENUM('PENDING', 'VALIDATED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_match_state" AS ENUM('ACTIVE', 'UNDONE');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_match_status" AS ENUM('UNMATCHED', 'PARTIALLY_MATCHED', 'MATCHED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_match_type" AS ENUM('DETERMINISTIC_MATCH', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."payment_settlement_reconciliation_status" AS ENUM('OPEN', 'COMPLETED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_provider_settlement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"provider_format" "payment_provider_settlement_format" NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"status" "payment_provider_settlement_import_status" DEFAULT 'PENDING' NOT NULL,
	"reconciliation_status" "payment_settlement_reconciliation_status" DEFAULT 'OPEN' NOT NULL,
	"parse_warnings" jsonb,
	"parse_errors" jsonb,
	"imported_by" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ppsi_account_file_hash_unique" UNIQUE("tenant_id","legal_entity_id","bank_cash_account_id","file_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_provider_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"settlement_import_id" uuid NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"provider_settlement_id" varchar(100) NOT NULL,
	"settlement_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"gross_amount_minor" bigint NOT NULL,
	"fee_amount_minor" bigint DEFAULT 0 NOT NULL,
	"adjustment_amount_minor" bigint DEFAULT 0 NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"raw_description" text,
	"match_status" "payment_settlement_match_status" DEFAULT 'UNMATCHED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pps_account_provider_settlement_id_unique" UNIQUE("tenant_id","legal_entity_id","bank_cash_account_id","provider_settlement_id"),
	CONSTRAINT "payment_provider_settlements_arithmetic" CHECK ("payment_provider_settlements"."gross_amount_minor" - "payment_provider_settlements"."fee_amount_minor" + "payment_provider_settlements"."adjustment_amount_minor" = "payment_provider_settlements"."net_amount_minor"),
	CONSTRAINT "payment_provider_settlements_gross_positive" CHECK ("payment_provider_settlements"."gross_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_settlement_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payment_provider_settlement_id" uuid NOT NULL,
	"bank_statement_line_id" uuid NOT NULL,
	"matched_amount_minor" bigint NOT NULL,
	"match_type" "payment_settlement_match_type" NOT NULL,
	"status" "payment_settlement_match_state" DEFAULT 'ACTIVE' NOT NULL,
	"matched_by" uuid,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settlement_matches_amount_positive" CHECK ("payment_settlement_matches"."matched_amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "bank_cash_accounts" ADD COLUMN "purpose" "bank_cash_account_purpose" DEFAULT 'OPERATING' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_provider_settlement_imports" ADD CONSTRAINT "payment_provider_settlement_imports_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_provider_settlements" ADD CONSTRAINT "payment_provider_settlements_settlement_import_id_payment_provider_settlement_imports_id_fk" FOREIGN KEY ("settlement_import_id") REFERENCES "public"."payment_provider_settlement_imports"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_provider_settlements" ADD CONSTRAINT "payment_provider_settlements_bank_cash_account_id_bank_cash_accounts_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_settlement_matches" ADD CONSTRAINT "payment_settlement_matches_payment_provider_settlement_id_payment_provider_settlements_id_fk" FOREIGN KEY ("payment_provider_settlement_id") REFERENCES "public"."payment_provider_settlements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_settlement_matches" ADD CONSTRAINT "payment_settlement_matches_bank_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("bank_statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ppsi_tenant_entity_idx" ON "payment_provider_settlement_imports" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ppsi_bank_cash_account_idx" ON "payment_provider_settlement_imports" USING btree ("bank_cash_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pps_import_idx" ON "payment_provider_settlements" USING btree ("settlement_import_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pps_account_idx" ON "payment_provider_settlements" USING btree ("bank_cash_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "psm_settlement_idx" ON "payment_settlement_matches" USING btree ("payment_provider_settlement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "psm_bank_line_idx" ON "payment_settlement_matches" USING btree ("bank_statement_line_id");