-- Generic Deferral Recognition Engine — Phase 2 Implementation Contract
-- (docs/work-items/deferral-recognition-engine/CONTRACT.md §1/§3), the
-- aggregate invariant backstop: Σ(deferral_recognitions.amount_minor)
-- for a schedule must always equal that schedule's
-- deferral_schedules.total_amount_minor. amount_minor never changes
-- after a deferral_recognitions row is created (only status/execution
-- fields do — see 029's terminal-immutability trigger and this table's
-- CHECK constraint), so this is a structural backstop against a bug
-- that inserts/updates/deletes occurrence rows in a way that leaves the
-- schedule's sum wrong — never an ongoing "remaining balance" check.
--
-- Same DEFERRABLE INITIALLY DEFERRED constraint-trigger pattern as
-- 002_balance_invariant_trigger.sql's journal-balance backstop:
-- deferred means it fires once at end-of-transaction against the FINAL
-- state of all of a schedule's occurrence rows, not at each individual
-- statement — this is what makes it safe for DeferralRecognitionService
-- to insert N occurrence rows one at a time inside the same
-- create-schedule transaction (CONTRACT.md §4) without an intermediate,
-- momentarily-unreconciled state ever being rejected.

CREATE OR REPLACE FUNCTION assert_deferral_schedule_reconciled(p_schedule_id uuid)
RETURNS void AS $$
DECLARE
  v_total_amount_minor integer;
  v_sum_amount_minor bigint;
BEGIN
  SELECT total_amount_minor INTO v_total_amount_minor
    FROM deferral_schedules WHERE id = p_schedule_id;

  -- The schedule itself may have been deleted in the same transaction
  -- (not a supported mutation path, but nothing left to reconcile
  -- against if it happened) — nothing to check.
  IF v_total_amount_minor IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum_amount_minor
    FROM deferral_recognitions
    WHERE schedule_id = p_schedule_id;

  IF v_sum_amount_minor <> v_total_amount_minor THEN
    RAISE EXCEPTION 'deferral_schedules % is not reconciled: recognitions sum=% total_amount_minor=%',
      p_schedule_id, v_sum_amount_minor, v_total_amount_minor;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_deferral_recognitions_reconciled() RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_deferral_schedule_reconciled(COALESCE(NEW.schedule_id, OLD.schedule_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deferral_recognitions_reconciled_check ON deferral_recognitions;
CREATE CONSTRAINT TRIGGER deferral_recognitions_reconciled_check
  AFTER INSERT OR UPDATE OR DELETE ON deferral_recognitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_deferral_recognitions_reconciled();
