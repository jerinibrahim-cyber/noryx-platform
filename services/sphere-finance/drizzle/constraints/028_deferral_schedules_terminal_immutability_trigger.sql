-- Generic Deferral Recognition Engine — Phase 2 Implementation Contract
-- (docs/work-items/deferral-recognition-engine/CONTRACT.md §2). Once a
-- deferral_schedules row reaches either terminal status (COMPLETED,
-- CANCELLED), no column may ever change and the row may never be
-- deleted — direct copy of
-- 024_scheduled_reversals_immutability_trigger.sql's function, adapted
-- to this table's two-terminal-state shape (ACTIVE is the only
-- non-terminal status here, vs. scheduled_reversals' SCHEDULED).

CREATE OR REPLACE FUNCTION prevent_terminal_deferral_schedule_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
      RAISE EXCEPTION 'deferral_schedules is immutable once %: DELETE is not permitted (id=%)', OLD.status, OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'deferral_schedules is immutable once %: no column may change (id=%)', OLD.status, OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deferral_schedules_terminal_immutable ON deferral_schedules;
CREATE TRIGGER deferral_schedules_terminal_immutable
  BEFORE UPDATE OR DELETE ON deferral_schedules
  FOR EACH ROW EXECUTE FUNCTION prevent_terminal_deferral_schedule_mutation();
