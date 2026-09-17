-- On-Account (Unapplied) Supplier Payments & Customer Receipts work item
-- (docs/finance-work-item-on-account-payments-proposal.md §15.3, CTO
-- Architecture Gate, approved implementation authorization). Supersedes
-- 012_customer_receipt_allocations_immutability_trigger.sql's INSERT
-- behavior — byte-mirror of
-- 026_supplier_payment_allocations_immutability_trigger_v2.sql for the
-- AR side (receipt_id/customer_receipt_status/customer_receipts in
-- place of payment_id/supplier_payment_status/supplier_payments). INSERT
-- is now ALSO permitted against a POSTED, not-reversed parent — exactly
-- what CustomerReceiptsService.applyAllocation() needs (§9.1).
--
-- CTO remediation runtime-verification correction (NORYX SPHERE final
-- runtime quality gate), TWO rounds — byte-mirror of 026's own fix; see
-- that file's comment for the full analysis:
--
-- Round 1 — as originally coded here, ANY INSERT against a DRAFT parent
-- was rejected, which made it impossible for CustomerReceiptsService's
-- create()/update() (§3.2's own documented, explicitly-unchanged
-- "Lifecycle today") to ever insert allocation rows while the parent
-- receipt is still DRAFT, in the very same transaction — caught only by
-- actually running the on-account AR e2e suite against a real Postgres
-- instance. Corrected to ALSO permit INSERT against a DRAFT parent.
--
-- Round 2 — an earlier version of this round's own fix additionally made
-- UPDATE and DELETE unconditionally forbidden at every parent status
-- (including DRAFT), which broke the pre-existing, unrelated
-- (Milestone 3.1) DRAFT-receipt CRUD flows —
-- CustomerReceiptsService.remove()'s FK-cascade delete of a DRAFT
-- receipt's own allocation rows, and update()'s full-array
-- delete-then-reinsert on a DRAFT receipt's allocations. First caught
-- only by actually running the FULL existing e2e regression suite
-- against real Postgres: customer-receipts.e2e-spec.ts's pre-existing
-- "delete: DRAFT only, allocations cascade" and "edit: header-only
-- PATCH... full-array allocation replacement" tests, which predate this
-- work item, both 500'd. The ORIGINAL 012 trigger (byte-identical
-- structure to 008) conditions its own single combined
-- UPDATE/DELETE/INSERT check on `parent_status = 'POSTED'` — i.e. v1
-- never forbade UPDATE/DELETE against a DRAFT parent. Corrected back to
-- that same, provably-original condition for UPDATE/DELETE (forbidden
-- only once POSTED, permitted pre-POSTED) — still satisfies §19.2 item
-- 3's own raw-SQL verification (item 4/5, both tested only against a
-- POSTED parent) exactly as tested.
--
-- Both invariants §19.2 item 3 actually depends on remain fully intact:
-- UPDATE/DELETE forbidden once POSTED, and a POSTED-and-reversed parent
-- still rejects INSERT. Re-declares the SAME function name and the SAME
-- trigger name as 012 (idempotent, via the existing
-- apply-db-constraints.ts runner), so this file supersedes 012 in place
-- rather than creating a second, competing trigger.

CREATE OR REPLACE FUNCTION prevent_posted_customer_receipt_allocation_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_receipt_id uuid;
  parent_status customer_receipt_status;
  parent_journal_entry_id uuid;
  parent_reversed boolean;
BEGIN
  target_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);

  SELECT status, journal_entry_id INTO parent_status, parent_journal_entry_id
    FROM customer_receipts WHERE id = target_receipt_id;

  -- UPDATE and DELETE remain forbidden once the parent receipt is
  -- POSTED — exactly the original 012 trigger's own guarantee for those
  -- two operations, restored (see Round 2 above). Permitted freely
  -- pre-POSTED (DRAFT), since nothing financially real has happened yet
  -- — this is what the pre-existing (Milestone 3.1, unrelated to this
  -- work item) DRAFT-receipt edit/delete flows rely on.
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations is immutable once its parent customer_receipts is POSTED: % is not permitted (receipt_id=%)',
      TG_OP, target_receipt_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT' beyond this point.

  -- DRAFT: create()/update()'s own same-transaction allocation insert —
  -- always permitted, unchanged from the pre-on-account trigger's own
  -- behavior for this case.
  IF parent_status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  -- Anything other than DRAFT or POSTED (i.e. no matching parent row at
  -- all — parent_status is NULL) is rejected, same as before.
  IF parent_status IS DISTINCT FROM 'POSTED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations: a new allocation may only be inserted against a DRAFT or a POSTED, not-reversed customer_receipt (receipt_id=%, status=%)',
      target_receipt_id, parent_status;
  END IF;

  -- POSTED beyond this point — the new applyAllocation() capability
  -- (§9.1), but only when the receipt's own journal entry has not been
  -- reversed.
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
