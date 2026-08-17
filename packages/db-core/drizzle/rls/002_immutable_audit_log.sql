-- The Finance/security audit trail must be append-only at the data layer
-- (Pre-Development Readiness Review §7.7, System Architecture v1 §7): even a
-- fully compromised application account can only INSERT, never rewrite
-- history. This is enforced with a trigger, not application discipline.

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
