-- customer_receipt_allocations has no legitimate mutation once its
-- parent customer_receipts is POSTED — no exceptions at all. Mirrors
-- 008_supplier_payment_allocations_immutability_trigger.sql exactly,
-- joined to the parent receipt's status instead of a payment's.
-- docs/finance-work-item-1c-customer-receipts-proposal.md §16. Blocks
-- INSERT as well as UPDATE/DELETE — appending a new allocation to an
-- already-posted receipt would be just as much a rewrite of history as
-- editing an existing one. This also means CustomerReceiptsService.post()
-- must never attempt to insert a new allocation row after flipping the
-- parent receipt to POSTED — it doesn't: allocations are inserted at
-- DRAFT create/edit time only, exactly like customer_invoice_lines.

CREATE OR REPLACE FUNCTION prevent_posted_customer_receipt_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_receipt_id uuid;
  parent_status customer_receipt_status;
BEGIN
  target_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);

  SELECT status INTO parent_status FROM customer_receipts WHERE id = target_receipt_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations is immutable once its parent customer_receipts is POSTED: % is not permitted (receipt_id=%)',
      TG_OP, target_receipt_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_receipt_allocations_immutable ON customer_receipt_allocations;
CREATE TRIGGER customer_receipt_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_receipt_allocation_mutation();
