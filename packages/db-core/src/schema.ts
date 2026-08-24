// Noryx Platform — shared Postgres schema (Drizzle ORM).
//
// Tenancy model (System Architecture v1 §3): a single shared database,
// shared schema. Every tenant-scoped table carries tenant_id (and, where
// relevant, legal_entity_id) and is protected by a Postgres Row-Level
// Security policy applied via drizzle/rls/*.sql (see src/apply-rls.ts) —
// Drizzle migrations own table shape, RLS SQL owns the isolation policy.
//
// Domain modules (Party, Contract, Finance, Procurement, HRMS, CRM, Orbis
// work orders, etc.) are NOT modeled here — those belong to their owning
// service's Phase 1+ schema additions. This file holds only the Phase 0
// foundation every later module depends on: Tenant, Legal Entity, Identity,
// Subscription & Entitlement, and the immutable Audit Log.
//
// ORM note: Prisma was the original choice here but its CLI requires
// downloading a native engine binary from a Prisma-controlled CDN on every
// `generate`/`migrate`/even `validate` call — a hard dependency that some
// restricted network environments (this one included) can't reach at all.
// Drizzle has no binary engine — it's pure TypeScript over the `postgres`
// driver — so schema, migrations, and queries all work identically
// everywhere, which matters more than any feature Prisma has over it here.

import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  char,
  integer,
  boolean,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Subscription state machine (chat decision on non-payment handling):
/// ACTIVE -> PAST_DUE (grace period, full access) -> SUSPENDED (read-only)
/// -> TERMINATED. Reused for both Tenant.status and Subscription.status —
/// they move together in practice.
export const tenantStatusEnum = pgEnum("tenant_status", [
  "ACTIVE",
  "PAST_DUE",
  "SUSPENDED",
  "TERMINATED",
]);

/// The three identity tiers from System Architecture v1 §3.2.
export const userTierEnum = pgEnum("user_tier", [
  "PLATFORM_OPERATOR",
  "TENANT_INTERNAL",
  "TENANT_EXTERNAL",
]);

export const userStatusEnum = pgEnum("user_status", [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
]);

export const subscriptionPlanEnum = pgEnum("subscription_plan", [
  "STARTER",
  "GROWTH",
  "ENTERPRISE",
]);

// ---------------------------------------------------------------------------
// Tenancy foundation
// ---------------------------------------------------------------------------

/// A customer of Noryx. Exactly one exists today (MFS); the schema is built
/// so adding a second is a business decision, not a migration.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  status: tenantStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/// A subsidiary or branch within a tenant. Reserved from Phase 0 per the
/// Design Gap Analysis §4.1 — defaulted to one per tenant today, but every
/// core entity in every later module carries legal_entity_id from its first
/// migration so multi-company activation never requires re-keying data.
export const legalEntities = pgTable(
  "legal_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    isDefault: boolean("is_default").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("legal_entities_tenant_code_unique").on(t.tenantId, t.code),
    index("legal_entities_tenant_id_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// Identity (owned operationally by services/identity; schema lives here so
// every service can resolve tenant/legal-entity/role without a network hop)
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /// Nullable only for PLATFORM_OPERATOR accounts, which are cross-tenant
    /// by design (System Architecture v1 §3.2) — every other tier requires one.
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),
    email: varchar("email", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    tier: userTierEnum("tier").notNull(),
    status: userStatusEnum("status").notNull().default("INVITED"),
    /// Coarse RBAC roles (e.g. "finance.approver", "orbis.technician");
    /// fine-grained field/record rules are the Rules Engine's job, not this
    /// column (Readiness Review §7.4).
    roles: text("roles").array().notNull().default([]),
    /// Argon2id hash. Null for accounts provisioned purely via an external
    /// OIDC identity provider once one is wired in (System Architecture v1
    /// §7 names OAuth2/OIDC as the target; this local-password path is the
    /// concrete Phase 0 implementation and coexists with future federation).
    passwordHash: text("password_hash"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    /// TOTP secret, envelope-encrypted at rest before it ever reaches this
    /// column — see services/identity/src/auth/mfa.service.ts.
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    /// Hash of the current refresh token (never the token itself) — rotated
    /// on every refresh so a stolen hash from a DB leak can't mint new tokens.
    refreshTokenHash: text("refresh_token_hash"),
    /// Milestone 3.2 Work Item 7 (docs/hardening/milestone-3.2-work-item-7-
    /// refresh-token-ttl-enforcement-proposal.md) — set once, at login()
    /// (a *new* session), never touched by refresh() rotation. Absolute TTL
    /// model: AuthService.refresh() rejects once now - refreshTokenIssuedAt
    /// exceeds TokenService.refreshTokenTtlSeconds, regardless of how
    /// recently the token was last rotated. NULL is fail-closed (treated as
    /// expired), not "no TTL" — see proposal §6.
    refreshTokenIssuedAt: timestamp("refresh_token_issued_at", {
      withTimezone: true,
    }),
    /// Time-boxed access grants (chat decision on role-based access
    /// "windows") — null means standing access.
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("users_tenant_email_unique").on(t.tenantId, t.email),
    index("users_tenant_id_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// Subscription & Entitlement (Phase 0 per Pre-Development Readiness Review §6)
// ---------------------------------------------------------------------------

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  plan: subscriptionPlanEnum("plan").notNull().default("STARTER"),
  status: tenantStatusEnum("status").notNull().default("ACTIVE"),
  seatLimit: integer("seat_limit").notNull(),
  /// Module entitlement keys — each service's noryx.module.json declares
  /// the key it checks for (see docs/plug-and-play-modules.md).
  entitledModules: text("entitled_modules").array().notNull().default([]),
  pastDueSince: timestamp("past_due_since", { withTimezone: true }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", {
    withTimezone: true,
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Audit (append-only — see drizzle/rls/002_immutable_audit_log.sql, which
// rejects UPDATE/DELETE at the trigger level)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalEntityId: uuid("legal_entity_id"),
    actorUserId: uuid("actor_user_id"),
    action: varchar("action", { length: 255 }).notNull(),
    entityType: varchar("entity_type", { length: 255 }).notNull(),
    entityId: varchar("entity_id", { length: 255 }).notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_entity_idx").on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row types — the TypeScript-native equivalent of Prisma's
// generated model types, with zero codegen step required.
// ---------------------------------------------------------------------------

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type LegalEntity = typeof legalEntities.$inferSelect;
export type NewLegalEntity = typeof legalEntities.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
