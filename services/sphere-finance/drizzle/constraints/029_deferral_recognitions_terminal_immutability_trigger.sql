-- Generic Deferral Recognition Engine — Phase 2 Implementation Contract
-- (docs/work-items/deferral-recognition-engine/CONTRACT.md §2). Once a
-- deferral_recognitions row reaches any of its three terminal statuses
-- (EXECUTED, FAILED, CANCELLED), no column may ever change and the row
-- may never be deleted — direct copy of
-- 024_scheduled_reversals_immutability_trigger.sql's function; this
-- table's status shape is identical to scheduled_reversal_status
-- (SCHEDULED -> EXECUTED | FAILED | CANCELLED, no PROCESSING
-- intermediate state, per CONTRACT.md §2's explicit anti-pattern
-- reasoning).

CREATE OR REPLACE FUNCTION prevent_terminal_deferral_recognition_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('EXECUTED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'deferral_recognitions is immutable once %: DELETE is not permitted (id=%)', OLD.status, OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status IN ('EXECUTED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'deferral_recognitions is immutable once %: no column may change (id=%)', OLD.status, OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deferral_recognitions_terminal_immutable ON deferral_recognitions;
CREATE TRIGGER deferral_recognitions_terminal_immutable
  BEFORE UPDATE OR DELETE ON deferral_recognitions
  FOR EACH ROW EXECUTE FUNCTION prevent_terminal_deferral_recognition_mutation();
