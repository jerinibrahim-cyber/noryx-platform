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

// ---------------------------------------------------------------------------
// AP Foundation — AP-1a (Supplier Master + AP Settings only).
// docs/finance-work-item-1-ap-foundation-proposal.md §5.
//
// AP-1a implements exactly these two tables — no bill/payment/allocation
// tables, and deliberately no `ap_number_counters` either: that counter
// table has no consumer until AP-1b (bill posting) exists, and adding it
// now would be exactly the kind of speculative-abstraction-ahead-of-need
// the implementation brief rules out. It is added in AP-1b alongside the
// first code that actually allocates from it.
//
// Same conventions as chart_of_accounts/accounting_periods above: no
// Postgres FK to db-core's tenants/legal_entities (cross-service
// boundary — tenantId/legalEntityId validated at the application layer,
// always sourced from a verified JWT claim); real FKs to Finance's own
// chart_of_accounts (same migration lifecycle); RLS is tenant_id-only,
// legal_entity_id isolation is an explicit service-layer predicate on
// every query (see SuppliersService/ApSettingsService).
// ---------------------------------------------------------------------------

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /// Net payment terms in days (e.g. 30 for "Net 30"). Nullable —
    /// optional at the supplier level. Not consumed by any code in
    /// AP-1a; AP-1b (bill due-date defaulting) and AP-1d (ageing) are
    /// its documented future consumers (proposal §5/§20).
    paymentTermsDays: integer("payment_terms_days"),
    /// Informational only (e.g. a VAT number) — not read or validated
    /// by any tax logic in this or any later AP-1a-adjacent work item.
    taxRegistrationNo: varchar("tax_registration_no", { length: 64 }),
    /// Pre-fills new bill lines in AP-1b; not enforced against any bill
    /// line at write time (proposal §5). Validated the same way as
    /// journal_lines.accountId at write time here: must exist, must be
    /// active, must be in the same (tenantId, legalEntityId) — see
    /// SuppliersService.validateOptionalAccountRef.
    defaultExpenseAccountId: uuid("default_expense_account_id").references(
      () => chartOfAccounts.id,
    ),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("suppliers_tenant_entity_code_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.code,
    ),
    index("suppliers_tenant_entity_idx").on(t.tenantId, t.legalEntityId),
  ],
);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;

/// One configuration row per legal entity — the AP control account (and
/// optional tax-input account) AP-1b's bill posting will debit/credit.
/// AP-1a only creates/reads this configuration; nothing in AP-1a posts
/// against it (proposal §5, §15 "Do not implement bill posting yet").
export const apSettings = pgTable(
  "ap_settings",
  {
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /// The single AP liability account for this legal entity. Validated
    /// at write time: must exist, must be active, must be in this
    /// (tenantId, legalEntityId), and — because "AP control account" is
    /// unambiguously a liability by definition — must be of type
    /// LIABILITY (ApSettingsService.upsert). Real FK: chart_of_accounts
    /// is Finance's own table, same migration lifecycle.
    apControlAccountId: uuid("ap_control_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    /// Optional in AP-1a. Required by AP-1b only once a bill actually
    /// carries a nonzero tax line (proposal §13/§15) — not enforced
    /// here. Deliberately NOT type-constrained the way
    /// apControlAccountId is: tax accounting treatment (asset vs.
    /// expense) is jurisdiction-dependent and out of scope for this
    /// increment to decide on the caller's behalf.
    taxInputAccountId: uuid("tax_input_account_id").references(
      () => chartOfAccounts.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.legalEntityId] })],
);

export type ApSettings = typeof apSettings.$inferSelect;
export type NewApSettings = typeof apSettings.$inferInsert;

// ---------------------------------------------------------------------------
// AP Foundation — AP-1b (Supplier Bills).
// docs/finance-work-item-1b-supplier-bills-proposal.md §4.
//
// Bill posting does NOT call JournalEntriesService (that service owns its
// own transaction — an atomicity mismatch for a sub-ledger that needs its
// own writes atomic with a journal posting, proposal §8). It inserts
// directly into journal_entries/journal_lines/journal_number_counters,
// already importable from this same schema file, replicating
// JournalEntriesService.post()'s validation/locking/numbering discipline
// rather than calling it. See SupplierBillsService.post().
//
// Same conventions as every table above: no Postgres FK to db-core's
// tenants/legal_entities (cross-service boundary); real FKs to Finance's
// own tables (suppliers, chart_of_accounts, journal_entries,
// accounting_periods — same migration lifecycle); RLS is tenant_id-only,
// legal_entity_id isolation is an explicit service-layer predicate on
// every query.
// ---------------------------------------------------------------------------

/// Race-free bill-numbering allocation, structurally identical to
/// journalNumberCounters but a SEPARATE table/row — bills and journal
/// entries must never contend for the same sequence, and their number
/// formats differ (BILL-NNNNNN vs JE-NNNNNN). Deliberately bill-only for
/// AP-1b (no counter_type discriminator column) — proposal §4/§24 item 1:
/// AP-1c decides then whether to widen this table or add a separate one
/// for payment numbering; either is a compatible additive migration.
export const apNumberCounters = pgTable(
  "ap_number_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    lastAssignedNumber: integer("last_assigned_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.legalEntityId] })],
);

export type ApNumberCounter = typeof apNumberCounters.$inferSelect;

export const supplierBillStatusEnum = pgEnum("supplier_bill_status", [
  "DRAFT",
  "POSTED",
]);

export const billPaymentStatusEnum = pgEnum("bill_payment_status", [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
]);

export const supplierBills = pgTable(
  "supplier_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    /// The SUPPLIER's own invoice/bill number — an external reference,
    /// not unique in our system, not validated for format.
    supplierBillNumber: varchar("supplier_bill_number", {
      length: 50,
    }).notNull(),
    /// Our own "BILL-000123" — null while DRAFT, assigned only at
    /// posting time via apNumberCounters, mirrors journalNumber's
    /// null-while-DRAFT/immutable-after-POST shape exactly.
    internalReference: varchar("internal_reference", { length: 20 }),
    status: supplierBillStatusEnum("status").notNull().default("DRAFT"),
    /// Meaningful only once status = POSTED. AP-1b never writes anything
    /// but the default UNPAID — AP-1c's payment-allocation posting is
    /// the sole future writer (proposal §2/§22). The column exists now
    /// because it is structural to this table's design, not because
    /// AP-1b exercises it.
    paymentStatus: billPaymentStatusEnum("payment_status")
      .notNull()
      .default("UNPAID"),
    billDate: date("bill_date").notNull(),
    /// Defaults to billDate + supplier.paymentTermsDays at create time
    /// if the supplier has one configured, else null; independently
    /// editable while DRAFT (SupplierBillsService.computeDefaultDueDate).
    dueDate: date("due_date"),
    /// Resolved from the legal entity's functional currency at creation
    /// — never client-supplied, identical to journalEntries.currencyCode.
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    /// Server-computed: SUM(line.amountMinor).
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull(),
    /// Server-computed: SUM(line.taxAmountMinor).
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    /// Server-computed: subtotalMinor + taxMinor.
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    /// AP-1b never writes anything but 0 — see the paid_minor_zero_until_ap1c
    /// CHECK constraint below (proposal §24 item 3). AP-1c's migration
    /// loosens this constraint together with introducing the first writer.
    paidMinor: bigint("paid_minor", { mode: "number" }).notNull().default(0),
    /// Set exactly once, at posting. Real FK: journal_entries is
    /// Finance's own table, same migration lifecycle.
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
    ),
    /// Set exactly once, at posting. Real FK: accounting_periods is
    /// Finance's own table, same migration lifecycle.
    periodId: uuid("period_id").references(() => accountingPeriods.id),
    memo: text("memo"),
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
    // NULL-distinct, unlimited DRAFT rows — identical shape to
    // journal_entries_tenant_entity_number_unique.
    unique("supplier_bills_tenant_entity_reference_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.internalReference,
    ),
    index("supplier_bills_tenant_entity_idx").on(t.tenantId, t.legalEntityId),
    index("supplier_bills_supplier_idx").on(t.supplierId),
    check(
      "supplier_bills_total_equals_subtotal_plus_tax",
      sql`${t.totalMinor} = ${t.subtotalMinor} + ${t.taxMinor}`,
    ),
    check(
      "supplier_bills_amounts_non_negative",
      sql`${t.subtotalMinor} >= 0 AND ${t.taxMinor} >= 0 AND ${t.totalMinor} >= 0`,
    ),
    // Loosened in AP-1c (docs/finance-work-item-1c-supplier-payments-
    // proposal.md §3) from the AP-1b-only `paid_minor = 0` pin
    // (supplier_bills_paid_minor_zero_until_ap1c, proposal §24 item 3)
    // back to the original AP Foundation proposal's intended range, now
    // that SupplierPaymentsService.post() is the first real writer.
    check(
      "supplier_bills_paid_minor_within_total",
      sql`${t.paidMinor} >= 0 AND ${t.paidMinor} <= ${t.totalMinor}`,
    ),
  ],
);

export type SupplierBill = typeof supplierBills.$inferSelect;
export type NewSupplierBill = typeof supplierBills.$inferInsert;

export const supplierBillLines = pgTable(
  "supplier_bill_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /// Denormalized from the parent bill — required for this table's
    /// own RLS policy, identical reasoning to journalLines.tenantId.
    tenantId: uuid("tenant_id").notNull(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => supplierBills.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    /// The expense/asset account this line's cost distributes to. NO
    /// type restriction (any active in-scope account) — same posture as
    /// journalLines.accountId. Real FK: chart_of_accounts is Finance's
    /// own table, same migration lifecycle.
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    description: varchar("description", { length: 500 }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    taxAmountMinor: bigint("tax_amount_minor", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("supplier_bill_lines_bill_line_number_unique").on(
      t.billId,
      t.lineNumber,
    ),
    index("supplier_bill_lines_account_idx").on(t.accountId),
    check("supplier_bill_lines_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "supplier_bill_lines_tax_amount_non_negative",
      sql`${t.taxAmountMinor} >= 0`,
    ),
  ],
);

export type SupplierBillLine = typeof supplierBillLines.$inferSelect;
export type NewSupplierBillLine = typeof supplierBillLines.$inferInsert;

// ---------------------------------------------------------------------------
// AP Foundation — AP-1c (Supplier Payments & Allocations).
// docs/finance-work-item-1c-supplier-payments-proposal.md §3.
//
// Payment posting does NOT call JournalEntriesService, same architectural
// reasoning as AP-1b's bill posting (transaction-atomicity mismatch) — it
// replicates JournalEntriesService.post()'s discipline directly against
// journal_entries/journal_lines/journal_number_counters, drawing journal
// numbers from the SAME sequence bills and hand-posted journal entries
// use. See SupplierPaymentsService.post().
//
// ap_payment_number_counters is a SEPARATE table from ap_number_counters
// (proposal §12 decision 1, approved) — ap_number_counters is not widened
// with a discriminator column and is not otherwise touched by AP-1c.
//
// Same conventions as every table above: no Postgres FK to db-core's
// tenants/legal_entities (cross-service boundary); real FKs to Finance's
// own tables (suppliers, supplier_bills, chart_of_accounts,
// journal_entries, accounting_periods — same migration lifecycle); RLS is
// tenant_id-only, legal_entity_id isolation is an explicit service-layer
// predicate on every query.
// ---------------------------------------------------------------------------

/// Race-free payment-numbering allocation, structurally identical to
/// ap_number_counters and journal_number_counters but its OWN separate
/// table/row — payments must never contend with bills for the same
/// sequence, and their number formats differ (PAY-NNNNNN vs BILL-NNNNNN).
export const apPaymentNumberCounters = pgTable(
  "ap_payment_number_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    lastAssignedNumber: integer("last_assigned_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.legalEntityId] })],
);

export type ApPaymentNumberCounter =
  typeof apPaymentNumberCounters.$inferSelect;

export const paymentMethodEnum = pgEnum("payment_method", [
  "BANK_TRANSFER",
  "CHEQUE",
  "CASH",
  "CARD",
  "OTHER",
]);

export const supplierPaymentStatusEnum = pgEnum("supplier_payment_status", [
  "DRAFT",
  "POSTED",
]);

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    /// Our own "PAY-000123" — null while DRAFT, assigned only at posting
    /// time via apPaymentNumberCounters, mirrors internalReference's
    /// null-while-DRAFT/immutable-after-POST shape exactly.
    internalReference: varchar("internal_reference", { length: 20 }),
    status: supplierPaymentStatusEnum("status").notNull().default("DRAFT"),
    paymentDate: date("payment_date").notNull(),
    /// Resolved from the legal entity's functional currency at creation —
    /// never client-supplied, identical to supplierBills.currencyCode.
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    /// The actual cash amount paid — client-supplied. Must equal
    /// SUM(allocations.allocatedAmountMinor) to post (proposal §7); no
    /// "payment on account" in this Work Item.
    paymentAmountMinor: bigint("payment_amount_minor", {
      mode: "number",
    }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /// Manually-selected GL cash/bank account — validated ACTIVE + type
    /// ASSET at create/edit/post time. No real bank-account entity yet
    /// (proposal §1/§13's documented future seam). Real FK:
    /// chart_of_accounts is Finance's own table, same migration
    /// lifecycle.
    bankCashAccountId: uuid("bank_cash_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    /// Free-text external reference (cheque number, transfer reference).
    /// No format validation — same posture as supplierBills.
    /// supplierBillNumber.
    reference: varchar("reference", { length: 100 }),
    memo: text("memo"),
    /// Set exactly once, at posting. Real FK: journal_entries is
    /// Finance's own table, same migration lifecycle.
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
    ),
    /// Set exactly once, at posting. Real FK: accounting_periods is
    /// Finance's own table, same migration lifecycle.
    periodId: uuid("period_id").references(() => accountingPeriods.id),
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
    // NULL-distinct, unlimited DRAFT rows — identical shape to
    // supplier_bills_tenant_entity_reference_unique.
    unique("supplier_payments_tenant_entity_reference_unique").on(
      t.tenantId,
      t.legalEntityId,
      t.internalReference,
    ),
    index("supplier_payments_tenant_entity_idx").on(
      t.tenantId,
      t.legalEntityId,
    ),
    index("supplier_payments_supplier_idx").on(t.supplierId),
    check(
      "supplier_payments_amount_positive",
      sql`${t.paymentAmountMinor} > 0`,
    ),
  ],
);

export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type NewSupplierPayment = typeof supplierPayments.$inferInsert;

export const supplierPaymentAllocations = pgTable(
  "supplier_payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /// Denormalized from the parent payment — required for this table's
    /// own RLS policy, identical reasoning to supplierBillLines.tenantId.
    tenantId: uuid("tenant_id").notNull(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => supplierPayments.id, { onDelete: "cascade" }),
    /// No onDelete cascade from supplier_bills — a bill is never deleted
    /// once POSTED (immutable), and only a POSTED bill may be allocated
    /// against (proposal §7), so this FK never needs cascade behavior.
    billId: uuid("bill_id")
      .notNull()
      .references(() => supplierBills.id),
    allocatedAmountMinor: bigint("allocated_amount_minor", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // At most one allocation row per (payment, bill) pair — an edit to
    // an existing allocation changes this row's amount rather than
    // adding a second row for the same pair.
    unique("supplier_payment_allocations_payment_bill_unique").on(
      t.paymentId,
      t.billId,
    ),
    index("supplier_payment_allocations_bill_idx").on(t.billId),
    check(
      "supplier_payment_allocations_amount_positive",
      sql`${t.allocatedAmountMinor} > 0`,
    ),
  ],
);

export type SupplierPaymentAllocation =
  typeof supplierPaymentAllocations.$inferSelect;
export type NewSupplierPaymentAllocation =
  typeof supplierPaymentAllocations.$inferInsert;
