CREATE TYPE "public"."tax_treatment" AS ENUM('STANDARD', 'ZERO_RATED', 'EXEMPT');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"treatment" "tax_treatment" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_codes_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_rate_non_negative" CHECK ("tax_rates"."rate_basis_points" >= 0),
	CONSTRAINT "tax_rates_end_after_start" CHECK ("tax_rates"."effective_to" IS NULL OR "tax_rates"."effective_to" > "tax_rates"."effective_from")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_codes_tenant_entity_idx" ON "tax_codes" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_rates_tenant_entity_code_idx" ON "tax_rates" USING btree ("tenant_id","legal_entity_id","tax_code_id");