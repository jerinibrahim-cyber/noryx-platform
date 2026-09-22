CREATE TYPE "public"."deferral_recognition_status" AS ENUM('SCHEDULED', 'EXECUTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."deferral_schedule_status" AS ENUM('ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."deferral_type" AS ENUM('EXPENSE_RECOGNITION', 'REVENUE_RECOGNITION');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deferral_recognitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"target_date" date NOT NULL,
	"amount_minor" integer NOT NULL,
	"status" "deferral_recognition_status" DEFAULT 'SCHEDULED' NOT NULL,
	"resulting_journal_entry_id" uuid,
	"failure_reason" text,
	"executed_at" timestamp with time zone,
	"executed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deferral_recognitions_schedule_sequence_unique" UNIQUE("schedule_id","sequence_number"),
	CONSTRAINT "deferral_recognitions_schedule_target_date_unique" UNIQUE("schedule_id","target_date"),
	CONSTRAINT "deferral_recognitions_amount_positive" CHECK ("deferral_recognitions"."amount_minor" > 0),
	CONSTRAINT "deferral_recognitions_terminal_fields_consistent" CHECK (
        ("deferral_recognitions"."status" = 'SCHEDULED' AND "deferral_recognitions"."resulting_journal_entry_id" IS NULL
                                    AND "deferral_recognitions"."failure_reason" IS NULL AND "deferral_recognitions"."executed_at" IS NULL)
        OR ("deferral_recognitions"."status" = 'EXECUTED' AND "deferral_recognitions"."resulting_journal_entry_id" IS NOT NULL
                                     AND "deferral_recognitions"."failure_reason" IS NULL AND "deferral_recognitions"."executed_at" IS NOT NULL)
        OR ("deferral_recognitions"."status" = 'FAILED' AND "deferral_recognitions"."resulting_journal_entry_id" IS NULL
                                   AND "deferral_recognitions"."failure_reason" IS NOT NULL AND "deferral_recognitions"."executed_at" IS NOT NULL)
        OR ("deferral_recognitions"."status" = 'CANCELLED' AND "deferral_recognitions"."resulting_journal_entry_id" IS NULL
                                      AND "deferral_recognitions"."executed_at" IS NULL)
      )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deferral_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"memo" text NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"total_amount_minor" integer NOT NULL,
	"deferral_type" "deferral_type" NOT NULL,
	"deferred_account_id" uuid NOT NULL,
	"recognition_account_id" uuid NOT NULL,
	"status" "deferral_schedule_status" DEFAULT 'ACTIVE' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deferral_schedules_accounts_distinct" CHECK ("deferral_schedules"."deferred_account_id" <> "deferral_schedules"."recognition_account_id"),
	CONSTRAINT "deferral_schedules_total_amount_positive" CHECK ("deferral_schedules"."total_amount_minor" > 0),
	CONSTRAINT "deferral_schedules_terminal_fields_consistent" CHECK (
        ("deferral_schedules"."status" IN ('ACTIVE', 'COMPLETED') AND "deferral_schedules"."cancelled_at" IS NULL
                                                  AND "deferral_schedules"."cancellation_reason" IS NULL)
        OR ("deferral_schedules"."status" = 'CANCELLED' AND "deferral_schedules"."cancelled_at" IS NOT NULL)
      )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferral_recognitions" ADD CONSTRAINT "deferral_recognitions_schedule_id_deferral_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."deferral_schedules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferral_recognitions" ADD CONSTRAINT "deferral_recognitions_resulting_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("resulting_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_deferred_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("deferred_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferral_schedules" ADD CONSTRAINT "deferral_schedules_recognition_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("recognition_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferral_recognitions_due_lookup" ON "deferral_recognitions" USING btree ("tenant_id","legal_entity_id","status","target_date","id") WHERE "deferral_recognitions"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferral_recognitions_schedule_idx" ON "deferral_recognitions" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferral_recognitions_resulting_journal_entry_idx" ON "deferral_recognitions" USING btree ("resulting_journal_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferral_schedules_tenant_entity_idx" ON "deferral_schedules" USING btree ("tenant_id","legal_entity_id");