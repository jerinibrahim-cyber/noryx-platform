CREATE TYPE "public"."budget_status" AS ENUM('DRAFT', 'APPROVED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_lines_budget_account_period_unique" UNIQUE("budget_id","account_id","period_id"),
	CONSTRAINT "budget_lines_amount_non_negative" CHECK ("budget_lines"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"status" "budget_status" DEFAULT 'DRAFT' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code"),
	CONSTRAINT "budgets_end_after_start" CHECK ("budgets"."end_date" > "budgets"."start_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_lines_tenant_entity_idx" ON "budget_lines" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_lines_budget_idx" ON "budget_lines" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budgets_tenant_entity_idx" ON "budgets" USING btree ("tenant_id","legal_entity_id");