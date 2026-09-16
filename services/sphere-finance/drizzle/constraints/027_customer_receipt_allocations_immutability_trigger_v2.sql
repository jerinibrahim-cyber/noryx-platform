-- On-Account (Unapplied) Supplier Payments & Customer Receipts work item
-- (docs/finance-work-item-on-account-payments-proposal.md §15.3, CTO
-- Architecture Gate, approved implementation authorization). Supersedes
-- 012_customer_receipt_allocations_immutability_trigger.sql's INSERT
-- behavior — byte-mirror of
-- 026_supplier_payment_allocations_immutability_trigger_v2.sql for the
-- AR side (receipt_id/customer_receipt_status/customer_receipts in
-- place of payment_id/supplier_payment_status/supplier_payments). INSERT
-- is now permitted, but ONLY against a POSTED, not-reversed parent —
-- exactly what CustomerReceiptsService.applyAllocation() needs (§9.1).
-- UPDATE and DELETE remain unconditionally forbidden at every parent
-- status. Re-declares the SAME function name and the SAME trigger name
-- as 012 (idempotent, via the existing apply-db-constraints.ts runner),
-- so this file supersedes 012 in place rather than creating a second,
-- competing trigger.

CREATE OR REPLACE FUNCTION prevent_posted_customer_receipt_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_receipt_id uuid;
  parent_status customer_receipt_status;
  parent_journal_entry_id uuid;
  parent_reversed boolean;
BEGIN
  target_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);

  -- UPDATE and DELETE remain unconditionally forbidden at every parent
  -- status, unchanged from the original trigger's own guarantee for
  -- those two operations — only INSERT's condition changes.
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_receipt_allocations is immutable: % is never permitted on an existing row (receipt_id=%)',
      TG_OP, target_receipt_id;
  END IF;

  -- TG_OP = 'INSERT' beyond this point.
  SELECT status, journal_entry_id INTO parent_status, parent_journal_entry_id
    FROM customer_receipts WHERE id = target_receipt_id;

  IF parent_status IS DISTINCT FROM 'POSTED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations: a new allocation may only be inserted against a POSTED customer_receipt (receipt_id=%, status=%)',
      target_receipt_id, parent_status;
  END IF;

  SELECT (reversed_by_journal_entry_id IS NOT NULL) INTO parent_reversed
    FROM journal_entries WHERE id = parent_journal_entry_id;

  IF parent_reversed THEN
    RAISE EXCEPTION 'customer_receipt_allocations: a new allocation may not be inserted against a reversed customer_receipt (receipt_id=%)',
      target_receipt_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_receipt_allocations_immutable ON customer_receipt_allocations;
CREATE TRIGGER customer_receipt_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_receipt_allocation_mutation();
