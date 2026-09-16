-- On-Account (Unapplied) Supplier Payments & Customer Receipts work item
-- (docs/finance-work-item-on-account-payments-proposal.md §15.3, CTO
-- Architecture Gate, approved implementation authorization). Supersedes
-- 008_supplier_payment_allocations_immutability_trigger.sql's INSERT
-- behavior: the original trigger rejected ANY write (INSERT/UPDATE/
-- DELETE) once the parent payment was POSTED. INSERT is now permitted,
-- but ONLY against a POSTED, not-reversed parent — this is exactly what
-- SupplierPaymentsService.applyAllocation() needs (§9.1) and defends,
-- independently of the application layer, against any other write path
-- ever inserting an allocation against a DRAFT, not-yet-POSTED, or
-- already-reversed payment. UPDATE and DELETE remain unconditionally
-- forbidden at every parent status, unchanged from the original
-- trigger's own guarantee for those two operations — only INSERT's
-- condition changes. Re-declares the SAME function name and the SAME
-- trigger name as 008 (CREATE OR REPLACE FUNCTION + DROP TRIGGER IF
-- EXISTS + CREATE TRIGGER, applied idempotently through the existing
-- apply-db-constraints.ts runner — no change to that runner itself),
-- so this file supersedes 008 in place rather than creating a second,
-- competing trigger.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_payment_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_payment_id uuid;
  parent_status supplier_payment_status;
  parent_journal_entry_id uuid;
  parent_reversed boolean;
BEGIN
  target_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  -- UPDATE and DELETE remain unconditionally forbidden at every parent
  -- status, unchanged from the original trigger's own guarantee for
  -- those two operations (§3.5) — only INSERT's condition changes.
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_payment_allocations is immutable: % is never permitted on an existing row (payment_id=%)',
      TG_OP, target_payment_id;
  END IF;

  -- TG_OP = 'INSERT' beyond this point.
  SELECT status, journal_entry_id INTO parent_status, parent_journal_entry_id
    FROM supplier_payments WHERE id = target_payment_id;

  IF parent_status IS DISTINCT FROM 'POSTED' THEN
    RAISE EXCEPTION 'supplier_payment_allocations: a new allocation may only be inserted against a POSTED supplier_payment (payment_id=%, status=%)',
      target_payment_id, parent_status;
  END IF;

  SELECT (reversed_by_journal_entry_id IS NOT NULL) INTO parent_reversed
    FROM journal_entries WHERE id = parent_journal_entry_id;

  IF parent_reversed THEN
    RAISE EXCEPTION 'supplier_payment_allocations: a new allocation may not be inserted against a reversed supplier_payment (payment_id=%)',
      target_payment_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_payment_allocations_immutable ON supplier_payment_allocations;
CREATE TRIGGER supplier_payment_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_payment_allocation_mutation();
