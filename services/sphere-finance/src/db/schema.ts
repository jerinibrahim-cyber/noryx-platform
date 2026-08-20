import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  date,
  bigint,
  integer,
  index,
  unique,
  check,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Finance's own schema. This file is what `drizzle-kit generate`
 * (drizzle.config.ts) reads, so it intentionally does NOT include
 * @noryx/db-core's shared tables (tenants, legal_entities, audit_logs,
 * ...) — Finance must never generate migrations for tables it doesn't
 * own. See src/db/db.ts for how this schema is combined with db-core's
 * `auditLogs` table at the query-builder level, without pulling
 * audit_logs into Finance's own migration scope.
 *
 * No FK to db-core's `tenants`/`legal_entities` tables: chart_of_accounts
 * and those tables are migrated independently by different services
 * sharing one physical Postgres instance, so a real foreign key across
 * that boundary would couple two services' migration lifecycles together
 * — exactly what the plug-and-play/module-independence principle rules
 * out. tenantId/legalEntityId are validated at the application layer
 * instead (always sourced from a verified JWT claim, never raw user
 * input).
 *
 * chart_of_accounts is scoped by (tenant_id, legal_entity_id) — the 2a
 * retrofit (docs/finance-journal-engine-proposal.md §1.1/§1.2). RLS
 * remains tenant_id-only, a deliberate decision documented there: a
 * legal entity is always a child of exactly one already-RLS-isolated
 * tenant, so cross-legal-entity leakage within one tenant is a
 * data-correctness concern, not the cross-customer breach RLS exists to
 * prevent. legal_entity_id isolation is enforced explicitly in every
 * service-layer query instead — see AccountsService — and proven by the
 * cross-legal-entity tests in accounts.e2e-spec.ts. Do not "simplify"
 * this by dropping the legal_entity_id predicate from queries; RLS alone
 * does not cover it.
 */
export const accountTypeEnum = pgEnum("account_type", [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);

export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /// Added nullable in migration 0001, backfilled from each tenant's
    /// default legal entity (scripts/backfill-legal-entity-id.ts), then
    /// tightened to NOT NULL here in migration 0002 — see
    /// docs/finance-journal-engine-proposal.md §1.2 for the full
    /// three-step retrofit sequence.
    legalEntityId: uuid("legal_entity_id").notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    type: accountTypeEnum("type").notNull(),
    /// Self-referential hierarchy (e.g. "1000 Assets" -> "1010 Cash"). Not a
    /// Postgres FK to itself, for the same cross-boundary reasoning as
    /// tenantId above is moot here (same table) — kept as a plain nullable
    /// uuid and validated in AccountsService instead, so a bad parentId is a
    /// clean 400 rather than a raw constraint-violation error leaking to
    /// the client.
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("chart_of_accounts_tenant_entity_code_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.code,
    ),
    index("chart_of_accounts_tenant_entity_idx").on(
      t.tenantId,
      t.legalEntityId,
    ),
  ],
);

export type ChartOfAccount = typeof chartOfAccounts.$inferSelect;
export type NewChartOfAccount = typeof chartOfAccounts.$inferInsert;

// ---------------------------------------------------------------------------
// Journal Engine — increment 2b (schema/DB layer only; no service/API yet).
// docs/finance-journal-engine-proposal.md §1.3-§1.8, §3, §5.
//
// FK policy distinction from chart_of_accounts above, per explicit review
// guidance after 2a: the no-FK/app-validated pattern applies specifically
// to references that cross a SERVICE boundary (tenantId/legalEntityId,
// owned by db-core). Within Finance's own schema — journal_entries ->
// accounting_periods, journal_lines -> journal_entries, journal_lines ->
// chart_of_accounts, journal_entries -> journal_entries (reversal link) —
// all four tables share one migration lifecycle, so real Postgres foreign
// keys are used and are the correct choice, not a shortcut. Likewise the
// accounting invariants below (balance, immutability, numbering
// uniqueness, period-overlap) are enforced by constraints/triggers, not
// application code alone — see drizzle/constraints/ and
// apply-db-constraints.ts, applied the same way drizzle/rls/ is.
// ---------------------------------------------------------------------------

export const accountingPeriodStatusEnum = pgEnum("accounting_period_status", [
  "OPEN",
  "CLOSED",
]);

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: accountingPeriodStatusEnum("status").notNull().default("OPEN"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("accounting_periods_tenant_entity_code_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.code,
    ),
    index("accounting_periods_tenant_entity_idx").on(
      t.tenantId,
      t.legalEntityId,
    ),
    check(
      "accounting_periods_end_after_start",
      sql`${t.endDate} > ${t.startDate}`,
    ),
    // Overlap prevention (no two periods for the same tenant+legal entity
    // may cover the same date) requires a GiST EXCLUDE constraint, which
    // drizzle-orm's schema DSL has no builder for — added as raw SQL in
    // drizzle/constraints/001_period_overlap_exclusion.sql, applied by
    // apply-db-constraints.ts. See that file for the exact constraint.
  ],
);

export type AccountingPeriod = typeof accountingPeriods.$inferSelect;
export type NewAccountingPeriod = typeof accountingPeriods.$inferInsert;

/// Race-free journal-number allocation (docs/finance-journal-engine-proposal.md
/// §1.4/§3 step 7) — one row per (tenant, legal entity), incremented via a
/// single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the
/// same transaction as the rest of a posting, never `MAX(journal_number)+1`.
export const journalNumberCounters = pgTable(
  "journal_number_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    lastAssignedNumber: integer("last_assigned_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.legalEntityId] })],
);

export type JournalNumberCounter = typeof journalNumberCounters.$inferSelect;

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "DRAFT",
  "POSTED",
]);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /// Null while DRAFT — assigned only at posting time via
    /// journalNumberCounters (§3 step 7). Never MAX()+1.
    journalNumber: varchar("journal_number", { length: 20 }),
    status: journalEntryStatusEnum("status").notNull().default("DRAFT"),
    transactionDate: date("transaction_date").notNull(),
    /// Resolved from transactionDate at posting time — never
    /// client-supplied. Real FK: accounting_periods is Finance's own
    /// table, same migration lifecycle.
    periodId: uuid("period_id").references(() => accountingPeriods.id),
    /// Fixed to the legal entity's functional currency at creation in this
    /// increment (no FX). See schema doc comment above and
    /// docs/finance-journal-engine-proposal.md §1.6 for the stated
    /// multi-currency extension point — additive columns only, no rename.
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    memo: text("memo"),
    /// Reversal linkage — both self-referential FKs, both nullable.
    /// reversedByJournalEntryId can only transition NULL -> a value, and
    /// only in isolation from every other posted-entry field (including
    /// updatedAt — the trigger checks it column-by-column, not just that
    /// reversed_by_journal_entry_id is present), enforced by the
    /// immutability trigger (drizzle/constraints/003_..., §3, §9), not
    /// just application code.
    ///
    /// 2b/2c boundary (explicit, not to be left ambiguous): what 2b's
    /// database layer guarantees for these two columns is (a) the target
    /// id exists in journal_entries (plain FK), (b) reversedByJournalEntryId
    /// can only move NULL -> a value exactly once, and (c) every other
    /// column on the row is frozen once POSTED. The database does NOT
    /// verify, and 2b does not claim, that the linked row is actually a
    /// legitimate reversal: same tenant, same legal entity, target status
    /// is POSTED, target is actually the entry this one reverses (or vice
    /// versa), target is not itself a reversal (no chained reversals), or
    /// target != this row's own id. All of that is application-layer
    /// business validation, deferred to 2c (the journal entry service),
    /// which must have an adversarial test for every one of those cases
    /// before reversal posting ships. Same boundary applies to
    /// accountId below: the FK only proves the account row exists, not
    /// that it belongs to this entry's tenant/legal entity — 2c's posting
    /// logic must never allow a journal in one legal entity to reference
    /// an account belonging to a different legal entity of the same
    /// tenant (tenant RLS alone will not catch that) or a different
    /// tenant entirely.
    reversalOfJournalEntryId: uuid("reversal_of_journal_entry_id"),
    reversedByJournalEntryId: uuid("reversed_by_journal_entry_id"),
    createdBy: uuid("created_by"),
    postedBy: uuid("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // NULL is distinct from NULL under a standard Postgres UNIQUE
    // constraint, so this permits unlimited DRAFT rows (journalNumber
    // null) while still guaranteeing no two POSTED entries in the same
    // legal entity ever share a journal_number — a second, independent
    // guarantee on top of the counter table's own atomicity.
    unique("journal_entries_tenant_entity_number_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.journalNumber,
    ),
    index("journal_entries_tenant_entity_idx").on(t.tenantId, t.legalEntityId),
    index("journal_entries_period_idx").on(t.periodId),
    foreignKey({
      columns: [t.reversalOfJournalEntryId],
      foreignColumns: [t.id],
      name: "journal_entries_reversal_of_fk",
    }),
    foreignKey({
      columns: [t.reversedByJournalEntryId],
      foreignColumns: [t.id],
      name: "journal_entries_reversed_by_fk",
    }),
  ],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /// Denormalized from the parent entry — required for journal_lines'
    /// own tenant_isolation RLS policy (a policy is per-table; it cannot
    /// reach through a join to journal_entries).
    tenantId: uuid("tenant_id").notNull(),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    /// Real FK: chart_of_accounts is Finance's own table, same migration
    /// lifecycle — unlike tenantId/legalEntityId's cross-service
    /// reasoning, this in-service reference should be, and is, enforced
    /// by Postgres.
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    debitMinor: bigint("debit_minor", { mode: "number" }).notNull().default(0),
    creditMinor: bigint("credit_minor", { mode: "number" })
      .notNull()
      .default(0),
    description: varchar("description", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Composite UNIQUE, not a plain index: guarantees at the database
    // level that no journal entry has two lines sharing a line_number.
    // The same line_number is still valid across two different journal
    // entries (the constraint is scoped per journalEntryId).
    unique("journal_lines_entry_line_number_unique").on(
      t.journalEntryId,
      t.lineNumber,
    ),
    index("journal_lines_account_idx").on(t.accountId),
    check(
      "journal_lines_amounts_non_negative",
      sql`${t.debitMinor} >= 0 AND ${t.creditMinor} >= 0`,
    ),
    check(
      "journal_lines_single_sided",
      sql`NOT (${t.debitMinor} > 0 AND ${t.creditMinor} > 0)`,
    ),
    // Reject meaningless zero/zero lines — a line must move value on at
    // least one side. Combined with the single-sided check above, every
    // line is either debit-only (credit = 0, debit > 0) or credit-only
    // (debit = 0, credit > 0).
    check(
      "journal_lines_nonzero",
      sql`${t.debitMinor} > 0 OR ${t.creditMinor} > 0`,
    ),
    // The cross-row balance invariant (SUM(debit) = SUM(credit) per
    // POSTED journal_entries) and posted-row immutability cannot be
    // expressed as a per-row CHECK constraint — both are triggers in
    // drizzle/constraints/, applied by apply-db-constraints.ts. See §3.
  ],
);

export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
