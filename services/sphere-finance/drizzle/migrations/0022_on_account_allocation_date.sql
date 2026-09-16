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

-- 1) supplier_payment_allocations -------------------------------------------
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "allocation_date" date;--> statement-breakpoint
UPDATE "supplier_payment_allocations" spa
  SET "allocation_date" = sp."payment_date"
  FROM "supplier_payments" sp
  WHERE sp."id" = spa."payment_id";--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ALTER COLUMN "allocation_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" DROP CONSTRAINT "supplier_payment_allocations_payment_bill_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payment_allocations_payment_bill_idx" ON "supplier_payment_allocations" USING btree ("payment_id","bill_id");--> statement-breakpoint

-- 2) customer_receipt_allocations (byte-mirror) ------------------------------
ALTER TABLE "customer_receipt_allocations" ADD COLUMN "allocation_date" date;--> statement-breakpoint
UPDATE "customer_receipt_allocations" cra
  SET "allocation_date" = cr."receipt_date"
  FROM "customer_receipts" cr
  WHERE cr."id" = cra."receipt_id";--> statement-breakpoint
ALTER TABLE "customer_receipt_allocations" ALTER COLUMN "allocation_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_receipt_allocations" DROP CONSTRAINT "customer_receipt_allocations_receipt_invoice_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_receipt_allocations_receipt_invoice_idx" ON "customer_receipt_allocations" USING btree ("receipt_id","invoice_id");
