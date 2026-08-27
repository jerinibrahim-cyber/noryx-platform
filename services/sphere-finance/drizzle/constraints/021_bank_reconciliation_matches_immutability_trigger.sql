-- bank_reconciliation_matches — a deliberate, narrow deviation from the
-- codebase's dominant zero-exception posture (docs/finance-work-item-
-- banking-1c-proposal.md §15, CTO-approved): while the parent import's
-- reconciliation_status = OPEN, a match may be created (INSERT) or
-- soft-undone (UPDATE, status ACTIVE -> UNDONE) — undoing a link is not
-- an accounting mutation (nothing in journal_entries/bank_transactions
-- changes). Once the parent import's reconciliation_status = COMPLETED,
-- this table becomes genuinely immutable — no exceptions, same shape as
-- 020_bank_statement_lines_immutability_trigger.sql, joined to
-- bank_statement_imports via bank_reconciliation_matches' own
-- statement_line_id -> bank_statement_lines -> statement_import_id path
-- (this table has no direct FK to bank_statement_imports itself).

CREATE OR REPLACE FUNCTION prevent_completed_bank_reconciliation_match_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_line_id uuid;
  parent_reconciliation_status bank_reconciliation_status;
BEGIN
  target_line_id := COALESCE(NEW.statement_line_id, OLD.statement_line_id);

  SELECT bsi.reconciliation_status INTO parent_reconciliation_status
  FROM bank_statement_lines bsl
  INNER JOIN bank_statement_imports bsi ON bsi.id = bsl.statement_import_id
  WHERE bsl.id = target_line_id;

  IF parent_reconciliation_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'bank_reconciliation_matches is immutable once its parent bank_statement_imports reconciliation is COMPLETED: % is not permitted (statement_line_id=%)',
      TG_OP, target_line_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_reconciliation_matches_immutable ON bank_reconciliation_matches;
CREATE TRIGGER bank_reconciliation_matches_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_bank_reconciliation_match_mutation();
