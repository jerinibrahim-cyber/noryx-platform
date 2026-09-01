CREATE TYPE "public"."scheduled_reversal_status" AS ENUM('SCHEDULED', 'EXECUTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"original_journal_entry_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"status" "scheduled_reversal_status" DEFAULT 'SCHEDULED' NOT NULL,
	"resulting_reversal_journal_entry_id" uuid,
	"failure_reason" text,
	"executed_at" timestamp with time zone,
	"executed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_reversals_terminal_fields_consistent" CHECK (
        (status = 'SCHEDULED' AND resulting_reversal_journal_entry_id IS NULL
                               AND failure_reason IS NULL AND executed_at IS NULL)
        OR (status = 'EXECUTED' AND resulting_reversal_journal_entry_id IS NOT NULL
                                 AND failure_reason IS NULL AND executed_at IS NOT NULL)
        OR (status = 'FAILED' AND resulting_reversal_journal_entry_id IS NULL
                               AND failure_reason IS NOT NULL AND executed_at IS NOT NULL)
        OR (status = 'CANCELLED' AND resulting_reversal_journal_entry_id IS NULL
                                  AND executed_at IS NULL)
      )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_reversals" ADD CONSTRAINT "scheduled_reversals_original_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("original_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_reversals" ADD CONSTRAINT "scheduled_reversals_resulting_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("resulting_reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_reversals_due_lookup" ON "scheduled_reversals" USING btree ("tenant_id","legal_entity_id","status","target_date","id") WHERE "scheduled_reversals"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_reversals_one_active_per_original" ON "scheduled_reversals" USING btree ("original_journal_entry_id") WHERE "scheduled_reversals"."status" = 'SCHEDULED';