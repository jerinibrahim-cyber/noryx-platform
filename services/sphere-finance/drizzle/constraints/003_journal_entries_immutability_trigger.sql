-- Posted-entry immutability, narrowly validated rather than merely
-- present (per explicit review guidance): the ONLY legitimate mutation of
-- a POSTED journal_entries row is the one-time reversal linkage
-- transition reversed_by_journal_entry_id NULL -> a value, with EVERY
-- other column unchanged (including updated_at — no column is exempted)
-- and the row not already reversed. Everything else — any other field
-- change, a second attempt to set the reversal link, or any DELETE — is
-- rejected. A caller performing the legitimate reversal-link update must
-- write only reversed_by_journal_entry_id in that statement; it must not
-- also bump updated_at, since that column is checked like any other.
-- docs/finance-journal-engine-proposal.md §3, §9. Same append-only
-- pattern as packages/db-core/drizzle/rls/002_immutable_audit_log.sql,
-- extended with the one narrow, explicitly-checked exception this table
-- needs.

CREATE OR REPLACE FUNCTION prevent_posted_journal_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'journal_entries is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    IF OLD.reversed_by_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'journal_entries % is already reversed; reversed_by_journal_entry_id cannot be changed again', OLD.id;
    END IF;

    IF NEW.reversed_by_journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'journal_entries is immutable once POSTED: only setting reversed_by_journal_entry_id is permitted (id=%)', OLD.id;
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
       OR NEW.journal_number IS DISTINCT FROM OLD.journal_number
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
       OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.reversal_of_journal_entry_id IS DISTINCT FROM OLD.reversal_of_journal_entry_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    THEN
      RAISE EXCEPTION 'journal_entries is immutable once POSTED: only reversed_by_journal_entry_id may be set, no other column (including updated_at) may change (id=%)', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;
CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_journal_entry_mutation();
