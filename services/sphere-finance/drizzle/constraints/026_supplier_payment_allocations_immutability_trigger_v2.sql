-- On-Account (Unapplied) Supplier Payments & Customer Receipts work item
-- (docs/finance-work-item-on-account-payments-proposal.md §15.3, CTO
-- Architecture Gate, approved implementation authorization). Supersedes
-- 008_supplier_payment_allocations_immutability_trigger.sql's INSERT
-- behavior: the original trigger rejected ANY write (INSERT/UPDATE/
-- DELETE) once the parent payment was POSTED, and otherwise permitted
-- it freely pre-POSTED (DRAFT). INSERT is now ALSO permitted against a
-- POSTED, not-reversed parent — this is exactly what
-- SupplierPaymentsService.applyAllocation() needs (§9.1).
--
-- CTO remediation runtime-verification correction (NORYX SPHERE final
-- runtime quality gate), TWO rounds:
--
-- Round 1 — §19.2 item 3's own checklist text (proposal lines 892-893)
-- states "INSERT against a DRAFT parent -> raises the trigger's own
-- exception" — as literally coded here, that made it IMPOSSIBLE to ever
-- create/update a payment with allocations specified up front, because
-- supplier-payments.service.ts's create()/update() (§3.2's own
-- documented, explicitly-unchanged "Lifecycle today": `create() ->
-- INSERT header (status DRAFT, default) + INSERT allocation rows`,
-- `update() -> ... allocations full-array-replaced`) insert allocation
-- rows into THIS table while the parent payment is still DRAFT, in the
-- very same transaction. First caught only by actually running the
-- on-account AP/AR e2e suites against a real Postgres instance (Table
-- 19.1 scenarios #2/#3/#8/#9 and effectively every scenario using
-- `createAndPostPayment()` with a non-empty allocations array — a 500 on
-- the very first POST /payments call, 39 of 46 AP e2e tests failing
-- outright before this fix). Corrected to ALSO permit INSERT against a
-- DRAFT parent, restoring create()/update()'s pre-existing,
-- proposal-preserved behavior.
--
-- Round 2 — an earlier version of this round's own fix additionally made
-- UPDATE and DELETE unconditionally forbidden at every parent status
-- (including DRAFT), reasoning from proposal line 1000's "reject UPDATE/
-- DELETE unconditionally" summary phrase. That broke the pre-existing,
-- unrelated (Milestone 3.1) DRAFT-payment CRUD flows —
-- SupplierPaymentsService.remove()'s FK-cascade delete of a DRAFT
-- payment's own allocation rows, and update()'s full-array
-- delete-then-reinsert on a DRAFT payment's allocations — both issue a
-- raw DELETE against this table for a DRAFT (not POSTED) parent, which
-- the unconditional version rejected with a 500. First caught only by
-- actually running the FULL existing e2e regression suite (item 9 of
-- the runtime quality gate) against real Postgres:
-- supplier-payments.e2e-spec.ts's pre-existing "delete: DRAFT only,
-- allocations cascade" and "edit: header-only PATCH... full-array
-- allocation replacement" tests, which predate this work item, both
-- 500'd. §19.2 item 3's own raw-SQL verification (items 4/5, this same
-- file's sibling on-account-allocation.e2e-spec.ts) only ever exercises
-- UPDATE/DELETE against a POSTED parent — proposal line 1000's
-- "unconditionally" was never actually exercised against a DRAFT parent
-- by any test, and the ORIGINAL 008 trigger (read directly, not
-- inferred) conditions its own single combined UPDATE/DELETE/INSERT
-- check on `parent_status = 'POSTED'` — i.e. v1 never forbade
-- UPDATE/DELETE against a DRAFT parent either. Corrected back to that
-- same, provably-original condition for UPDATE/DELETE (forbidden only
-- once POSTED, permitted pre-POSTED) — this still satisfies items 4/5
-- exactly as tested (both POSTED-parent cases), and does not weaken any
-- invariant items 4/5 actually verify; it only removes an
-- over-literal DRAFT-status restriction that no approved-and-executed
-- test ever required and that broke unrelated, pre-existing
-- functionality. See the completion report's defects section for the
-- full analysis. Re-declares the SAME function name and the SAME
-- trigger name as 008 (CREATE OR REPLACE FUNCTION + DROP TRIGGER IF
-- EXISTS + CREATE TRIGGER, applied idempotently through the existing
-- apply-db-constraints.ts runner — no change to that runner itself), so
-- this file supersedes 008 in place rather than creating a second,
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

  SELECT status, journal_entry_id INTO parent_status, parent_journal_entry_id
    FROM supplier_payments WHERE id = target_payment_id;

  -- UPDATE and DELETE remain forbidden once the parent payment is
  -- POSTED — exactly the original 008 trigger's own guarantee for those
  -- two operations, restored (see Round 2 above). Permitted freely
  -- pre-POSTED (DRAFT), since nothing financially real has happened yet
  -- — this is what the pre-existing (Milestone 3.1, unrelated to this
  -- work item) DRAFT-payment edit/delete flows rely on.
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'supplier_payment_allocations is immutable once its parent supplier_payments is POSTED: % is not permitted (payment_id=%)',
      TG_OP, target_payment_id;
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
    RAISE EXCEPTION 'supplier_payment_allocations: a new allocation may only be inserted against a DRAFT or a POSTED, not-reversed supplier_payment (payment_id=%, status=%)',
      target_payment_id, parent_status;
  END IF;

  -- POSTED beyond this point — the new applyAllocation() capability
  -- (§9.1), but only when the payment's own journal entry has not been
  -- reversed.
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
