-- Row-Level Security policies for Tax / VAT MVP Phase 1's two new
-- tables (tax_codes, tax_rates) — CTO-approved architecture proposal +
-- CTO decision turn. Applied after Drizzle's own migrations by
-- src/db/apply-rls.ts, in filename order (continues
-- 001_enable_rls.sql .. 015_scheduled_reversals_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation, includes the "= ''" null/empty-tenant bypass
-- fix from day one (003_null_tenant_bypass_fix.sql's correction, same
-- posture 015_scheduled_reversals_rls.sql already takes). legal_entity_id
-- is deliberately NOT part of RLS here, same documented reasoning as
-- chart_of_accounts/suppliers/accounting_periods (schema.ts's doc
-- comment on chart_of_accounts): a legal entity is always a child of
-- exactly one already-RLS-isolated tenant, so legal-entity scoping is
-- enforced explicitly in the service layer instead (TaxCodesService,
-- TaxRatesService), never dropped from a query even though RLS alone
-- would still stop cross-tenant leakage.

ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tax_codes;
CREATE POLICY tenant_isolation ON tax_codes
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tax_rates;
CREATE POLICY tenant_isolation ON tax_rates
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
