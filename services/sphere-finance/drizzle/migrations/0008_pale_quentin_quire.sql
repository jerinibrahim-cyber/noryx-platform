CREATE TABLE IF NOT EXISTS "ar_settings" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ar_control_account_id" uuid NOT NULL,
	"tax_output_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ar_settings_tenant_id_legal_entity_id_pk" PRIMARY KEY("tenant_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"payment_terms_days" integer,
	"tax_registration_no" varchar(64),
	"default_revenue_account_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ar_settings" ADD CONSTRAINT "ar_settings_ar_control_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("ar_control_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ar_settings" ADD CONSTRAINT "ar_settings_tax_output_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("tax_output_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customers" ADD CONSTRAINT "customers_default_revenue_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("default_revenue_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_tenant_entity_idx" ON "customers" USING btree ("tenant_id","legal_entity_id");