-- Prevents two accounting_periods rows for the same (tenant, legal entity)
-- from covering any overlapping date range, regardless of `code`.
-- docs/finance-journal-engine-proposal.md §5. A plain UNIQUE constraint on
-- `code` (already declared in schema.ts) cannot express this — a real
-- range-exclusion constraint is required, which drizzle-orm's schema DSL
-- has no builder for, hence this hand-written file, applied the same way
-- drizzle/rls/*.sql is (see apply-db-constraints.ts).
--
-- btree_gist is required so the GiST index backing this constraint can
-- also handle the plain equality columns (tenant_id, legal_entity_id)
-- alongside the daterange overlap operator.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE accounting_periods
  DROP CONSTRAINT IF EXISTS accounting_periods_no_overlap;

ALTER TABLE accounting_periods
  ADD CONSTRAINT accounting_periods_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    legal_entity_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );
