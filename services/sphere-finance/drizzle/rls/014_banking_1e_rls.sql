-- Banking-1e — Payment Provider Settlement Import & Reconciliation RLS.
-- docs/finance-work-item-banking-1e-proposal.md §21, CTO-approved.
-- Identical tenant_isolation pattern to every other Finance table,
-- quoted from 013_banking_1c_rls.sql. legal_entity_id isolation is NOT
-- handled here — it is an explicit service-layer predicate on every
-- PaymentProviderSettlementsService query, same convention as
-- everywhere else in this codebase. bank_cash_accounts already has its
-- own RLS policy (011_bank_cash_accounts_rls.sql); the new `purpose`
-- column added to it by this work item requires no RLS change of its
-- own — RLS is row-scoped by tenant_id, not column-scoped.

ALTER TABLE payment_provider_settlement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_settlement_imports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payment_provider_settlement_imports;
CREATE POLICY tenant_isolation ON payment_provider_settlement_imports
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE payment_provider_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_settlements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payment_provider_settlements;
CREATE POLICY tenant_isolation ON payment_provider_settlements
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE payment_settlement_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_settlement_matches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payment_settlement_matches;
CREATE POLICY tenant_isolation ON payment_settlement_matches
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
