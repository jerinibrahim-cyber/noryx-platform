-- Tax / VAT MVP — Phase 1 (CTO-approved architecture proposal + CTO
-- decision turn, Decision 6). Prevents two tax_rates rows for the same
-- (tenant, legal entity, tax code) from covering any overlapping date
-- range. A plain CHECK (tax_rates_end_after_start, already declared in
-- schema.ts) validates one row in isolation but cannot express a
-- cross-row exclusion — a real range-exclusion constraint is required,
-- which drizzle-orm's schema DSL has no builder for, hence this
-- hand-written file, applied the same way
-- drizzle/constraints/001_period_overlap_exclusion.sql is (see
-- apply-db-constraints.ts).
--
-- btree_gist is required so the GiST index backing this constraint can
-- also handle the plain equality columns (tenant_id, legal_entity_id,
-- tax_code_id) alongside the daterange overlap operator. Already
-- enabled by 001_period_overlap_exclusion.sql for accounting_periods —
-- `CREATE EXTENSION IF NOT EXISTS` here is idempotent and makes this
-- file independently re-runnable/self-sufficient rather than silently
-- depending on 001 having run first.
--
-- Range bound choice: '[)' (inclusive start, exclusive end) rather than
-- accounting_periods' '[]' (inclusive both ends) — deliberate, because
-- an open-ended tax_rates row stores effectiveTo = NULL, and
-- daterange(..., NULL, '[]') and daterange(..., NULL, '[)') both
-- normalize to an unbounded upper end in Postgres; '[)' is the
-- conventional choice for date ranges where a later, adjacent row's
-- effectiveFrom should NOT be treated as overlapping the prior row's
-- effectiveTo (a rate change effective exactly the day after another
-- ends is not an overlap).

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE tax_rates
  DROP CONSTRAINT IF EXISTS tax_rates_no_overlap;

ALTER TABLE tax_rates
  ADD CONSTRAINT tax_rates_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    legal_entity_id WITH =,
    tax_code_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );
