-- Posted-receipt immutability, ZERO-exception style — unlike
-- 009_customer_invoices_immutability_trigger.sql's narrow paid_minor/
-- payment_status exception, no column on a POSTED customer_receipts row
-- may ever change. No future writer is known for any column on this
-- table within the current locked roadmap (no void/unwind, no
-- correction workflow in AR-1c — docs/finance-work-item-1c-customer-
-- receipts-proposal.md §8). Should a future Work Item need one (e.g. a
-- receipt-correction/void feature), that migration adds the narrow
-- exception then, the same way AR-1b's own paid_minor/payment_status
-- exception was added ahead of its AR-1c consumer. Mirrors
-- 007_supplier_payments_immutability_trigger.sql exactly.

CREATE OR REPLACE FUNCTION prevent_posted_customer_receipt_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'customer_receipts is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_receipts is immutable once POSTED: UPDATE is not permitted, no column may change (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_receipts_immutable ON customer_receipts;
CREATE TRIGGER customer_receipts_immutable
  BEFORE UPDATE OR DELETE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_receipt_mutation();
