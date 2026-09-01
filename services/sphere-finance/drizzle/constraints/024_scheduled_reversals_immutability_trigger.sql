-- Scheduled Reversal for Accruals and Other Timing Adjustments — Final
-- Implementation Specification (Revision 2), §7. Once a scheduled_reversals
-- row reaches any of its three terminal statuses (EXECUTED, FAILED,
-- CANCELLED), no column may ever change and the row may never be
-- deleted — simpler than journal_entries' own immutability trigger
-- (003_journal_entries_immutability_trigger.sql) because there is no
-- narrow single-column exception to carve out here: the SCHEDULED ->
-- terminal transition IS the one legitimate mutation, performed by the
-- application while status is still SCHEDULED, and nothing about a
-- terminal row is ever touched again.

CREATE OR REPLACE FUNCTION prevent_terminal_scheduled_reversal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('EXECUTED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'scheduled_reversals is immutable once %: DELETE is not permitted (id=%)', OLD.status, OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status IN ('EXECUTED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'scheduled_reversals is immutable once %: no column may change (id=%)', OLD.status, OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scheduled_reversals_terminal_immutable ON scheduled_reversals;
CREATE TRIGGER scheduled_reversals_terminal_immutable
  BEFORE UPDATE OR DELETE ON scheduled_reversals
  FOR EACH ROW EXECUTE FUNCTION prevent_terminal_scheduled_reversal_mutation();
