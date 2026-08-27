-- Posted-debit-note immutability, ZERO-exception style — exact AP mirror
-- of 013_customer_credit_notes_immutability_trigger.sql. No column on a
-- POSTED supplier_debit_notes row may ever change; nothing in the
-- locked scope of
-- docs/finance-work-item-credit-debit-notes-proposal.md ever writes
-- back to a POSTED debit note itself.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_debit_note_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'supplier_debit_notes is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_debit_notes is immutable once POSTED: UPDATE is not permitted, no column may change (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_debit_notes_immutable ON supplier_debit_notes;
CREATE TRIGGER supplier_debit_notes_immutable
  BEFORE UPDATE OR DELETE ON supplier_debit_notes
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_debit_note_mutation();
