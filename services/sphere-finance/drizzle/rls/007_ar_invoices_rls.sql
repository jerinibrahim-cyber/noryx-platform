-- Row-Level Security policies for AR-1b's three new tables
-- (ar_number_counters, customer_invoices, customer_invoice_lines) —
-- docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §4.
-- Applied after Drizzle's own migrations by src/db/apply-rls.ts, in
-- filename order (continues 001_enable_rls.sql .. 006_ar_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as chart_of_accounts/journal_entries/
-- suppliers/supplier_bills/customers (schema.ts's doc comments): a
-- legal entity is always a child of one already-RLS-isolated tenant,
-- so legal-entity scoping is enforced explicitly in the service layer
-- instead (CustomerInvoicesService). Session variable
-- app.current_tenant_id is set per-request via @noryx/db-core's
-- withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4), same as every RLS file since 003_ap_rls.sql — this file
-- has no gap to repeat.

ALTER TABLE ar_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_number_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ar_number_counters;
CREATE POLICY tenant_isolation ON ar_number_counters
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_invoices;
CREATE POLICY tenant_isolation ON customer_invoices
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE customer_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_invoice_lines;
CREATE POLICY tenant_isolation ON customer_invoice_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
