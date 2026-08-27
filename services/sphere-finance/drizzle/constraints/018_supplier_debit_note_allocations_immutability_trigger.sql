-- supplier_debit_note_allocations has no legitimate mutation once its
-- parent supplier_debit_notes is POSTED — no exceptions at all. Exact AP
-- mirror of
-- 015_customer_credit_note_allocations_immutability_trigger.sql.
-- docs/finance-work-item-credit-debit-notes-proposal.md §8/§9. Blocks
-- INSERT as well as UPDATE/DELETE — allocations are inserted at DRAFT
-- create/edit time only, exactly like
-- supplier_debit_note_lines/supplier_payment_allocations.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_debit_note_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_debit_note_id uuid;
  parent_status supplier_debit_note_status;
BEGIN
  target_debit_note_id := COALESCE(NEW.debit_note_id, OLD.debit_note_id);

  SELECT status INTO parent_status FROM supplier_debit_notes WHERE id = target_debit_note_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_debit_note_allocations is immutable once its parent supplier_debit_notes is POSTED: % is not permitted (debit_note_id=%)',
      TG_OP, target_debit_note_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_debit_note_allocations_immutable ON supplier_debit_note_allocations;
CREATE TRIGGER supplier_debit_note_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_debit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_debit_note_allocation_mutation();
