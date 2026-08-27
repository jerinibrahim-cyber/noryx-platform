-- customer_credit_note_lines has no legitimate mutation once its parent
-- customer_credit_notes is POSTED — no exceptions at all. Mirrors
-- 010_customer_invoice_lines_immutability_trigger.sql exactly, joined to
-- the parent credit note's status instead of an invoice's.
-- docs/finance-work-item-credit-debit-notes-proposal.md §8. Blocks
-- INSERT as well as UPDATE/DELETE — appending a new line to an
-- already-posted credit note would be just as much a rewrite of history
-- as editing an existing one.

CREATE OR REPLACE FUNCTION prevent_posted_customer_credit_note_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_credit_note_id uuid;
  parent_status customer_credit_note_status;
BEGIN
  target_credit_note_id := COALESCE(NEW.credit_note_id, OLD.credit_note_id);

  SELECT status INTO parent_status FROM customer_credit_notes WHERE id = target_credit_note_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_credit_note_lines is immutable once its parent customer_credit_notes is POSTED: % is not permitted (credit_note_id=%)',
      TG_OP, target_credit_note_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_credit_note_lines_immutable ON customer_credit_note_lines;
CREATE TRIGGER customer_credit_note_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON customer_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_credit_note_line_mutation();
