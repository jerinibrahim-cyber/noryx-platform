-- customer_invoice_lines has no legitimate mutation once its parent
-- customer_invoices is POSTED — no exceptions at all (unlike
-- customer_invoices' one narrow paid_minor/payment_status exception).
-- Mirrors 006_supplier_bill_lines_immutability_trigger.sql exactly,
-- joined to the parent invoice's status instead of a bill's.
-- docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §4.
-- Blocks INSERT as well as UPDATE/DELETE — appending a new line to an
-- already-posted invoice would be just as much a rewrite of history as
-- editing an existing one.

CREATE OR REPLACE FUNCTION prevent_posted_customer_invoice_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_invoice_id uuid;
  parent_status customer_invoice_status;
BEGIN
  target_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT status INTO parent_status FROM customer_invoices WHERE id = target_invoice_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_invoice_lines is immutable once its parent customer_invoices is POSTED: % is not permitted (invoice_id=%)',
      TG_OP, target_invoice_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_invoice_lines_immutable ON customer_invoice_lines;
CREATE TRIGGER customer_invoice_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON customer_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_invoice_line_mutation();
