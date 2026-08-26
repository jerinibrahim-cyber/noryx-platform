-- Posted-invoice immutability, narrow-exception style — mirrors
-- 005_supplier_bills_immutability_trigger.sql's narrowly-validated
-- pattern rather than merely "present". The ONLY legitimate mutation of
-- a POSTED customer_invoices row is paid_minor/payment_status, changed
-- by a later AR Work Item's future receipt-allocation posting — with
-- EVERY other column unchanged (including updated_at — no column is
-- exempted).
-- docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §4.
--
-- AR-1b itself never exercises this exception (no code path in this
-- Work Item writes anything but 0/UNPAID — see the
-- customer_invoices_paid_minor_zero_until_ar1c CHECK constraint in
-- schema.ts's migration). The exception exists now because paid_minor/
-- payment_status are structural to this table's design (the whole
-- reason they exist on this row), not because AR-1b uses it — matching
-- 005_supplier_bills_immutability_trigger.sql's own identical posture.

CREATE OR REPLACE FUNCTION prevent_posted_customer_invoice_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'customer_invoices is immutable once POSTED: DELETE is not permitted (id=%)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'POSTED' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.internal_reference IS DISTINCT FROM OLD.internal_reference
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
       OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    THEN
      RAISE EXCEPTION 'customer_invoices is immutable once POSTED: only paid_minor/payment_status may change, no other column (including updated_at) may change (id=%)', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_invoices_immutable ON customer_invoices;
CREATE TRIGGER customer_invoices_immutable
  BEFORE UPDATE OR DELETE ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_customer_invoice_mutation();
