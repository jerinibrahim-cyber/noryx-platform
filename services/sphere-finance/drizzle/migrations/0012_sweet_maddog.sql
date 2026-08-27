CREATE TYPE "public"."bank_cash_account_kind" AS ENUM('BANK', 'CASH');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_cash_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" "bank_cash_account_kind" NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"bank_name" varchar(255),
	"masked_account_number" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_cash_accounts_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code"),
	CONSTRAINT "bank_cash_accounts_gl_account_unique" UNIQUE("gl_account_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_cash_accounts" ADD CONSTRAINT "bank_cash_accounts_gl_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_cash_accounts_tenant_entity_idx" ON "bank_cash_accounts" USING btree ("tenant_id","legal_entity_id");