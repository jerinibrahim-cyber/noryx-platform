-- payment_settlement_matches — a deliberate, narrow deviation from the
-- codebase's dominant zero-exception posture (docs/finance-work-item-
-- banking-1e-proposal.md §18, mirroring Banking-1c's own identical,
-- CTO-approved deviation for bank_reconciliation_matches): while the
-- parent import's reconciliation_status = OPEN, a match may be created
-- (INSERT) or soft-undone (UPDATE, status ACTIVE -> UNDONE) — undoing a
-- link is not an accounting mutation (nothing in
-- journal_entries/bank_transactions changes). Once the parent import's
-- reconciliation_status = COMPLETED, this table becomes genuinely
-- immutable — no exceptions, same shape as
-- 021_bank_reconciliation_matches_immutability_trigger.sql, joined to
-- payment_provider_settlement_imports via this table's own
-- payment_provider_settlement_id -> payment_provider_settlements ->
-- settlement_import_id path (this table has no direct FK to
-- payment_provider_settlement_imports itself).

CREATE OR REPLACE FUNCTION prevent_completed_payment_settlement_match_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_settlement_id uuid;
  parent_reconciliation_status payment_settlement_reconciliation_status;
BEGIN
  target_settlement_id := COALESCE(
    NEW.payment_provider_settlement_id,
    OLD.payment_provider_settlement_id
  );

  SELECT ppsi.reconciliation_status INTO parent_reconciliation_status
  FROM payment_provider_settlements pps
  INNER JOIN payment_provider_settlement_imports ppsi
    ON ppsi.id = pps.settlement_import_id
  WHERE pps.id = target_settlement_id;

  IF parent_reconciliation_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'payment_settlement_matches is immutable once its parent payment_provider_settlement_imports reconciliation is COMPLETED: % is not permitted (payment_provider_settlement_id=%)',
      TG_OP, target_settlement_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_settlement_matches_immutable ON payment_settlement_matches;
CREATE TRIGGER payment_settlement_matches_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payment_settlement_matches
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_payment_settlement_match_mutation();
