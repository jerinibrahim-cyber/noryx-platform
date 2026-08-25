-- supplier_payment_allocations has no legitimate mutation once its
-- parent supplier_payments is POSTED — no exceptions at all. Mirrors
-- 006_supplier_bill_lines_immutability_trigger.sql exactly, joined to
-- the parent payment's status instead of a bill's.
-- docs/finance-work-item-1c-supplier-payments-proposal.md §10. Blocks
-- INSERT as well as UPDATE/DELETE — appending a new allocation to an
-- already-posted payment would be just as much a rewrite of history as
-- editing an existing one. This also means SupplierPaymentsService.post()
-- must never attempt to insert a new allocation row after flipping the
-- parent payment to POSTED — it doesn't: allocations are inserted at
-- DRAFT create/edit time only, exactly like supplier_bill_lines.

CREATE OR REPLACE FUNCTION prevent_posted_supplier_payment_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_payment_id uuid;
  parent_status supplier_payment_status;
BEGIN
  target_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT status INTO parent_status FROM supplier_payments WHERE id = target_payment_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_payment_allocations is immutable once its parent supplier_payments is POSTED: % is not permitted (payment_id=%)',
      TG_OP, target_payment_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_payment_allocations_immutable ON supplier_payment_allocations;
CREATE TRIGGER supplier_payment_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_supplier_payment_allocation_mutation();
