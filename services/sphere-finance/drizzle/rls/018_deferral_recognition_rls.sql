-- Generic Deferral Recognition Engine — Phase 2 Implementation Contract
-- (docs/work-items/deferral-recognition-engine/CONTRACT.md §1/§7).
-- Identical tenant_isolation pattern to every other Finance table,
-- quoted from 015_scheduled_reversals_rls.sql. legal_entity_id
-- isolation is NOT handled here — it is an explicit service-layer
-- predicate on every DeferralRecognitionService query, same convention
-- as everywhere else in this codebase.

ALTER TABLE deferral_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE deferral_schedules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON deferral_schedules;
CREATE POLICY tenant_isolation ON deferral_schedules
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE deferral_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deferral_recognitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON deferral_recognitions;
CREATE POLICY tenant_isolation ON deferral_recognitions
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
