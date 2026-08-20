-- The fundamental double-entry invariant — SUM(debit) = SUM(credit) for
-- every POSTED journal entry — enforced at the database level as a
-- backstop, independent of AccountsService/JournalEntriesService's own
-- application-level check before the DRAFT -> POSTED transition.
-- docs/finance-journal-engine-proposal.md §3.
--
-- A per-row CHECK constraint cannot express a cross-row SUM, so this is a
-- pair of DEFERRABLE INITIALLY DEFERRED constraint triggers (same
-- append-only-style pattern as packages/db-core's
-- prevent_audit_log_mutation, generalized to a deferred aggregate check).
-- Deferred means it fires once at end-of-transaction against the FINAL
-- state of the row, not at each individual statement — this matters
-- because it is the only way to catch a transaction that, e.g., inserts
-- unbalanced lines while an entry is still DRAFT and only later in the
-- SAME transaction flips that entry to POSTED via a raw UPDATE that never
-- touches journal_lines at all. Attaching the check to BOTH tables closes
-- that gap: journal_lines changes and journal_entries status changes are
-- each independently sufficient to trigger a re-check at commit time.

CREATE OR REPLACE FUNCTION assert_journal_entry_balanced(p_entry_id uuid)
RETURNS void AS $$
DECLARE
  entry_status journal_entry_status;
  total_debit bigint;
  total_credit bigint;
  line_count integer;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = p_entry_id;

  -- The entry may have been deleted in the same transaction (a DRAFT
  -- entry's own delete cascades to its lines) — nothing left to check.
  IF entry_status IS NULL OR entry_status <> 'POSTED' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0), COUNT(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines
    WHERE journal_entry_id = p_entry_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal_entries % is POSTED but has fewer than 2 lines', p_entry_id;
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'journal_entries % is POSTED but unbalanced: debits=% credits=%',
      p_entry_id, total_debit, total_credit;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_journal_lines_balance() RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_journal_entry_balanced(COALESCE(NEW.journal_entry_id, OLD.journal_entry_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balance_check ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_lines_balance();

CREATE OR REPLACE FUNCTION check_journal_entries_balance() RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_journal_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_balance_check ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balance_check
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_entries_balance();
