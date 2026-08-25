-- supplier_bill_lines has no legitimate mutation once its parent
-- supplier_bills is POSTED — no exceptions at all (unlike
-- supplier_bills' one narrow paid_minor/payment_status exception).
-- Mirrors 004_journal_lines_immutability_trigger.sql exactly, joined to
-- the parent bill's status instead of a journal entry's.
-- docs/finance-work-item-1b-supplier-bills-proposal.md §19. Blocks
-- INSERT as well as UPDATE/DELETE — appending a new line to an
-- already-posted bill would be just as much a rewrite of history as
-- editing an existing one.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_bill_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_bill_id uuid;
  parent_status supplier_bill_status;
BEGIN
  target_bill_id := COALESCE(NEW.bill_id, OLD.bill_id);

  SELECT status INTO parent_status FROM supplier_bills WHERE id = target_bill_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_bill_lines is immutable once its parent supplier_bills is POSTED: % is not permitted (bill_id=%)',
      TG_OP, target_bill_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_bill_lines_immutable ON supplier_bill_lines;
CREATE TRIGGER supplier_bill_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_bill_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_bill_line_mutation();
