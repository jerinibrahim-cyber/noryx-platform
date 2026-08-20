ALTER TABLE "chart_of_accounts" DROP CONSTRAINT "chart_of_accounts_tenant_code_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "chart_of_accounts_tenant_id_idx";--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chart_of_accounts_tenant_entity_idx" ON "chart_of_accounts" USING btree ("tenant_id","legal_entity_id");--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_tenant_entity_code_unique" UNIQUE("tenant_id","legal_entity_id","code");