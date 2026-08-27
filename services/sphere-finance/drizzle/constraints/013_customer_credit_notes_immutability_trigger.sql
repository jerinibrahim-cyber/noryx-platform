-- Posted-credit-note immutability, ZERO-exception style — mirrors
-- 011_customer_receipts_immutability_trigger.sql, not
-- 009_customer_invoices_immutability_trigger.sql's narrow exception: no
-- column on a POSTED customer_credit_notes row may ever change. Unlike
-- customer_invoices/supplier_bills (which have a real future writer —
-- paid_minor/payment_status, consumed by AR-1c/AP-1c and now this work
-- item), nothing in the locked scope of
-- docs/finance-work-item-credit-debit-notes-proposal.md ever writes back
-- to a POSTED credit note itself. Should a future Work Item need one
-- (e.g. a credit-note void/unwind feature), that migration adds the
-- narrow exception then, the same way AR-1b's own paid_minor/
-- payment_status exception was added ahead of its AR-1c consumer.

CREATE OR REPLACE FUNCTION prevent_posted_customer_credit_note_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'customer_credit_notes is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_credit_notes is immutable once POSTED: UPDATE is not permitted, no column may change (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_credit_notes_immutable ON customer_credit_notes;
CREATE TRIGGER customer_credit_notes_immutable
  BEFORE UPDATE OR DELETE ON customer_credit_notes
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_credit_note_mutation();
