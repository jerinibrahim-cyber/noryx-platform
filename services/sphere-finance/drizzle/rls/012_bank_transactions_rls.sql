-- Banking-1b — Bank Transactions RLS.
-- docs/finance-work-item-banking-1b-proposal.md §11, CTO-approved.
-- Identical tenant_isolation pattern to every other Finance table,
-- quoted from 011_bank_cash_accounts_rls.sql. legal_entity_id isolation
-- is NOT handled here — it is an explicit service-layer predicate on
-- every BankTransactionsService query, same convention as everywhere
-- else in this codebase.

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_transactions;
CREATE POLICY tenant_isolation ON bank_transactions
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
