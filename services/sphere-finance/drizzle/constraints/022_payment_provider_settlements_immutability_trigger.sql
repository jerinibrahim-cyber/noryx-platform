-- payment_provider_settlements has no legitimate mutation once its
-- parent payment_provider_settlement_imports' reconciliation_status =
-- COMPLETED — no exceptions. Mirrors
-- 020_bank_statement_lines_immutability_trigger.sql's shape (join to
-- the parent row's own lifecycle status) exactly.
-- docs/finance-work-item-banking-1e-proposal.md §18/§22, CTO-approved.
-- Blocks INSERT as well as UPDATE/DELETE — appending a new settlement
-- record, or editing/removing an existing one (including the
-- matchStatus cache column), to an already-completed reconciliation
-- would be just as much a rewrite of a historical, immutable snapshot
-- as editing one. Reconciliation completion never inserts a new
-- settlement record, so this never blocks a legitimate write path.

CREATE OR REPLACE FUNCTION prevent_completed_payment_provider_settlement_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_import_id uuid;
  parent_reconciliation_status payment_settlement_reconciliation_status;
BEGIN
  target_import_id := COALESCE(NEW.settlement_import_id, OLD.settlement_import_id);

  SELECT reconciliation_status INTO parent_reconciliation_status
  FROM payment_provider_settlement_imports
  WHERE id = target_import_id;

  IF parent_reconciliation_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'payment_provider_settlements is immutable once its parent payment_provider_settlement_imports reconciliation is COMPLETED: % is not permitted (settlement_import_id=%)',
      TG_OP, target_import_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_provider_settlements_immutable ON payment_provider_settlements;
CREATE TRIGGER payment_provider_settlements_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payment_provider_settlements
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_payment_provider_settlement_mutation();
