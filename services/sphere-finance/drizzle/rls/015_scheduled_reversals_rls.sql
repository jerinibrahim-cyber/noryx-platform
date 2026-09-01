-- Scheduled Reversal for Accruals and Other Timing Adjustments — Final
-- Implementation Specification (Revision 2), §15. Identical
-- tenant_isolation pattern to every other Finance table, quoted from
-- 014_banking_1e_rls.sql. legal_entity_id isolation is NOT handled here
-- — it is an explicit service-layer predicate on every
-- ScheduledReversalsService query and inside JournalEntriesService's
-- reused reversal-locking logic, same convention as everywhere else in
-- this codebase.

ALTER TABLE scheduled_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reversals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON scheduled_reversals;
CREATE POLICY tenant_isolation ON scheduled_reversals
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
