-- bank_statement_lines has no legitimate mutation once its parent
-- bank_statement_imports' reconciliation_status = COMPLETED — no
-- exceptions. Mirrors 008_supplier_payment_allocations_immutability_
-- trigger.sql's shape (join to the parent row's own lifecycle status),
-- joined to bank_statement_imports.reconciliation_status instead of a
-- payment's status.
-- docs/finance-work-item-banking-1c-proposal.md §15, CTO-approved.
-- Blocks INSERT as well as UPDATE/DELETE — appending a new line, or
-- editing/removing an existing one (including the matchStatus cache
-- column), to an already-completed reconciliation would be just as much
-- a rewrite of a historical, immutable snapshot (§15) as editing one.
-- Reconciliation completion (§9) never inserts a new statement line, so
-- this never blocks a legitimate write path.

CREATE OR REPLACE FUNCTION prevent_completed_bank_statement_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_import_id uuid;
  parent_reconciliation_status bank_reconciliation_status;
BEGIN
  target_import_id := COALESCE(NEW.statement_import_id, OLD.statement_import_id);

  SELECT reconciliation_status INTO parent_reconciliation_status
  FROM bank_statement_imports
  WHERE id = target_import_id;

  IF parent_reconciliation_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'bank_statement_lines is immutable once its parent bank_statement_imports reconciliation is COMPLETED: % is not permitted (statement_import_id=%)',
      TG_OP, target_import_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_statement_lines_immutable ON bank_statement_lines;
CREATE TRIGGER bank_statement_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_bank_statement_line_mutation();
