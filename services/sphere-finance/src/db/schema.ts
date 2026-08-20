import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

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
