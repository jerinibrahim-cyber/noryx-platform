# Formal Architecture Proposal — Document-Level Reversal for Posted AP & AR Documents

**Status of this document:** Formal architecture proposal only. Per the CTO's authorization, this is a proposal/review gate — no production code, schema, migration, test, configuration, or roadmap/state file has been modified in producing it. NOAH/orchestrator artifacts were not consulted or used as authority anywhere in this proposal.

**Scope:** all six posted AP/AR document types — Supplier Bills, Supplier Debit Notes, Supplier Payments (AP), Customer Invoices, Customer Credit Notes, Customer Receipts (AR).

**Re-verification statement:** every architectural claim in this document was re-verified directly against the repository at `HEAD = 83549747c18f1e53e8348cd00de1cf8b90e9b292` in this session — actual `src/`, `drizzle/constraints/*.sql`, and `test/` files were read, not the discovery document's own summary of them. File:line citations are given throughout so each claim can be independently spot-checked.

---

## 1. Executive Summary

This proposal recommends extending the codebase's existing, already-proven journal-entry reversal mechanism (`JournalEntriesService.lockAndValidateOriginalForReversal()` + `completeReversalPosting()`, already reused once by `ScheduledReversalsService`) to six AP/AR document types, via one new `POST /{resource}/:id/reverse` route each.

The central architectural finding of this proposal — reached only after tracing the exact existing schema and trigger set, not assumed — is that **no new database column, migration, or immutability-trigger change is required on any of the six document tables.** Every one of the six tables already carries a `journalEntryId` FK to the journal entry that posted it; `journal_entries` already carries a fully-proven, DB-trigger-enforced, one-time `reversedByJournalEntryId` linkage. "Is this Bill/Invoice/Payment/Debit Note/Credit Note/Receipt reversed?" is therefore already a fully answerable question — via `document.journalEntryId → journal_entries.reversedByJournalEntryId IS NOT NULL` — without inventing a second, redundant place to record the same fact. This directly satisfies the CTO's explicit instruction not to introduce a redundant accounting relationship, and it means the six documents' own posted-immutability triggers (005–018, quoted in full below) need **zero modification** — reversal never writes to a document's own row at all except in the one case where a settlement document's reversal must correctly un-apply its own effect on a target document's `paidMinor`/`paymentStatus`, which is already the one narrow, existing, already-shipped exception on `supplier_bills`/`customer_invoices` (triggers 005/009).

The proposal's other central design decision, driven directly by the mandatory "DO NOT CASCADE" rule: Supplier Bills and Customer Invoices (the two "target" document types anything else settles against) may be reversed only while `paidMinor = 0`; Supplier Payments, Supplier Debit Notes, Customer Receipts, and Customer Credit Notes (the four "settlement" document types that allocate against a target) may always be reversed (subject to period/already-reversed checks), and doing so correctly un-applies their own allocations' effect on the target's `paidMinor`/`paymentStatus` — using the exact update shape `post()` already uses, just subtracting instead of adding.

No FK or structural link was found anywhere between Supplier Payments/Customer Receipts and Bank Transactions/Bank Reconciliation (confirmed by exhaustive FK grep across `schema.ts`) — so reversal of a payment/receipt is never blocked by any banking/reconciliation state, because no such state is reachable from a payment/receipt row. This is stated as a definitive, evidence-backed conclusion in §5/§8 below, not an assumption.

This proposal is scoped strictly to reversal-of-a-fully-standalone-or-fully-unwindable posted document. Maker-checker, on-account payments, cascading reversal, FX/multi-currency, unrelated banking work, idempotency-key work, Tax/VAT Phase 6, and any NOAH/orchestrator work are explicitly out of scope (§23).

**Final status recommendation: READY** (see §24.11 for the full status statement and the one open policy question requiring explicit CTO confirmation before implementation).

---

## 2. Verified Repository Baseline

- `git rev-parse HEAD` → `83549747c18f1e53e8348cd00de1cf8b90e9b292`, matching the CTO's stated baseline.
- No file was modified to produce this proposal; only this document was written.
- All code, schema, and trigger excerpts below were read directly from `services/sphere-finance/src/db/schema.ts`, `services/sphere-finance/drizzle/constraints/*.sql`, and the relevant service/controller/spec files in this session — six parallel deep-dive investigations were run against the actual files (journal-entry reversal internals; AP schema/posting/triggers; AR schema/posting/triggers; the payment/receipt↔banking interaction chain; the reporting services; RBAC/audit/period-lock conventions), and every claim below is drawn from those investigations' direct file reads.

---

## 3. The Six Document Types — Consolidated Current-State Reference

| Document             | Table                   | Status enum     | Own settlement field?                                                       | Journal linkage                      | Allocates TO      | Allocated FROM                           |
| -------------------- | ----------------------- | --------------- | --------------------------------------------------------------------------- | ------------------------------------ | ----------------- | ---------------------------------------- |
| Supplier Bill        | `supplier_bills`        | `DRAFT\|POSTED` | `paidMinor`/`paymentStatus` (schema.ts:526-528,546)                         | `journalEntryId` (schema.ts:549-551) | — (target)        | Supplier Payments, Supplier Debit Notes  |
| Supplier Debit Note  | `supplier_debit_notes`  | `DRAFT\|POSTED` | none (schema.ts:1704-1707: settles via `supplier_bills.paidMinor` directly) | `journalEntryId` (1761-1763)         | Supplier Bills    | —                                        |
| Supplier Payment     | `supplier_payments`     | `DRAFT\|POSTED` | none                                                                        | `journalEntryId` (797-799)           | Supplier Bills    | —                                        |
| Customer Invoice     | `customer_invoices`     | `DRAFT\|POSTED` | `paidMinor`/`paymentStatus` (1055-1057,1077)                                | `journalEntryId` (1080-1082)         | — (target)        | Customer Receipts, Customer Credit Notes |
| Customer Credit Note | `customer_credit_notes` | `DRAFT\|POSTED` | none (1441-1447: settles via `customer_invoices.paidMinor` directly)        | `journalEntryId` (1510-1512)         | Customer Invoices | —                                        |
| Customer Receipt     | `customer_receipts`     | `DRAFT\|POSTED` | none                                                                        | `journalEntryId` (1329-1331)         | Customer Invoices | —                                        |

Two structural families emerge, and the whole proposal is organized around this split:

- **Target documents** (Bills, Invoices) — nothing settles against a bill/invoice; other documents' allocations settle against _it_. Its own `paidMinor` is the only signal of downstream dependency.
- **Settlement documents** (Debit Notes, Payments, Credit Notes, Receipts) — nothing settles against them; they hold allocation rows pointing at a target. Reversing one always means un-applying its own allocations from its target(s), never being blocked by a downstream dependency of its own (it has none).

No self-referential or reversal-linkage column exists on any of the six tables today (confirmed absent in every schema excerpt read). No third lifecycle status (e.g. `REVERSED`, `VOID`) exists in any of the six status enums — confirmed by direct enum definitions: `supplierBillStatusEnum` (schema.ts:491-494), `supplierDebitNoteStatusEnum` (1725-1728), `supplierPaymentStatusEnum` (752-755), `customerInvoiceStatusEnum` (1022-1025), `customerCreditNoteStatusEnum` (1472-1475), `customerReceiptStatusEnum` (1281-1284) — every one is exactly `["DRAFT","POSTED"]`.

---

## 4. Area 1 — Reversal Semantics

**Decision: the original document remains `POSTED` with reversal represented as a linkage, never a new status.** No `REVERSED` status value is added to any of the six enums.

Reasoning, directly answering the CTO's framing:

- A new status would be **redundant with, and could drift from,** the real source of truth, which (per §5 below) already lives on `journal_entries`. Introducing `REVERSED` as a document-level status would require the document row to be written to record it — which then requires a trigger exception on tables that today need none (§6) — purely so a status column can say what a join could already tell you for free.
- `journal_entries` itself, the codebase's own most authoritative precedent for "how do we represent that something posted has been reversed," **deliberately did not add a third status value either** — it kept `status: DRAFT|POSTED` and represented reversal purely via the nullable `reversalOfJournalEntryId`/`reversedByJournalEntryId` linkage columns (schema.ts:202,241-242). This proposal follows that exact precedent for consistency, not merely by analogy — it is the same underlying accounting fact (a posted thing has since been offset) being modeled the same way twice would be architecturally cleaner if modeled _once_.
- **Consequences of this decision:**
  - **Document lifecycle:** unchanged. `DRAFT → POSTED` remains the only transition a document ever makes on its own `status` column. A "reversed" document is a `POSTED` document whose linked journal entry has itself been reversed — a derived fact, not a stored state.
  - **Reporting:** every report that currently filters on `status = 'POSTED'` must additionally consider reversal state via a join (§12) — this is a real, necessary code change (not automatic), scoped precisely in §12.
  - **Auditability:** unaffected — audit rows are keyed by `action`/`entityType`/`entityId`, not by a status enum value, so `action: "REVERSE"` on `entityType: "supplier_bill"` is fully expressible today with zero schema change (§16).
  - **Immutability:** strengthened, not weakened — because no new status value and no new document-row write path exists for the six documents (with the one narrow settlement-unwind exception, §6), there is strictly less new "surface area" for the immutability triggers to have to reason about than a `REVERSED`-status design would introduce.
  - **API compatibility:** every existing response field (`status`, `paymentStatus`, `paidMinor`, etc.) keeps its exact current meaning — a consumer that has never heard of reversal continues to see `status: "POSTED"` exactly as before. Reversal state surfaces only via a new, additive, computed field (§17).
  - **Downstream allocations:** governed entirely by the target/settlement split and the block-don't-cascade rule (§7) — not by any status value.

---

## 5. Area 2 — Journal Entry Lineage

Full trace of the existing mechanism, re-verified directly this session:

- `JournalEntriesService.reverse()` (`journal-entries.service.ts:420-430`) → `reverseInTx()` (444-484) → `lockAndValidateOriginalForReversal()` (501-527) → `resolveAndLockOpenPeriod()` (840-863, itself wrapping `resolvePeriodForDate()`, 808-834) → `completeReversalPosting()` (545-677).
- `lockAndValidateOriginalForReversal()` is **not private** — its own doc comment (486-500) states it exists so `ScheduledReversalsService` can call it directly as its own first lock, and it does (`scheduled-reversals.service.ts:367-372`), with an identical positional-argument shape to the manual path's own call (453-458).
- `completeReversalPosting()`'s exact signature (545-554):
  ```ts
  async completeReversalPosting(
    tx: TxClient, tenantId: string, legalEntityId: string, actorUserId: string | null,
    original: JournalEntryWithLines, period: AccountingPeriod,
    transactionDate: string, memo: string,
  ): Promise<JournalEntryWithLines>
  ```
  It is 100% generic over `journal_entries`/`journal_lines`/`accounting_periods` — no parameter names or types reference any AP/AR concept, and `ScheduledReversalsService` already proves a second caller works correctly (`scheduled-reversals.service.ts:434-443`, identical positional-argument shape to the manual path).
- It builds the reversal's lines by swapping `debitMinor: l.creditMinor, creditMinor: l.debitMinor` per line (556-564), inserts a fresh `journal_entries` DRAFT header with `reversalOfJournalEntryId: original.id` set at insert time (566-578), allocates a fresh journal number from the same `journal_number_counters` sequence (588-594), posts it (596-613), and — the one write against the _original_ row — `UPDATE journal_entries SET reversedByJournalEntryId: postedReversal.id` on the original, touching that single column only (615-630), which is exactly the one legal mutation trigger 003 permits (quoted in full in §6).
- It writes three audit rows in one batch (640-673): `REVERSE` on the original journal entry, `CREATE` on the new reversal entry, `POST` on the new reversal entry.
- **Which period is checked?** Only the _reversal's own_ transaction date's period (today, or a dto override) — `reverseInTx()` line 468-470 calls `resolveAndLockOpenPeriod(tx, tenantId, legalEntityId, transactionDate)` where `transactionDate` is the reversal's own date; the original entry's `periodId`/period status is never read anywhere in the reversal path (confirmed by direct trace).

**Decision: is a new source-document → reversal-journal-entry link required?**

**No.** Every one of the six document tables already has `journalEntryId → journal_entries.id` (the _original_ posting). Combined with `journal_entries.reversedByJournalEntryId` (already present, already trigger-protected, already exactly the "has this been reversed, and by what" fact), the existing relationship is **sufficient**: `document.journalEntryId → journal_entries.reversedByJournalEntryId IS NOT NULL` fully answers "has this document's posting been reversed, and which journal entry did it?" A new column on any of the six document tables duplicating this fact would be exactly the redundant accounting relationship the CTO's instructions warn against — two places recording the same fact, with the attendant risk that a future code path updates one and not the other. This is the single most consequential decision in this proposal and is elaborated fully, with the rejected alternative, in §16.

For each document's own reversal call, the flow reuses `lockAndValidateOriginalForReversal(tx, tenantId, legalEntityId, document.journalEntryId)` and `completeReversalPosting(...)` **directly**, exactly as `ScheduledReversalsService` already does — not a duplicate reimplementation. This is safe to call cross-service because (unlike `resolveAndLockOpenPeriod`/`allocateJournalNumber`, which each posting service duplicates locally specifically because those methods used to open their own transactions) `completeReversalPosting()` takes an already-open `tx` and already-locked/resolved inputs — it never opens its own transaction — so calling it from within a document service's own `withTenant()` transaction is architecturally identical to what `ScheduledReversalsService` already does in production, not a new pattern.

---

## 6. Area 3 — Immutability

Full verbatim trigger text for `journal_entries` (003) was re-read and is the template every mandatory sub-requirement below is checked against:

```sql
IF OLD.status = 'POSTED' THEN
  IF OLD.reversed_by_journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION '... already reversed; reversed_by_journal_entry_id cannot be changed again ...';
  END IF;
  IF NEW.reversed_by_journal_entry_id IS NULL THEN
    RAISE EXCEPTION '... only setting reversed_by_journal_entry_id is permitted ...';
  END IF;
  IF <every other column> IS DISTINCT FROM <old> THEN
    RAISE EXCEPTION '... only reversed_by_journal_entry_id may be set, no other column (including updated_at) may change ...';
  END IF;
END IF;
```

**Decision: no immutability-trigger change is required on any of the six AP/AR document tables.**

This follows directly from §5: because reversal state is derived (via `journalEntryId` → `journal_entries.reversedByJournalEntryId`), reversing a document never needs to write a "this document is reversed" fact onto the document's own row. What _does_ need to be written, in the settlement-document case, is exactly the already-existing `paidMinor`/`paymentStatus` un-apply — and that column pair is **already** the one legal post-POSTED exception on `supplier_bills` (trigger 005) and `customer_invoices` (trigger 009), quoted in full below:

```sql
-- 005_supplier_bills_immutability_trigger.sql (verbatim, re-read this session)
IF OLD.status = 'POSTED' THEN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR ... -- every column EXCEPT paid_minor, payment_status
  THEN
    RAISE EXCEPTION '... only paid_minor/payment_status may change, no other column (including updated_at) may change ...';
  END IF;
END IF;
```

`009_customer_invoices_immutability_trigger.sql` is byte-identical in shape (only table/column names differ).

Checking every mandatory guarantee against this design:

| Mandatory guarantee                       | How it is satisfied                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No amount changes                         | `subtotalMinor`/`taxMinor`/`totalMinor` are outside the 005/009 allowed set — already enforced, unmodified.                                                                                                                                                                                                                                                |
| No date changes                           | `billDate`/`invoiceDate`/etc. outside the allowed set — already enforced.                                                                                                                                                                                                                                                                                  |
| No account changes                        | No line/account columns live on the header table at all (they're on the `*_lines` child tables, which are already zero-exception, §"child tables" below); header FKs (`journalEntryId`, `periodId`) are outside the allowed set.                                                                                                                           |
| No tax changes                            | Tax fields live on `*_lines`; header carries only `taxMinor` (outside allowed set).                                                                                                                                                                                                                                                                        |
| No allocation changes                     | Allocation _rows_ (`supplier_payment_allocations` etc.) are governed by their own triggers (008/012/015/018), all zero-exception, blocking INSERT too — reversal never touches an allocation row, only the target document's aggregate `paidMinor`/`paymentStatus`, so this guarantee is met by never writing to allocation tables at all during reversal. |
| No status mutation unless justified       | Zero status mutation anywhere in this design — the one existing trigger exception (005/009) does not touch `status`, and no new exception is proposed.                                                                                                                                                                                                     |
| No `updated_at` mutation unless justified | The settlement-unwind `UPDATE` must (and, per existing convention already does for the analogous settlement-_apply_ path) omit `updated_at` from its `SET` clause — enforced by the same trigger check that already rejects it today. No justification needed because no case in this design ever needs to touch it.                                       |
| Reversal can happen only once             | Enforced entirely by `journal_entries`' own trigger 003 (`reversed_by_journal_entry_id IS NOT NULL` check) — already shipped, already tested, requires no new code.                                                                                                                                                                                        |
| Reversal linkage cannot be replaced       | Same — trigger 003's `IF OLD.reversed_by_journal_entry_id IS NOT NULL THEN RAISE EXCEPTION` already guarantees this for the one place the linkage lives.                                                                                                                                                                                                   |
| Reversal linkage cannot be deleted        | `journal_entries` DELETE is unconditionally blocked once POSTED (003's `DELETE` branch) — already shipped.                                                                                                                                                                                                                                                 |

**Child-table (`*_lines`, `*_allocations`) triggers require no change either.** All eight (006, 008, 010, 012, 014, 015, 017, 018) are already zero-exception, blocking `INSERT`/`UPDATE`/`DELETE` unconditionally once the parent is POSTED — reversal never inserts, updates, or deletes a line or allocation row, so these triggers are already exactly correct for this feature with no modification.

**The zero-exception header triggers (007 `supplier_payments`, 011 `customer_receipts`, 013 `customer_credit_notes`, 016 `supplier_debit_notes`) also require no change**, because — per §5 — a settlement document's _own_ row is never written during its own reversal (only its _target_'s `paidMinor`/`paymentStatus` is written, and only for Bills/Invoices, which already have the needed exception). This is worth stating explicitly since it may look surprising: **reversing a Supplier Payment writes zero bytes to the `supplier_payments` row itself.** Its own header, lines-equivalent (it has none), and allocation rows are all completely untouched; only (a) a brand-new reversing `journal_entries`/`journal_lines` pair is inserted, (b) the _original_ `journal_entries` row gets its one legal `reversedByJournalEntryId` write, and (c) the _target bill's_ `paidMinor`/`paymentStatus` gets its already-legal update.

One file-level note worth surfacing to the CTO: `007_supplier_payments_immutability_trigger.sql`'s own header comment (re-read verbatim this session) **explicitly anticipated a future reversal/void feature needing a new narrow exception on that specific trigger** — this proposal's conclusion that no such exception is in fact needed represents a stronger (more minimal) outcome than that comment anticipated, achieved by choosing the join-based lineage design in §5 rather than a document-level linkage column. This is flagged as an explicit, considered deviation from that anticipatory comment's assumption, not an oversight of it.

---

## 7. Area 4 — Allocation Safety

**Default rule, per the CTO's explicit instruction: DO NOT CASCADE.** Exact blocking conditions per document type:

| Document                 | Blocking condition                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supplier Bill**        | `paidMinor > 0` → 422                                  | `paidMinor` only ever increases via `supplier_payment_allocations` or `supplier_debit_note_allocations` rows (confirmed: `SupplierBillsService` itself never writes either field — schema.ts:521-528 comment, confirmed no assignment anywhere in `supplier-bills.service.ts`). Since allocation amounts are `CHECK`-constrained `>0` (schema.ts constraints on both allocation tables), `paidMinor = 0` is logically equivalent to "no allocation row references this bill" — checking the single already-locked column is sufficient, no extra allocation-table query is needed. |
| **Customer Invoice**     | `paidMinor > 0` → 422                                  | Exact mirror; `paidMinor` only changes via `customer_receipt_allocations`/`customer_credit_note_allocations`, both `CHECK amount>0`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Supplier Debit Note**  | none of its own (nothing settles against a debit note) | Reversal always proceeds (subject to period/already-reversed checks) but must correctly unwind each of _its own_ `supplier_debit_note_allocations` rows against their target bills — see §9.                                                                                                                                                                                                                                                                                                                                                                                       |
| **Supplier Payment**     | none of its own                                        | Same shape — unwind its own `supplier_payment_allocations` rows against their target bills.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Customer Credit Note** | none of its own                                        | Unwind its own `customer_credit_note_allocations` rows against their target invoices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Customer Receipt**     | none of its own                                        | Unwind its own `customer_receipt_allocations` rows against their target invoices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Why the target/settlement split makes cascading unnecessary, not merely forbidden:** a settlement document reversal's "downstream effect" is entirely self-contained — it only ever touches its _own_ allocation rows (read-only) and their _targets'_ aggregate fields, never another settlement document. There is no scenario where reversing a Payment would need to also reverse a Debit Note, or vice versa — they are siblings, not a chain. The only genuine chain in this system is settlement → target, and the target-side block (`paidMinor > 0`) is precisely what prevents that chain from ever needing to cascade: **a target can only be reversed once nothing settles against it, which the block enforces directly rather than by walking a dependency graph.**

This is the exact reading of "Bill → PAID → reversal" / "Invoice → PAID → reversal" the CTO's mandatory area 6 asks about: **both are rejected outright with a 422**, e.g. `"Cannot reverse supplier bill <ref>: 50000 minor units have been allocated against it via payments/debit notes. Reverse the settling payment(s)/debit note(s) first."` The user must explicitly reverse each settling document first (each of which independently succeeds, since settlement documents have no block condition of their own), which will unwind `paidMinor` back toward zero one allocation at a time, until the bill itself becomes reversible.

---

## 8. Area 5 — Payment/Receipt + Banking Interaction

Full trace of `Supplier Payment → Bank/Cash Account → Bank Transaction → Bank Reconciliation` and the AR mirror, re-verified directly this session by grepping every FK on all four tables:

- `supplier_payments.bankCashAccountId` and `customer_receipts.bankCashAccountId` are **both plain FKs to `chart_of_accounts.id`, not to `bank_cash_accounts.id`** — schema.ts's own comment: _"No real bank-account entity yet."_ Posting a payment/receipt inserts a `journal_lines` row directly against that `chart_of_accounts` row (`supplier-payments.service.ts:494-513`; `customer-receipts.service.ts:513-532`) — **no `bank_transactions` row is ever created by a payment or receipt.**
- `bank_transactions` has FKs to `bank_cash_accounts.id` (×2), `chart_of_accounts.id`, `journal_entries.id`, `accounting_periods.id` — **none to `supplier_payments` or `customer_receipts`.**
- `bank_reconciliation_matches.bankTransactionId → bank_transactions.id` **only** — schema.ts's own comment confirms this is deliberate: _"deliberately NOT journal_entries/journal_lines."_ A Supplier Payment/Customer Receipt is structurally unreachable from a match row by any FK path, direct or transitive.

**Definitive answer to the mandatory question — is reversal blocked in any banking/reconciliation state?**

**No, in every one of the five named states** (no bank transaction exists / one exists / unmatched / matched / reconciliation incomplete or completed) — because none of those states are reachable from a `supplier_payments`/`customer_receipts` row by any FK. There is nothing to check, let alone block on, because the schema contains no path from a payment/receipt to any banking-module row.

**One real, evidence-backed consequence that is _not_ a blocking condition but must be documented:** a payment/receipt's journal line lands on the same `chart_of_accounts` row a `bank_cash_accounts.glAccountId` may point to. Bank Reconciliation's "book balance" (`glBookBalanceMinor`) is computed generically from **all** POSTED `journal_lines` against that GL account (`bank-reconciliation.service.ts:1379-1444`, explicitly documented and e2e-tested as "never a sum of `bank_transactions`" — `test/bank-reconciliation.e2e-spec.ts` lines 164-170, 544-597, via a helper literally named `postManualJournalBypassingBankTransactions` that simulates exactly what a Supplier Payment/Customer Receipt post() does). This means reversing a payment/receipt **will** change `glBookBalanceMinor` for any bank reconciliation import covering that GL account and date window — for both `OPEN` and already-`COMPLETED` imports, since the immutability trigger on `bank_reconciliation_matches` (021) protects the match _rows_, never the live book-balance _computation_.

**This is not a new risk introduced by this proposal — it is the existing, intentional, already-tested design of "book balance" as a live read, not a frozen snapshot.** Any correcting manual Journal Entry posted against that same GL account today already produces the identical effect, with no reversal feature involved at all. This proposal does not change that design and does not need to — it is explicitly _not_ proposing to block payment/receipt reversal on reconciliation state, because (a) no data model exists to check it, and (b) doing so would contradict the already-shipped, already-tested "book balance is a live figure" design. This is called out here so the CTO can weigh it as a known, accepted characteristic rather than discover it as a surprise later.

---

## 9. Area 6 — Payment Status / Paid State

Exact, re-verified writers of `paidMinor`/`paymentStatus`:

- **Supplier Bills**: written only by `SupplierPaymentsService.post()` (`supplier-payments.service.ts:576-583`) and `SupplierDebitNotesService.post()` (`supplier-debit-notes.service.ts:719-726`) — both via the identical `.set({ paidMinor, paymentStatus })`, never touching any other column, never `SupplierBillsService` itself.
- **Customer Invoices**: written only by `CustomerReceiptsService.post()` (`customer-receipts.service.ts:593-621`) and `CustomerCreditNotesService.post()` (`customer-credit-notes.service.ts:738-766`) — identical shape.

**Reversal design, per document family:**

- **Target documents (Bill/Invoice) reversed directly:** precondition `paidMinor = 0` (§7) means there is, by construction, nothing to un-apply — the document's own `paidMinor`/`paymentStatus` are simply never touched by its own reversal. Historical accounting state (the reversed journal entry), operational settlement state (`paidMinor`/`paymentStatus`, untouched, already zero), and reversal state (derived via §5's join) remain three cleanly distinguished concepts, exactly as the CTO's framing asks.
- **Settlement documents (Payment/Debit Note/Receipt/Credit Note) reversed:** their reversal **does** legitimately change the target's operational settlement state — this is not "silently rewriting operational state merely because the accounting entry is reversed," it is the direct, necessary, and only correct consequence of undoing a settlement: if a payment that paid off a bill is reversed, the bill is, by definition, no longer paid. The exact mechanism (mirroring `post()`'s own apply-side loop, subtracting instead of adding):

  ```ts
  for (const allocation of settlementDocument.allocations) {
    const target = targetsById.get(allocation.targetId)!;   // already locked FOR UPDATE
    const newPaidMinor = target.paidMinor - allocation.allocatedAmountMinor;
    const newPaymentStatus =
      newPaidMinor === 0 ? "UNPAID"
      : newPaidMinor === target.totalMinor ? "PAID"
      : "PARTIALLY_PAID";
    await tx.update(<targetTable>)
      .set({ paidMinor: newPaidMinor, paymentStatus: newPaymentStatus })  // never updatedAt
      .where(eq(<targetTable>.id, target.id));
  }
  ```

  A defensive assertion (`newPaidMinor >= 0`, throwing a hard internal error if violated — mirroring the existing hard-fail style already used for the trial-balance debit=credit assertion) guards against an otherwise-impossible negative balance, which the existing invariants (allocation rows are permanently immutable once posted, per §6's child-table triggers) should make unreachable in practice.

  **This never rewrites the _original allocation rows themselves_** (`supplier_payment_allocations` etc. remain byte-for-byte as posted, per their own zero-exception triggers, §6) — only the target's own two aggregate columns move. History (which allocation happened, for how much, against which bill) is fully preserved; only the _current operational_ paid/outstanding figure changes, which is exactly what "operational settlement state" should mean.

---

## 10. Area 7 — Credit/Debit Note Independence

Re-confirmed directly this session: `SupplierDebitNotesService.resolveLineTax()` and `CustomerCreditNotesService.resolveLineTax()` still take no `allocations` parameter (schema.ts comments 1820-1824, 1577-1584) — tax is resolved purely from the note's own date, independent of any bill/invoice it later allocates against.

**Proof that reversal preserves this invariant:** reversal, as designed in §5, never re-resolves tax, never re-reads `resolveLineTax()`, and never touches a `*_lines` row at all (they are zero-exception/immutable, §6). The reversing journal entry is built exclusively from `completeReversalPosting()`'s mechanical swap of the _original, already-posted_ journal entry's own lines (§5) — the exact same debit/credit amounts against the exact same accounts, mirrored. There is categorically no code path by which reversing a credit/debit note could cause tax inheritance from an invoice/bill, allocation-derived accounting, or mutation of a source invoice/bill's own lines, because reversal operates one layer below the tax-resolution/allocation layer entirely — on the already-fixed journal entry, not on the document's business logic.

---

## 11. Area 8 — Tax/VAT Interaction

Directly following from §10 and §5: **reversal never re-resolves tax rate, tax code, tax account, or tax amount.** `completeReversalPosting()`'s line-construction step (`journal-entries.service.ts:556-564`) reads only `original.lines` — the journal lines already posted, which for a tax-bearing document already include the Tax/VAT Phase 5 per-account-aggregated tax lines exactly as `post()` built them (e.g. `supplier-bills.service.ts:513-566`'s `taxByAccount` aggregation, already committed to `journal_lines` at original posting time). Reversal mirrors those exact lines, swapped. This is not a design choice this proposal introduces so much as an automatic, structural consequence of reusing `completeReversalPosting()` unmodified — there is no tax-specific code anywhere in the reversal path to get wrong.

---

## 12. Area 9 — Reporting Impact

Re-verified directly, file:line, this session:

**Already correct with zero code change** (both read exclusively `journal_entries`/`journal_lines`, filtered `status = 'POSTED'`, with zero AP/AR-table dependency, confirmed by full-file grep):

- `general-ledger.service.ts` (Ledger, Account Balance, Trial Balance) — `LedgerLine` already surfaces `reversalOfJournalEntryId`/`reversedByJournalEntryId` today (lines 51-52, 240-241, 711-712, 728-729, 763-764), sourced directly from `journal_entries`. A reversing entry appears automatically and correctly, netting the original, the moment it posts.
- `financial-statements.service.ts` (P&L, Balance Sheet) — same conclusion, same reasoning (`fetchTypeBalancesAsOf`/`Before`/`WithinRange`, all `je.status = 'POSTED'` only).

**Require new, explicit reversal-aware filtering** (currently filter only `doc.status = 'POSTED'` on the AP/AR table itself, with zero join to `journal_entries`, confirmed by exhaustive grep of every status-filter occurrence):

- `ap-reports.service.ts` — Supplier Statement (3 legs), AP Ageing, Supplier Balance/Reconciliation (`currentTotals`/`asOfTotals`, 5 legs each) — 11 distinct filter sites.
- `ar-reports.service.ts` — exact AR mirror, 11 sites.
- `tax-reports.service.ts` — `codeRows`, `totalTax`, `resolvedAccountTax` (Phase 5's multi-account breakdown) — 3 sites, all `AND doc.status = 'POSTED'` with no reversal awareness.

**Exact reporting semantics proposed** (this is a decision, not left to implementation, per the CTO's instruction):

1. **Reversed documents remain fully visible historically.** No report ever hides a reversed document from a statement/ledger view — a customer statement, for instance, should show the invoice, the fact of its reversal (surfaced via the additive `reversal` field, §17), and the reversing effect, exactly as `journal_entries`' own Ledger report already does today for GL-level reversals.
2. **Reversed documents are excluded from outstanding-balance and ageing calculations.** `getApAgeing`/`getArAgeing` and the `currentTotals`/`asOfTotals` outstanding-balance queries must add `LEFT JOIN journal_entries je ON je.id = doc.journal_entry_id` and filter `je.reversed_by_journal_entry_id IS NULL` (or, for as-of-date historical queries, `je.reversed_by_journal_entry_id IS NULL OR <reversal posted after the as-of date>` — see the historical-correctness nuance below) alongside the existing `status = 'POSTED'` filter. A reversed bill contributes zero to outstanding/ageing, exactly as if it had never existed from a "what do we still owe/are owed" perspective — which is the correct business meaning of a reversal.
3. **VAT Position Report excludes a reversed document's tax lines from net output/input tax**, via the identical join+filter pattern applied to `codeRows`/`totalTax`/`resolvedAccountTax`'s existing `doc.status = 'POSTED'` predicate.
4. **GL movement figures are unaffected and require no change** — they already net a reversal automatically (per the "already correct" list above). One valuable side effect: until the report-side fix lands, the existing `glCrossCheck`/`glLiabilityBalance`/`glAssetBalance` reconciliation checks would **already surface a reversed-but-uncorrected sub-ledger total as a reconciliation mismatch** (`reconciled: false`) rather than silently misreporting — this is a real, useful regression signal this proposal's test plan (§21) exploits directly (see the "reconciliation exposes the gap" test case).
5. **As-of-date historical queries** (Supplier/Customer Balance and Statement's `asOf` mode) need the reversal filter to itself be date-aware: a document reversed _after_ the requested `asOf` date should still count as outstanding _as of that date_, since the reversal is a `POSTED` reversing journal entry with its _own_ transaction date. The join condition becomes `je.reversed_by_journal_entry_id IS NULL OR reversingJe.transaction_date > :asOf` (requiring a second join from `reversed_by_journal_entry_id` to the reversing entry's own `transaction_date`). This is a real design detail with no external decision required — it follows directly from treating the reversal as a dated event, exactly like every other dated accounting event in this codebase.

---

## 13. Area 10 — Concurrency

Re-using the established pattern exactly, with one deliberate addition (an extra lock acquired for the journal-entry check) whose safety is proven by direct comparison to the already-shipped `ScheduledReversalsService` lock-ordering precedent (`scheduled-reversals.service.ts`'s own documented order: scheduled-reversal row → original journal entry → accounting period).

**Proposed lock order for a target-document (Bill/Invoice) reversal:**

1. Lock the document's own row `FOR UPDATE` (`findByIdInTx(..., {forUpdate:true})`, identical to every existing `post()`'s first step).
2. Check `status === 'POSTED'` (else 422) and `paidMinor === 0` (else 422, §7).
3. `lockAndValidateOriginalForReversal(tx, ..., document.journalEntryId)` — locks the linked `journal_entries` row, throws 409 if already reversed.
4. `resolveAndLockOpenPeriod(tx, ..., reversalTransactionDate)` — locks the covering period row for the reversal's own date (not the original's).
5. `completeReversalPosting(...)`.
6. One additional document-level audit row.

**Proposed lock order for a settlement-document (Payment/Debit Note/Receipt/Credit Note) reversal:**

1. Lock the settlement document's own row `FOR UPDATE`.
2. Check `status === 'POSTED'` (else 422).
3. Lock every target document referenced by this settlement document's own allocation rows, **in ascending `id` order** — the exact deadlock-avoidance convention already used by every existing settlement `post()` (e.g. `supplier-payments.service.ts:396-400`'s own documented "explicit deadlock-avoidance ordering").
4. `lockAndValidateOriginalForReversal(tx, ..., settlementDocument.journalEntryId)`.
5. `resolveAndLockOpenPeriod(tx, ..., reversalTransactionDate)`.
6. `completeReversalPosting(...)`.
7. Unwind each target's `paidMinor`/`paymentStatus` (§9) — targets are already locked from step 3.
8. One document-level audit row for the settlement document, plus one `UPDATE`-action audit row per unwound target (mirroring `post()`'s own convention of one audit row per settled bill).

**Why this introduces no deadlock risk:** the only new lock acquisition this feature adds relative to what `post()` already does is the `journal_entries` row lock (step 4/step 4 above) and the pre-existing period lock, in the exact sub-order (`journal_entries` → `accounting_periods`) `ScheduledReversalsService` already uses safely today, with the document/target-row locks (steps 1-3) acquired _before_ that sub-order begins, matching `post()`'s own existing (document/target-rows → period) ordering with the proven-safe (journal_entries → period) sequence simply inserted in between. No other code path in the system ever acquires a lock on `journal_entries` while holding one on `supplier_bills`/`customer_invoices`/etc. in a conflicting order — `post()` only ever _inserts_ a new `journal_entries` row (no lock needed on an insert), so there is no existing lock-acquisition path this new order could cycle against.

**Concurrent scenarios, each traced to a specific guarantee:**

- **Two reversal requests on the same document:** both attempt to lock the same `journal_entries` row via `lockAndValidateOriginalForReversal` — Postgres serializes; the loser re-reads under its own lock and finds `reversedByJournalEntryId !== null`, receiving a clean 409. Exactly the same mechanism already proven by `test/journal-entries.e2e-spec.ts`'s own concurrent-reverse test.
- **Reversal vs. a concurrent new allocation (post()) against the same target:** both lock the target row `FOR UPDATE` — whichever transaction wins the lock proceeds against a consistent view; the other blocks, then re-reads the updated `paidMinor` and correctly either succeeds (settlement post: allocates against the now-current outstanding) or fails the `paidMinor > 0` precondition (target reversal: correctly rejects, since a new allocation just landed). Direct extension of the already-tested "two concurrent payments against the same bill" concurrency guarantee.
- **Reversal vs. a concurrent bank reconciliation change:** no shared lock target exists (§8 — no FK path), so no race is possible at the row-lock level; the only interaction is the already-accepted live book-balance recomputation (§8), not a concurrency hazard.

---

## 14. Area 11 — Accounting Periods

Re-verified directly: `reverseInTx()` resolves and locks **only the reversal's own transaction date's period** (today, or a dto override) — the original entry's period/status is never read (`journal-entries.service.ts:468-470`, confirmed by absence of any reference to `original.periodId` anywhere in the reversal path). **This proposal reuses that exact behavior unchanged**: an AP/AR document reversal checks only that the reversal's own (today's or dto-supplied) transaction date falls in an OPEN period — the original posting period may be open, closed, or long since archived; it is irrelevant. This directly answers the CTO's question "do not assume" with a definitive, evidence-backed "no, only the reversal date's period matters, and this is the existing, already-shipped behavior being reused, not a new rule invented for this feature."

The period-lock call itself should reuse `JournalEntriesService.resolveAndLockOpenPeriod()`/`resolvePeriodForDate()` directly (the same public method `ScheduledReversalsService` already calls), rather than each of the six document services duplicating yet another private copy — see §15's shared-abstraction recommendation for the reasoning.

---

## 15. Area 12 — RBAC

**Recommendation: `finance.poster`**, with the alternative (`finance.admin`) presented for explicit CTO confirmation rather than silently decided.

Reasoning from existing convention, re-verified via `route-role-matrix.spec.ts`: every transactional-document write route (create/update/delete/post) across all six document types, and `journal-entries/:id/post` **and** `journal-entries/:id/reverse` itself, already carries exactly `["finance.poster"]` (quoted verbatim in §14's trace: lines 292-297 for journal-entries, and the six document `post` entries at lines 460, 483-485, 561-563, 586-588, 639-641, 662-664 — every one identical). Only master-data routes (accounts, suppliers, customers, tax codes, settings) use `finance.admin`. Reversal of a _transactional document_ is squarely in the same category as posting one, and the codebase's own most directly analogous precedent (`journal-entries/:id/reverse`) already uses `finance.poster`. Recommending `finance.poster` for all six new routes preserves this consistency exactly.

**Alternative considered:** `finance.admin`, on the reasoning that reversal is a more sensitive, less-frequent operation than ordinary posting. This is a legitimate policy stance, but it would be the **only** transactional-document write route in the entire system requiring `finance.admin` rather than `finance.poster` — a deliberate inconsistency with every existing precedent, including the one already-shipped reversal route (`journal-entries/:id/reverse`). This proposal does not choose this option, but surfaces it explicitly per the CTO's instruction not to silently pick one.

---

## 16. Area 13 — Audit

Re-verified exact existing shape (both `journal-entries.service.ts` and `supplier-bills.service.ts` use byte-identical field names): `{ tenantId, legalEntityId, actorUserId: actorUserId ?? undefined, action, entityType, entityId, beforeState, afterState }`.

**Proposed audit events per reversal request:**

1. The three existing rows `completeReversalPosting()` already writes, unchanged: `REVERSE`/`journal_entry`/original.id, `CREATE`/`journal_entry`/reversal.id, `POST`/`journal_entry`/reversal.id.
2. **One new row, per the CTO's explicit question "does the original document itself need an additional audit event" — yes**: `action: "REVERSE"`, `entityType`: the document's own type string (`"supplier_bill"`, `"supplier_debit_note"`, `"supplier_payment"`, `"customer_invoice"`, `"customer_credit_note"`, or `"customer_receipt"`), `entityId`: the document's own id, `actorUserId`, `tenantId`, `legalEntityId` — establishing parity with how `post()` already writes both a document-level _and_ a journal-entry-level audit row for the forward operation.
3. **For settlement documents only:** one additional `action: "UPDATE"` row per unwound target document, `entityType` the target's type (`"supplier_bill"`/`"customer_invoice"`), mirroring `post()`'s own existing convention of one audit row per settled bill/invoice.

**On `beforeState`/`afterState` for the new document-level row:** because (per §6) the document's own row is never written during a target-document reversal, `beforeState` and `afterState` for that document's own columns are identical — there is no column-level diff to show. This is an accepted, explicit consequence of the "no redundant column" design (§5/§16 rationale), not an oversight: the row still correctly records _who_ reversed _what_ _when_, and the `afterState` payload should be enriched with the (non-persisted, computed) reversing journal entry reference — `{ ...documentSnapshot, reversingJournalEntryId, reversingJournalNumber }` — so the audit trail remains fully informative even though no document column changed. For a settlement document's own audit row, the same reasoning applies (its own row is also never written); for the _target's_ unwind audit row, `beforeState`/`afterState` correctly do differ (`paidMinor`/`paymentStatus`), exactly as `post()`'s own settlement-apply audit row already does today.

---

## 17. Area 14 — API Design

Six new routes, one per document type, identical shape:

```
POST /supplier-bills/:id/reverse
POST /supplier-debit-notes/:id/reverse
POST /supplier-payments/:id/reverse
POST /customer-invoices/:id/reverse
POST /customer-credit-notes/:id/reverse
POST /customer-receipts/:id/reverse
```

**Request body:** reuse the existing `ReverseJournalEntryDto` shape directly (optional `transactionDate` override, optional `memo` override, defaulting to today's date and `` `Reversal of ${document.internalReference}` `` respectively) — no new DTO class is needed if that exact shape is imported/reused; if cross-module DTO reuse is judged undesirable, an identical `ReverseDocumentDto` should be defined once in a shared location and reused six times, never duplicated six times.

**Response shape:** the document's existing full read representation (identical to what `GET /:id` or `POST /:id/post` already returns), plus one new, additive, computed field:

```jsonc
{
  // ...every existing field, unchanged...
  "reversal": {
    // null if never reversed
    "journalEntryId": "...",
    "journalNumber": "JE-000123",
    "transactionDate": "2026-09-12",
    "postedAt": "2026-09-12T10:00:00Z",
    "postedBy": "user-uuid",
  },
}
```

This field is **computed via the join described in §5/§12 at read time, never stored** — consistent with the "no redundant column" decision. Recommending this same additive `reversal` field also be added to the existing `GET /:id`/list responses for all six document types (not only the `/reverse` response itself), so a consumer can tell a document is reversed without a separate call — this is a strictly additive response-shape change, matching the precedent `VatPositionGlCrossCheck`'s own additive-field extension (Tax/VAT Phase 5) already established as this codebase's convention for extending a response without breaking existing consumers.

**HTTP status codes** (mirroring `journal-entries/:id/reverse`'s own precedent exactly):

| Condition                                        | Status                                                                                                            | Message pattern                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Success                                          | **201 Created** (consistent with `/journal-entries/:id/reverse`'s own precedent — a new journal entry is created) | full document + `reversal` object                                                                                           |
| Not found / wrong tenant-entity                  | 404                                                                                                               | `No {document} found with id {id}.`                                                                                         |
| Not `POSTED` (still DRAFT)                       | 422                                                                                                               | `Only a posted {document} can be reversed.`                                                                                 |
| Already reversed                                 | 409                                                                                                               | `This {document} has already been reversed.`                                                                                |
| Allocation-blocked (target doc, `paidMinor > 0`) | 422                                                                                                               | `Cannot reverse: N minor units allocated. Reverse the settling payment(s)/debit note(s)/receipt(s)/credit note(s) first.`   |
| Closed period (reversal's own date)              | 422                                                                                                               | `Accounting period "{code}" covering {date} is closed.` (identical wording pattern to the existing journal-entries message) |
| Reconciliation-blocked                           | **Not applicable — never blocked** (§8); no such status code path exists for this feature                         |
| RBAC failure                                     | 403                                                                                                               | standard `RolesGuard` rejection                                                                                             |

---

## 18. Area 15 — Shared Abstraction

**Do reuse directly, do not duplicate:** `JournalEntriesService.lockAndValidateOriginalForReversal()` and `completeReversalPosting()` — both already public/exported specifically for cross-service reuse, already proven safe by `ScheduledReversalsService`'s own production usage within its own transaction. Each of the six document services should inject `JournalEntriesService` and call these two methods directly, exactly as `ScheduledReversalsService` already does. This is explicitly **not** the same situation as `resolveAndLockOpenPeriod`/`allocateJournalNumber`'s existing six-way duplication (which exists because those methods each used to open their _own_ transaction) — `completeReversalPosting()` never opens a transaction; it operates entirely within the caller's already-open `tx`.

**Also recommend reusing directly (new reuse, not previously shared):** `JournalEntriesService.resolveAndLockOpenPeriod()`/`resolvePeriodForDate()` for the _reversal's own_ period check specifically — since reversal is fundamentally a journal-entry-centric operation invoked from a document service, not a "post a new document" operation, there is no architectural reason to add a _seventh_ private duplicate of this method. (This does not touch or affect the six existing local duplicates used by each document's own `post()` — those remain unchanged and out of scope.)

**Recommend introducing exactly one new shared, pure, generically-parameterized helper** for the settlement-unwind arithmetic (§9), to avoid a _new_ four-way duplication (Payment/Debit Note/Receipt/Credit Note) of the identical three-branch `paidMinor`/`paymentStatus` recompute-and-update shape:

```ts
// src/common/reversal/unsettle-target.util.ts (illustrative signature only — not implemented in this proposal)
async function unsettleTarget(
  tx: TxClient,
  targetTable: PgTable, // supplierBills | customerInvoices
  targetId: string,
  unapplyAmountMinor: number,
): Promise<{ before: TargetRow; after: TargetRow }>;
```

This mirrors the already-established generic-parameterization convention this codebase already uses elsewhere for a near-identical multi-table-family problem (`tax-reports.service.ts`'s `accountBreakdown()`/`resolvedAccountTax()`, which are already generically parameterized over "which line table / which parent table / which FK column" to serve all four tax-bearing document types from one function body — Tax/VAT Phase 5's own precedent for exactly this kind of one-shared-function-over-a-document-family design).

**What stays document-specific, not shared:** the top-level `reverse()` orchestration method on each of the six services (lock own row → check own type-specific precondition → call the shared pieces above → write the document-specific audit row) — mirroring how `post()` itself is _not_ shared across the six services today (each has its own, for the same reason: each document type's precondition/polarity/settlement shape genuinely differs even though the individual steps reuse shared pieces).

---

## 19. Area 16 — Data Model

**Recommended: zero schema changes.** Restated from §5/§6 with full justification for each column that was considered and rejected:

| Column considered                                      | Table(s) | Rejected because                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reversedByJournalEntryId` (or `reversalOfDocumentId`) | all six  | Redundant with `document.journalEntryId → journal_entries.reversedByJournalEntryId`, already fully sufficient (§5). Two places recording the same fact is exactly the redundant relationship the CTO's instructions warn against.                                                                                                                                                                                                                                                 |
| `reversedAt`                                           | all six  | Fully derivable from the reversing journal entry's own `postedAt` (already stored, already correct) — no new fact to record.                                                                                                                                                                                                                                                                                                                                                      |
| `reversedByUserId`                                     | all six  | Fully derivable from the reversing journal entry's own `postedBy`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A new `REVERSED` status enum value                     | all six  | Would require a document-row write (and thus a new trigger exception) purely to record what a join already answers for free (§4).                                                                                                                                                                                                                                                                                                                                                 |
| A generic cross-document-type "reversals" table        | —        | Explicitly rejected in the original discovery and re-confirmed here: this codebase's established convention is one table per document family (mirroring how allocations are per-family, not a shared polymorphic table) — a shared reversal table would be the first polymorphic table in the entire schema and would need its own tenant/entity/FK-integrity story duplicated from scratch, for no benefit over the already-existing, already-correct `journal_entries` linkage. |

**Every proposed field must have an architectural justification (per the CTO's instruction) — since none survive that bar, none are proposed.** If, on review, the CTO prefers a denormalized column for query-simplicity or performance reasons despite the redundancy, §24.2 names this as the one architecture decision requiring explicit approval, with the tradeoff stated plainly: a denormalized column trades "zero migration, zero new trigger surface, single source of truth" for "simpler report queries, no join required" — this proposal's default recommendation is to keep the join-based design, but implementation should not proceed past this specific point without the CTO confirming that recommendation or choosing the alternative.

---

## 20. Area 17 — Migration / Backward Compatibility

**No migration is required for this work item**, following directly from §19. No existing row is touched by a migration (there is none), no NULL-semantics question arises (no new nullable column is added), no new FK is introduced, and no trigger function is modified. Every one of the fourteen relevant existing triggers (003 and 005-018) is reused completely unmodified.

**Backward compatibility is total by construction**, not merely preserved: a tenant that never calls any new `/reverse` route experiences precisely zero difference in behavior, schema, or API response shape (the one additive `reversal: null` field appearing in existing GET responses is the only visible change, and it is purely additive per the established `VatPositionGlCrossCheck` precedent). Already-POSTED historical documents are fully reversible from day one of this feature shipping (there is no backfill to perform, because there is no new column to backfill).

If the CTO instead selects the denormalized-column alternative (§19), this section would need to be rewritten to cover: an additive nullable-column migration (following the exact `drizzle-kit generate` provenance convention used by every prior phase, most recently migration `0020`), NULL semantics (all-NULL for every pre-existing row, meaning "never reversed" — matching the existing `journal_entries.reversedByJournalEntryId` NULL-default convention exactly), new narrow trigger exceptions on 007/011/013/016 (mirroring 005/009's existing shape), and no destructive change in either case.

---

## 21. Area 18 — Test Plan

Comprehensive matrix, templated directly on the already-proven journal-entry and scheduled-reversal test suites (`journal-entries.e2e-spec.ts`'s own concurrent-reverse tests, `scheduled-reversals-concurrency.e2e-spec.ts`'s own 50-repetition real-HTTP race test, `journal-engine-db-constraints.e2e-spec.ts`'s own direct-SQL trigger-rejection pattern).

**Per document type (×6), service/e2e level:**

- Successful reversal — correct reversing journal entry (swapped debit/credit, same accounts, same amounts as the original), correct `reversal` field in the response, correct audit rows (document-level `REVERSE` + the three existing journal-entry-level rows), correct HTTP 201.
- Duplicate reversal — second attempt → 409, exactly one reversing journal entry ever exists.
- DRAFT rejection — reversing a never-posted document → 422.
- Not-found / cross-tenant / cross-legal-entity → 404.
- Closed-period rejection — reversal attempted with today's (or dto-supplied) date falling in a CLOSED period → 422; a **separate** test confirms the _original_ posting period may be freely closed with no effect on reversibility (§14).
- RBAC — `finance.poster` succeeds, `finance.viewer` gets 403, matrix entry present in `route-role-matrix.spec.ts` (138 total routes after this change).
- Audit creation — exact row count and field values per §16, including the settlement-unwind rows for the four settlement document types.
- Immutability enforcement at the DB level — a direct raw SQL `UPDATE` attempt against any column of a reversed document's own row (not `journal_entries`) is rejected by the _existing, unmodified_ trigger, proving no new mutation surface was accidentally introduced.

**Target-document-specific (Bill, Invoice):**

- Allocation-blocked reversal — `paidMinor > 0` → 422 with the exact message pattern; then reversing the settling payment(s) first, followed by a now-succeeding bill/invoice reversal — proving the full, non-cascading, user-driven unwind sequence end-to-end.

**Settlement-document-specific (Debit Note, Payment, Credit Note, Receipt):**

- Single-allocation unwind — target's `paidMinor`/`paymentStatus` correctly returns to its pre-settlement value, exact debit/credit polarity of the reversing entry verified.
- Multi-allocation unwind — a settlement document that allocated against two targets; reversal correctly unwinds both, leaving any _other_ settlement document's contribution to either target's `paidMinor` untouched.
- Concurrent reversal vs. a new concurrent allocation against the same target — exactly one of the two operations sees the pre-race state, the other correctly sees the post-race state (§13).

**Cross-cutting:**

- Concurrent double-reversal of the same document — exactly one 201, one 409, exactly one reversing journal entry, real `Promise.all`-driven HTTP race (mirroring the 50-repetition pattern already proven for scheduled reversals).
- Tax-account preservation — a tax-bearing bill/invoice's reversal produces a reversing journal entry whose tax lines hit the _exact same_ `resolvedTaxAccountId`(s) as the original, never re-resolved (§11) — directly asserted, not merely inferred.
- Reporting behavior — after reversal: AP/AR ageing and outstanding-balance figures exclude the reversed document (§12 point 2); VAT Position Report's net tax excludes its tax lines (§12 point 3); GL/Trial Balance/P&L/Balance Sheet correctly net the reversing entry with zero code-path difference from any other journal entry (§12, "already correct" list) — asserted directly against real report responses, not assumed.
- Tenant isolation / legal-entity isolation — a reversal attempt using another tenant's or legal entity's id → 404 (folded into the existing scoping predicate, per §5's reuse of `lockAndValidateOriginalForReversal`, which already enforces this for journal entries — the document-level lock must enforce the identical scoping for the document's own table).
- Full regression — the entire existing unit and e2e suite (610/891 at this baseline) must continue to pass completely unmodified.

**DB-level trigger verification (not service-level only), per the CTO's explicit requirement:** a direct raw SQL `UPDATE`/`INSERT`/`DELETE` attempt against each of the fourteen existing triggers (003, 005-018) in their post-reversal state, confirming every one still rejects exactly what it rejected before this feature shipped — proving the "zero trigger modification" claim in §6 empirically, not just by code inspection, mirroring the exact style of empirical proof Tax/VAT Phase 5 used for its own immutability claim.

---

## 22. Area 19 — Cross-Cutting Lesson Audit (Tax/VAT Phases 2-5)

| Lesson                                       | How this proposal preserves it                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot semantics                           | Not applicable to reversal itself (reversal reads, never re-resolves, a snapshot — §11) — the lesson is honored by _not_ re-deriving anything at reversal time.                                                                             |
| Immutable posted data                        | Strengthened: zero new trigger exceptions anywhere (§6), the strictest possible outcome.                                                                                                                                                    |
| AP/AR symmetry                               | Preserved exactly — every rule in this proposal (target-vs-settlement split, block condition, unwind mechanics, RBAC, audit shape) is applied identically to both sides, with only account-polarity differing (as it correctly should).     |
| Independent credit/debit-note tax resolution | Explicitly proven unaffected in §10 — reversal operates below the tax-resolution layer entirely.                                                                                                                                            |
| Deterministic GL account destination         | Preserved — reversal mirrors the exact already-resolved, already-deterministic destination account(s) from the original posting (§11); no new destination is ever chosen.                                                                   |
| Additive corrections, never rewrites         | The central design principle of this entire proposal (§4-§6) — no document row is rewritten; only new rows are inserted (reversing journal entry, audit rows) and the one already-legal aggregate-column update occurs (settlement unwind). |
| DB-level immutability                        | Zero new trigger code; every guarantee is inherited unmodified from already-shipped, already-tested triggers (§6).                                                                                                                          |
| RLS                                          | Untouched — every new operation runs inside the existing `withTenant()` pattern; no new table, no new RLS policy needed.                                                                                                                    |
| Auditability                                 | Extended following the exact existing shape/field-names convention (§16), no new pattern invented.                                                                                                                                          |
| Concurrency locking                          | Directly extends the proven `SELECT...FOR UPDATE` + lock-ordering discipline, verified against the one already-shipped multi-lock precedent (`ScheduledReversalsService`) for cycle-safety (§13).                                           |
| Historical correctness                       | Explicitly designed for in §12's as-of-date reasoning — a reversal's own transaction date governs its historical visibility, exactly like every other dated accounting event in this system.                                                |

No lesson from Phases 2-5 was found to require a _new_ mechanism this proposal doesn't already have direct precedent for — this proposal's engineering content is almost entirely "apply the already-proven journal-entry-reversal and Tax/VAT-Phase-5-style generic-parameterization patterns to six more tables," not new invention.

---

## 23. Area 20 — Exact Implementation Scope

**IN SCOPE:**

- Six new service methods + controller routes (`reverse()` on `SupplierBillsService`/`Controller`, `SupplierDebitNotesService`/`Controller`, `SupplierPaymentsService`/`Controller`, `CustomerInvoicesService`/`Controller`, `CustomerCreditNotesService`/`Controller`, `CustomerReceiptsService`/`Controller`).
- One new shared utility (§18) for settlement-unwind arithmetic, generically parameterized over the two target-table families.
- Reuse (not duplication) of `JournalEntriesService.lockAndValidateOriginalForReversal()`, `completeReversalPosting()`, `resolveAndLockOpenPeriod()`/`resolvePeriodForDate()` — these methods themselves require no modification, only new call sites.
- Additive `reversal` field on the six documents' existing read/list DTOs and responses.
- Reversal-aware join+filter additions to `ap-reports.service.ts`, `ar-reports.service.ts`, `tax-reports.service.ts` (§12) — application-code-only changes, no schema impact.
- Six new `route-role-matrix.spec.ts` entries (`finance.poster`, pending §15's confirmation).
- New DTO (either reused `ReverseJournalEntryDto` or one new shared `ReverseDocumentDto`).
- New e2e coverage per §21.
- **Zero schema/migration/trigger changes** (§19-§20), pending the CTO's confirmation of the join-based design over the denormalized-column alternative.

**OUT OF SCOPE (explicitly, per the CTO's instruction — none of the following may leak in):**

- Maker-checker / approval workflow on the reversal action.
- On-account/unapplied payments or receipts.
- Cascading reversal of any kind — the block-only rule (§7) is final for this work item.
- FX / multi-currency.
- Any unrelated Banking module enhancement (bank-feed adapters, vendor-specific settlement formats, ageing of unreconciled transactions, etc.).
- Idempotency-key work for document _creation_ (a separate, already-identified, deliberately-deferred gap per the roadmap's own Milestone 3.3 gate).
- Tax/VAT Phase 6 (manually-posted non-AP/AR tax journal entry coverage) or any other next Tax/VAT phase.
- Any NOAH/orchestrator artifact or workstream.
- Any change to `docs/roadmap.md` or `docs/project/PROJECT_STATE.md` (those are implementation-phase deliverables, not proposal-phase ones, per the established Phase 3/4/5 pattern).

**FUTURE WORK (named, not authorized, not designed further here):**

- A guided/optional cascading-reversal UX (e.g., "reverse this bill and everything settled against it," with explicit confirmation) — technically buildable on top of this proposal's primitives once shipped, but deliberately not part of this scope.
- Reversal-of-a-reversal / correction-workflow (the same gap `journal_entries` itself already explicitly defers — `"Cannot reverse a reversal; reversal-of-reversal requires a dedicated correction workflow, not yet built."`, `journal-entries.service.ts:522-524`) — this proposal inherits that same limitation unchanged for all six document types, since it reuses the identical check.
- Extending the same reversal pattern to Bank Transactions (out of scope here since the CTO's authorization named exactly the six AP/AR documents).

---

## 24. Final Deliverable Summary

### 24.1 Executive architectural recommendation

Implement document-level reversal for all six AP/AR document types by reusing the existing, already-proven `JournalEntriesService` reversal primitives directly (not duplicating them), representing reversal state purely via the existing `document.journalEntryId → journal_entries.reversedByJournalEntryId` linkage (no new column, no new migration, no new trigger exception on any of the six document tables), enforcing a strict block-don't-cascade rule keyed on each document's existing `paidMinor` field for the two "target" document types, and extending exactly three reporting services with reversal-aware join filtering.

### 24.2 Architecture decisions requiring CTO approval

1. **Reversal-state representation: derive via existing `journalEntryId` → `journal_entries.reversedByJournalEntryId` join (recommended) vs. a new denormalized `reversedByJournalEntryId`-style column on each of the six tables (rejected, §19).** This is the single most consequential decision in this proposal and should be explicitly confirmed before implementation begins.
2. **RBAC: `finance.poster` (recommended, matching every existing transactional-write and the existing `journal-entries/:id/reverse` precedent) vs. `finance.admin` (§15).**
3. **Shared settlement-unwind helper (recommended, §18) vs. four independent duplicated implementations**, matching this codebase's existing (but not universal) preference for per-service duplication of small helpers — a genuine style choice, not a correctness question.

### 24.3 Exact data model

No schema change (§19-§20), pending confirmation of decision 1 above.

### 24.4 Exact service flow

§13 (lock ordering, both document families), §5 (reuse of `lockAndValidateOriginalForReversal`/`completeReversalPosting`), §9 (settlement-unwind arithmetic).

### 24.5 Exact API contract

§17 — six routes, request/response shapes, and the full status-code table.

### 24.6 Exact reporting semantics

§12 — the five explicit semantic rules (historical visibility, outstanding/ageing exclusion, VAT net-tax exclusion, GL/Trial-Balance/Financial-Statements requiring no change, as-of-date reversal-dating).

### 24.7 Exact test strategy

§21 — full matrix across all six document types plus cross-cutting concurrency/reporting/regression coverage, including DB-level trigger re-verification.

### 24.8 Exact file/module scope

§23 — IN SCOPE / OUT OF SCOPE / FUTURE WORK, explicit and exhaustive.

### 24.9 Risks and mitigations

| Risk                                                                                                     | Mitigation                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report queries (§12) shipped without the reversal-aware join, silently over-counting a reversed document | Test plan §21 explicitly asserts post-reversal report figures, not just the reversal endpoint's own response; the existing GL cross-check would also flag the resulting mismatch as a build-time regression signal. |
| A future developer adds a seventh document type and forgets the block-vs-settlement classification       | The shared-abstraction design (§18) makes the classification an explicit, required parameter to the one shared unwind helper, rather than an easily-missed inline branch repeated per service.                      |
| Perceived complexity of the join-based (no-column) design during implementation                          | Directly mitigated by this proposal's explicit worked-through reasoning (§5-§6, §19) and by the fact that the join pattern is a single, reusable predicate, not bespoke per report.                                 |
| Reversal changing Bank Reconciliation's live book-balance figure surprises a user                        | Documented explicitly (§8) as an accepted, pre-existing characteristic of the book-balance design, not a defect to fix in this work item.                                                                           |

### 24.10 Alternatives rejected and why

- **New `REVERSED` status value** — rejected, §4 (redundant with the linkage-based design; `journal_entries` itself sets the precedent of not doing this).
- **New reversal-linkage/timestamp/user columns on each of the six tables** — rejected, §19 (redundant with the already-sufficient existing FK chain).
- **A generic, polymorphic cross-document "reversals" table** — rejected, §19 (first polymorphic table in the schema, no benefit over the existing linkage).
- **Duplicating `completeReversalPosting()`/`lockAndValidateOriginalForReversal()` per document service** (matching the `resolveAndLockOpenPeriod` precedent) — rejected, §5/§18 (that precedent exists for a reason — transaction-ownership mismatch — that does not apply to these particular methods, which already take an open `tx`; duplicating them here would be needless, unjustified divergence from the one existing multi-caller precedent this codebase already has).
- **Cascading reversal** — rejected per the CTO's explicit instruction, §7.

### 24.11 Final status

**READY.**

This proposal is architecturally complete and internally consistent, requires no external business/product decision to proceed (the three items in §24.2 are internal engineering-policy choices this document already recommends specific answers for), and is fully groundable in already-shipped, already-tested infrastructure. Implementation should not begin, per the CTO's explicit instruction, until this proposal is reviewed and the decisions in §24.2 are confirmed or amended.
