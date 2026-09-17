-- Row-Level Security policies for Budgeting / Planning Phase 1
-- Foundation's two new tables (budgets, budget_lines) — CTO-approved
-- implementation authorization (v6),
-- docs/work-items/budgeting-phase-1-foundation/CONTRACT.md §9. Applied
-- after Drizzle's own migrations by src/db/apply-rls.ts, in filename
-- order (continues 001_enable_rls.sql .. 016_tax_configuration_rls.sql).
--
-- Same tenant-isolation mechanism as every other Finance table — no
-- second implementation, includes the "= ''" null/empty-tenant bypass
-- fix from day one (003_null_tenant_bypass_fix.sql's correction, same
-- posture 016_tax_configuration_rls.sql already takes). legal_entity_id
-- is deliberately NOT part of RLS here, same documented reasoning as
-- chart_of_accounts/tax_codes/accounting_periods (schema.ts's doc
-- comment on chart_of_accounts): a legal entity is always a child of
-- exactly one already-RLS-isolated tenant, so legal-entity scoping is
-- enforced explicitly in the service layer instead (BudgetsService,
-- BudgetLinesService), never dropped from a query even though RLS alone
-- would still stop cross-tenant leakage.

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budgets;
CREATE POLICY tenant_isolation ON budgets
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_lines;
CREATE POLICY tenant_isolation ON budget_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
