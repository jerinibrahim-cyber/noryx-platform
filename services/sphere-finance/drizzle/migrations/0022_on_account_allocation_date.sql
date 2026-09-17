-- On-Account (Unapplied) Supplier Payments & Customer Receipts work item
-- (docs/finance-work-item-on-account-payments-proposal.md §15.1/§16,
-- CTO Architecture Gate, approved implementation authorization).
--
-- Ordering is safety-critical against a live production table (proposal
-- §16): add allocation_date NULLABLE first, backfill every pre-existing
-- row from its own parent's payment_date/receipt_date (the historically
-- accurate value for every row that exists before this migration runs,
-- since today's only insertion path creates a row contemporaneously
-- with its parent's own posting), THEN set NOT NULL, THEN drop the old
-- unique constraint and add the new non-unique index. This migration
-- makes no application-code-visible change by itself — supplier-
-- payments.service.ts / customer-receipts.service.ts are deployed
-- separately, after this migration and the new trigger version (§16
-- rollout ordering).

-- CTO remediation runtime-verification finding (NORYX SPHERE final
-- runtime quality gate, MODE=seeded run of
-- scripts/verify-on-account-migration-safety.sh — see the completion
-- report's defects section): against a database with realistic
-- pre-existing data, this migration's own backfill UPDATE statements
-- below were rejected by the still-active OLD (v1)
-- supplier_payment_allocations_immutable /
-- customer_receipt_allocations_immutability_trigger — see
-- drizzle/constraints/008_supplier_payment_allocations_immutability_trigger.sql
-- / 012_customer_receipt_allocations_immutability_trigger.sql, "no
-- exceptions at all" — for any row whose parent payment/receipt is
-- already POSTED, which is the normal case for real historical data
-- (only ever caught against an empty/fresh database, where there is
-- nothing to backfill and the UPDATE trivially affects 0 rows). Fixed by
-- dropping the old blocking trigger immediately before each backfill
-- UPDATE; drizzle/constraints/026_supplier_payment_allocations_immutability_trigger_v2.sql
-- and .../027_customer_receipt_allocations_immutability_trigger_v2.sql —
-- applied immediately after this migration, per this work item's own
-- documented rollout ordering (see this file's original header comment
-- above) — recreate a (differently-behaved) trigger of the same name
-- right after, so the interim window with no trigger on these two
-- tables is bounded by this migration script itself.

-- 1) supplier_payment_allocations -------------------------------------------
DROP TRIGGER IF EXISTS "supplier_payment_allocations_immutable" ON "supplier_payment_allocations";--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "allocation_date" date;--> statement-breakpoint
UPDATE "supplier_payment_allocations" spa
  SET "allocation_date" = sp."payment_date"
  FROM "supplier_payments" sp
  WHERE sp."id" = spa."payment_id";--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ALTER COLUMN "allocation_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" DROP CONSTRAINT "supplier_payment_allocations_payment_bill_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payment_allocations_payment_bill_idx" ON "supplier_payment_allocations" USING btree ("payment_id","bill_id");--> statement-breakpoint

-- 2) customer_receipt_allocations (byte-mirror) ------------------------------
DROP TRIGGER IF EXISTS "customer_receipt_allocations_immutable" ON "customer_receipt_allocations";--> statement-breakpoint
ALTER TABLE "customer_receipt_allocations" ADD COLUMN "allocation_date" date;--> statement-breakpoint
UPDATE "customer_receipt_allocations" cra
  SET "allocation_date" = cr."receipt_date"
  FROM "customer_receipts" cr
  WHERE cr."id" = cra."receipt_id";--> statement-breakpoint
ALTER TABLE "customer_receipt_allocations" ALTER COLUMN "allocation_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_receipt_allocations" DROP CONSTRAINT "customer_receipt_allocations_receipt_invoice_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_receipt_allocations_receipt_invoice_idx" ON "customer_receipt_allocations" USING btree ("receipt_id","invoice_id");
