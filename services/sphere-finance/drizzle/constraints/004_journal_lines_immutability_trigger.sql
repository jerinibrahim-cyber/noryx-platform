-- journal_lines has no legitimate mutation once its parent journal_entries
-- is POSTED — no exceptions at all (unlike journal_entries' one narrow
-- reversal-linkage exception). A reversal never touches an original
-- entry's lines; it only creates new ones on a new entry. This blocks
-- INSERT as well as UPDATE/DELETE — appending a new line to an
-- already-posted entry would be just as much a rewrite of history as
-- editing an existing one. docs/finance-journal-engine-proposal.md §3.

CREATE OR REPLACE FUNCTION prevent_posted_journal_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_entry_id uuid;
  parent_status journal_entry_status;
BEGIN
  target_entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT status INTO parent_status FROM journal_entries WHERE id = target_entry_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'journal_lines is immutable once its parent journal_entries is POSTED: % is not permitted (journal_entry_id=%)',
      TG_OP, target_entry_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;
CREATE TRIGGER journal_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_journal_line_mutation();
