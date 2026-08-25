-- Posted-payment immutability, ZERO-exception style — unlike
-- 005_supplier_bills_immutability_trigger.sql's narrow paid_minor/
-- payment_status exception, no column on a POSTED supplier_payments row
-- may ever change. No future writer is known for any column on this
-- table within the current locked roadmap (no void/unwind, no
-- correction workflow in AP-1c — docs/finance-work-item-1c-supplier-
-- payments-proposal.md §5). Should a future Work Item need one (e.g. a
-- payment-correction/void feature), that migration adds the narrow
-- exception then, the same way AP-1b's own paid_minor/payment_status
-- exception was added ahead of its AP-1c consumer.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_payment_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'supplier_payments is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_payments is immutable once POSTED: UPDATE is not permitted, no column may change (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_payments_immutable ON supplier_payments;
CREATE TRIGGER supplier_payments_immutable
  BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_payment_mutation();
