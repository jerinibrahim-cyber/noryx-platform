-- Row-Level Security policies for AR-1c's three new tables
-- (ar_receipt_number_counters, customer_receipts,
-- customer_receipt_allocations) —
-- docs/finance-work-item-1c-customer-receipts-proposal.md §16.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql .. 007_ar_invoices_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as every other Finance table's own
-- doc comments: a legal entity is always a child of one
-- already-RLS-isolated tenant, so legal-entity scoping is enforced
-- explicitly in the service layer instead (CustomerReceiptsService).
-- Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4), same as every RLS file since 003_ap_rls.sql — this file
-- has no gap to repeat.

ALTER TABLE ar_receipt_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_receipt_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ar_receipt_number_counters;
CREATE POLICY tenant_isolation ON ar_receipt_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE customer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_receipts;
CREATE POLICY tenant_isolation ON customer_receipts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE customer_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_receipt_allocations;
CREATE POLICY tenant_isolation ON customer_receipt_allocations
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
