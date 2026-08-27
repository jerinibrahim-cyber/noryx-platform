-- Row-Level Security policy for Banking-1a's new table
-- (bank_cash_accounts) — docs/finance-work-item-banking-cash-management-
-- proposal.md §8.1/§12, CTO-approved (Banking-1a scope only). Applied
-- after Drizzle's own migrations by src/db/apply-rls.ts, in filename
-- order (continues 001_enable_rls.sql .. 010_ap_debit_notes_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation. legal_entity_id is deliberately NOT part of
-- RLS here, same stated reasoning as every other Finance table's own
-- doc comments: a legal entity is always a child of one
-- already-RLS-isolated tenant, so legal-entity scoping is enforced
-- explicitly in the service layer instead (BankCashAccountsService).
-- Session variable app.current_tenant_id is set per-request via
-- @noryx/db-core's withTenantScoped().
--
-- Includes the "= ''" bypass-fix branch from day one (Milestone 3.1
-- §1.4/§2.4), same as every RLS file since 003_ap_rls.sql — this file
-- has no gap to repeat.

ALTER TABLE bank_cash_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_cash_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_cash_accounts;
CREATE POLICY tenant_isolation ON bank_cash_accounts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
