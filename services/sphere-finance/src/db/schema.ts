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
 * Finance's own schema — deliberately just Chart of Accounts for Milestone
 * 1b. No journal entries, GL posting, WIP accrual, AP/AR; those are later
 * milestones. This file is what `drizzle-kit generate` (drizzle.config.ts)
 * reads, so it intentionally does NOT include @noryx/db-core's shared
 * tables (tenants, audit_logs, ...) — Finance must never generate
 * migrations for tables it doesn't own. See src/db/db.ts for how this
 * schema is combined with db-core's `auditLogs` table at the query-builder
 * level, without pulling audit_logs into Finance's own migration scope.
 *
 * No FK to db-core's `tenants` table: chart_of_accounts and tenants are
 * migrated independently by different services sharing one physical
 * Postgres instance, so a real foreign key across that boundary would
 * couple two services' migration lifecycles together — exactly what the
 * plug-and-play/module-independence principle rules out. tenantId is
 * validated at the application layer instead (it's always sourced from a
 * verified JWT claim, never raw user input).
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
    unique("chart_of_accounts_tenant_code_unique").on(t.tenantId, t.code),
    index("chart_of_accounts_tenant_id_idx").on(t.tenantId),
  ],
);

export type ChartOfAccount = typeof chartOfAccounts.$inferSelect;
export type NewChartOfAccount = typeof chartOfAccounts.$inferInsert;
