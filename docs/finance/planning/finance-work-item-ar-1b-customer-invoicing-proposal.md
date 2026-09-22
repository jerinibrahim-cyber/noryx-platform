# Finance Work Item AR-1b — Customer Invoicing

Status: implemented directly per the Product Owner's AR-1b kickoff
instruction, which itself resolved every design decision by naming
AP-1b as the literal reference implementation and mapping each of its
concepts onto AR 1:1. No separate approval round — this document
records what was read and built, per the standing "already-resolved
design decisions" rule.

## 0. What was read

`supplier-bills.service.ts` (full, 896 lines — the primary reference:
create/list/findOne/update/remove/post, all 11 posting steps, every
private helper), `supplier-bills.controller.ts`,
`supplier-bills.module.ts`, `create-supplier-bill.dto.ts`,
`create-supplier-bill-line.dto.ts`, `update-supplier-bill.dto.ts`,
`schema.ts`'s `apNumberCounters`/`supplierBills`/`supplierBillLines`
tables (with every doc comment), `drizzle/rls/004_ap_bills_rls.sql`,
`drizzle/constraints/005_supplier_bills_immutability_trigger.sql`,
`drizzle/constraints/006_supplier_bill_lines_immutability_trigger.sql`,
`drizzle/constraints/` directory listing (001–008, confirming 009/010
are the next free slots), `test/ap-bill-gl-integration.e2e-spec.ts`,
`test/ap-bill-concurrency.e2e-spec.ts`, `test/supplier-bills.e2e-spec.ts`
(describe-block structure), `apply-db-constraints.ts` and how it's
invoked (`ts-node src/db/apply-db-constraints.ts` against each DB,
separate from `pnpm run migrate`). AR-1a's own `customers`/`ar-settings`
service/controller/module/schema (already committed at `c85f1b9`) as
the customer-side and AR-settings-side reference.

## 1. Scope

In scope, per the kickoff instruction: customer invoice master, invoice
lines, invoice numbering, draft CRUD, tax/VAT handling, DRAFT → POSTED
lifecycle, customer/legal-entity/period validation, revenue-account
distribution, tax-output distribution, AR-control distribution, posting
into the existing Journal Engine using the AP-1b pattern, shared
journal numbering, posted-invoice immutability, GL integration,
RLS/RBAC/audit reuse, real-Postgres e2e coverage, concurrency safety
where applicable.

Out of scope (explicitly, per the kickoff instruction and the Finance
roadmap): customer receipts, receipt allocation, partial/full
settlement, customer statements, AR ageing, AR/GL reconciliation,
credit notes, multi-currency, advanced/AI capabilities — all deferred
to AR-1c/AR-1d/later Work Items, exactly as AP-1c/AP-1d followed AP-1b.

## 2. Design decisions surfaced (none blocking — proceeding directly)

**(1) No externally-supplied invoice-number field, unlike
`supplierBillNumber`.** AP-1b's `supplierBillNumber` is required
because a supplier bill is an _inbound_ document — the supplier
already assigned their own number to it, and we record that number
alongside our own internal reference for matching/reconciliation. A
customer invoice is the reverse: it's a document _we originate_, so
there is no external number to record at create time. `customerInvoices`
therefore has no `supplierBillNumber`-equivalent client-supplied field
— the server-assigned `internalReference` (`INV-NNNNNN`, assigned only
at posting, null while DRAFT) is the invoice's only number, mirroring
the _internal_-numbering half of `supplierBillNumber`/`internalReference`
exactly while correctly dropping the _external_-numbering half that
doesn't apply in this direction.

**(2) `paidMinor`/`payment_status` kept as literal field names, not
renamed for AR.** Both are structural placeholders for AR-1c's future
receipt-allocation posting, unused by any AR-1b code path — identical
in spirit to AP-1b's own `paidMinor`/`payment_status` being structural
ahead of AP-1c. Keeping the same field names (rather than e.g.
`collectedMinor`) matches how many double-entry systems already use
"paid" to mean "settled by the counterparty" regardless of AP/AR
direction, and keeps AR-1c's migration a pure loosening of the same
CHECK constraint AP-1c performed (`..._paid_minor_zero_until_ar1c` →
loosened), rather than a divergent design fork this Work Item has no
information to justify.

**(3) Line accounts unrestricted by type**, exactly mirroring AP-1b's
own precedent: `supplier_bill_lines.accountId` accepts any active
in-scope account (conventionally EXPENSE, never enforced). AR-1b's
`customer_invoice_lines.accountId` accepts any active in-scope account
(conventionally REVENUE, never enforced) — same reasoning, no new
policy invented.

## 3. Database schema

Two new tables plus a number-counter table, mirroring
`ap_number_counters`/`supplier_bills`/`supplier_bill_lines` exactly:

```
ar_number_counters                     -- mirrors ap_number_counters
  tenant_id            uuid NOT NULL   -- app-validated, no FK
  legal_entity_id       uuid NOT NULL  -- app-validated, no FK
  last_assigned_number  integer NOT NULL DEFAULT 0
  PRIMARY KEY (tenant_id, legal_entity_id)

customer_invoices                      -- mirrors supplier_bills
  id                    uuid PK, default random
  tenant_id             uuid NOT NULL  -- app-validated, no FK
  legal_entity_id       uuid NOT NULL  -- app-validated, no FK
  customer_id           uuid NOT NULL, FK -> customers(id)
  internal_reference    varchar(20)    -- null while DRAFT; "INV-NNNNNN"
                                        -- assigned only at posting
  status                customer_invoice_status ('DRAFT'|'POSTED') DEFAULT 'DRAFT'
  payment_status        invoice_payment_status ('UNPAID'|'PARTIALLY_PAID'|'PAID')
                                        DEFAULT 'UNPAID' -- structural; AR-1c's
                                        -- future writer, unused by AR-1b
  invoice_date          date NOT NULL
  due_date              date           -- invoiceDate + customer.paymentTermsDays
                                        -- at create time if configured, else null;
                                        -- independently editable while DRAFT
  currency_code         varchar(3) NOT NULL   -- resolved from legal entity
  subtotal_minor        bigint NOT NULL       -- server-computed: SUM(line.amountMinor)
  tax_minor             bigint NOT NULL DEFAULT 0   -- server-computed: SUM(line.taxAmountMinor)
  total_minor           bigint NOT NULL       -- server-computed: subtotal + tax
  paid_minor            bigint NOT NULL DEFAULT 0   -- AR-1b never writes anything but 0
  journal_entry_id      uuid, FK -> journal_entries(id)   -- set once, at posting
  period_id             uuid, FK -> accounting_periods(id) -- set once, at posting
  memo                  text
  created_by            uuid
  posted_by             uuid
  posted_at             timestamptz
  created_at / updated_at   timestamptz NOT NULL
  UNIQUE (tenant_id, legal_entity_id, internal_reference)  -- NULL-distinct
  INDEX (tenant_id, legal_entity_id)
  INDEX (customer_id)
  CHECK (total_minor = subtotal_minor + tax_minor)
  CHECK (subtotal_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0)
  CHECK (paid_minor = 0)   -- pinned until AR-1c, exactly like AP-1b's
                            -- supplier_bills_paid_minor_zero_until_ap1c

customer_invoice_lines                 -- mirrors supplier_bill_lines
  id                    uuid PK, default random
  tenant_id             uuid NOT NULL  -- denormalized from parent, for RLS
  invoice_id            uuid NOT NULL, FK -> customer_invoices(id) ON DELETE CASCADE
  line_number           integer NOT NULL
  account_id            uuid NOT NULL, FK -> chart_of_accounts(id)  -- unrestricted type
  description           varchar(500)
  amount_minor          bigint NOT NULL   -- > 0
  tax_amount_minor      bigint NOT NULL DEFAULT 0   -- >= 0
  created_at            timestamptz NOT NULL
  UNIQUE (invoice_id, line_number)
  INDEX (account_id)
  CHECK (amount_minor > 0)
  CHECK (tax_amount_minor >= 0)
```

## 4. RLS / immutability / RBAC / audit

- `drizzle/rls/007_ar_invoices_rls.sql` — tenant-only RLS (bypass-fix
  branch included) on `ar_number_counters`, `customer_invoices`,
  `customer_invoice_lines`, mirroring `004_ap_bills_rls.sql`
  structurally. `legal_entity_id` isolation stays an explicit
  service-layer predicate, same reasoning as every table above it.
- `drizzle/constraints/009_customer_invoices_immutability_trigger.sql`
  — mirrors `005_supplier_bills_immutability_trigger.sql`: once
  POSTED, only `paid_minor`/`payment_status` may change; every other
  column (including `updated_at`) is frozen; DELETE is blocked
  outright.
- `drizzle/constraints/010_customer_invoice_lines_immutability_trigger.sql`
  — mirrors `006_supplier_bill_lines_immutability_trigger.sql`: zero
  exceptions once the parent invoice is POSTED — INSERT/UPDATE/DELETE
  all blocked.
- RBAC: `finance.poster` writes (create/edit/delete/post), any
  `finance.*` role reads — same split as `SupplierBillsController`
  (transactional/posting document, not master data).
- Audit: `CREATE`/`UPDATE`/`DELETE`/`POST` on entity type
  `customer_invoice`, plus a linked `CREATE` on entity type
  `journal_entry` at posting time — identical dual-audit shape to
  `SupplierBillsService.post()`.

## 5. APIs

```
POST    /v1/finance/invoices              create (DRAFT)       finance.poster
GET     /v1/finance/invoices               list                 any finance.* role
GET     /v1/finance/invoices/:id           detail                any finance.* role
PATCH   /v1/finance/invoices/:id           edit (DRAFT only)     finance.poster
DELETE  /v1/finance/invoices/:id           delete (DRAFT only)   finance.poster
POST    /v1/finance/invoices/:id/post      DRAFT -> POSTED (200) finance.poster
```

List filters: `status`, `customerId`, `dateFrom`, `dateTo` — matches
AP-1b's original filter set (before AP-1c added `paymentStatus`); an
AR-1c-added `paymentStatus` filter is deferred the same way.

## 6. Posting — the balanced entry

Mirrors `SupplierBillsService.post()`'s 11-step transaction exactly,
applied to `customer_invoices` instead of `supplier_bills`, with the
debit/credit sides mirrored per the stated accounting rule:

1. Load + lock the invoice row (`SELECT ... FOR UPDATE`), scoped by
   tenant + legal entity.
2. `status === DRAFT`, else 409.
3. At least 1 line, else 422.
4. Re-validate every line's account (active, in-scope) independently
   of create/edit-time validation — 422 if any has since been
   archived.
5. Load AR settings; if the invoice carries any tax, the tax-output
   account must be configured — 422 otherwise.
6. Resolve + lock the covering OPEN accounting period by
   `invoiceDate` — 422 if none covers it or it's CLOSED.
7. Allocate the invoice number from `ar_number_counters`
   (`INV-NNNNNN`) — a separate counter from `journal_number_counters`.
8. Allocate the journal number from the SAME `journal_number_counters`
   sequence real journal entries and AP-1b/1c postings use
   (`JE-NNNNNN`) — no AR-only journal-number series.
9. Insert the journal entry as DRAFT, then its lines:
   - one line per invoice line, **CREDIT** `line.accountId` for
     `line.amountMinor` (revenue recognized)
   - if `taxTotal > 0`, one aggregate line, **CREDIT** the AR
     settings' `taxOutputAccountId` for `taxTotal`
   - one final line, **DEBIT** the AR settings' `arControlAccountId`
     for `totalMinor`
     — the exact "Debit: AR control; Credit: revenue line(s); Credit:
     tax-output" invariant the kickoff instruction specifies, and the
     mirror image of `SupplierBillsService.post()`'s Dr-expense/
     Cr-AP-control shape.
10. Flip the journal entry header to POSTED (journal number, period,
    postedBy/postedAt) — lines must exist first, since
    `journal_lines_immutable` blocks any INSERT once its parent is
    POSTED.
11. Update the invoice row to POSTED (`internalReference`,
    `journalEntryId`, `periodId`, `postedBy`, `postedAt`). Dual audit:
    `POST` on the invoice, `CREATE` on the new journal entry.

A failure at any step rolls back the whole transaction — no burned
invoice number, no burned journal number, no orphaned journal entry.

## 7. GL integration

No GL code is touched. A posted invoice's journal lines are ordinary
`journal_lines` rows against `journal_entries` — the existing, already
Work-Item-1b-proven `GET /accounts/:id/balance`, `GET
/accounts/:id/ledger`, and `GET /trial-balance` endpoints reflect them
automatically, with zero AR-specific code in the GL read layer.

## 8. Tests

`create-customer-invoice.dto.spec.ts`,
`create-customer-invoice-line.dto.spec.ts`,
`update-customer-invoice.dto.spec.ts` (unit); `route-role-matrix.spec.ts`
extended (48 → 54 routes, 11 → 12 controllers);
`test/customer-invoices.e2e-spec.ts` (draft CRUD, validation, posting,
immutability at both the service and DB-trigger level, tenant +
legal-entity isolation, audit trail — mirrors
`supplier-bills.e2e-spec.ts`'s describe-block structure);
`test/ar-invoice-gl-integration.e2e-spec.ts` (mirrors
`ap-bill-gl-integration.e2e-spec.ts`, proving the AR control account's
balance/ledger and trial balance reflect a posted invoice via the
unmodified GL read layer); `test/ar-invoice-concurrency.e2e-spec.ts`
(mirrors `ap-bill-concurrency.e2e-spec.ts`: concurrent double-post,
no-burned-number-on-failure, post-vs-period-close race).

## 9. Deferred to AR-1c onward

Customer receipts, receipt allocation, partial/full settlement,
customer statements, AR ageing, AR/GL reconciliation, credit notes,
multi-currency — unchanged from the roadmap, not touched by AR-1b.
