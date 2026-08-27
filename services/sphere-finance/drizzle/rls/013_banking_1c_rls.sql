-- Banking-1c — Bank Statement Import & Bank Reconciliation RLS.
-- docs/finance-work-item-banking-1c-proposal.md §13, CTO-approved.
-- Identical tenant_isolation pattern to every other Finance table,
-- quoted from 012_bank_transactions_rls.sql. legal_entity_id isolation
-- is NOT handled here — it is an explicit service-layer predicate on
-- every BankStatementImportsService/BankReconciliationService query,
-- same convention as everywhere else in this codebase.

ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_imports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_statement_imports;
CREATE POLICY tenant_isolation ON bank_statement_imports
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_statement_lines;
CREATE POLICY tenant_isolation ON bank_statement_lines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE bank_reconciliation_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_matches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_reconciliation_matches;
CREATE POLICY tenant_isolation ON bank_reconciliation_matches
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
