-- customer_credit_note_allocations has no legitimate mutation once its
-- parent customer_credit_notes is POSTED — no exceptions at all. Mirrors
-- 012_customer_receipt_allocations_immutability_trigger.sql exactly,
-- joined to the parent credit note's status instead of a receipt's.
-- docs/finance-work-item-credit-debit-notes-proposal.md §8/§9. Blocks
-- INSERT as well as UPDATE/DELETE — appending a new allocation to an
-- already-posted credit note would be just as much a rewrite of history
-- as editing an existing one. This also means
-- CustomerCreditNotesService.post() must never attempt to insert a new
-- allocation row after flipping the parent credit note to POSTED — it
-- doesn't: allocations are inserted at DRAFT create/edit time only,
-- exactly like customer_credit_note_lines/customer_receipt_allocations.

CREATE OR REPLACE FUNCTION prevent_posted_customer_credit_note_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_credit_note_id uuid;
  parent_status customer_credit_note_status;
BEGIN
  target_credit_note_id := COALESCE(NEW.credit_note_id, OLD.credit_note_id);

  SELECT status INTO parent_status FROM customer_credit_notes WHERE id = target_credit_note_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_credit_note_allocations is immutable once its parent customer_credit_notes is POSTED: % is not permitted (credit_note_id=%)',
      TG_OP, target_credit_note_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_credit_note_allocations_immutable ON customer_credit_note_allocations;
CREATE TRIGGER customer_credit_note_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON customer_credit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_credit_note_allocation_mutation();
