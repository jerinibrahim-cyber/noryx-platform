-- Posted-bank-transaction immutability, ZERO-exception style — same
-- posture as 007_supplier_payments_immutability_trigger.sql /
-- 011_customer_receipts_immutability_trigger.sql. No column on a POSTED
-- bank_transactions row may ever change. No future writer is known for
-- any column on this table within the current locked roadmap (no void/
-- unwind/correction workflow in Banking-1b or in Banking-1c's own design
-- — Banking-1c's matching state lives entirely on the future
-- bank_statement_lines side, never as a write against a POSTED
-- bank_transactions row itself — docs/finance-work-item-banking-1b-
-- proposal.md §12). Should a future work item need one, that migration
-- adds the narrow exception then, the same way AP-1b's own paid_minor/
-- payment_status exception was added ahead of its AP-1c consumer.

CREATE OR REPLACE FUNCTION prevent_posted_bank_transaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'bank_transactions is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'bank_transactions is immutable once POSTED: UPDATE is not permitted, no column may change (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_transactions_immutable ON bank_transactions;
CREATE TRIGGER bank_transactions_immutable
  BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_bank_transaction_mutation();
