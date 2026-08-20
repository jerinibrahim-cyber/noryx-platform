# Finance Core — 2c: Journal Entry Service, Posting, and Reversal

**Status: reviewed and approved as the 2c-1/2c-2 implementation
checkpoint.** Two corrections were required before implementation and are
incorporated below (§0.1). 2c-1 (accounting periods + journal draft CRUD)
is approved to begin. **2c-2 (posting, reversal, numbering) is explicitly
not approved and must not be started** until 2c-1 is implemented,
verified, and reviewed on its own.

It implements the application/API layer described in
`docs/finance-journal-engine-proposal.md` §2, §3, §6, §7, §9 (Revision 2,
already approved) on top of the database primitives 2b actually shipped —
including the four corrections from the 2b review (`c8e165e` +
`15f044b`). Nothing here reopens a decision already made in that proposal;
this is the concrete implementation shape for what §12 called "2c —
Journal entry service and API."

## 0.1 Decisions from review

| item                                    | decision                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FinanceAuthModule`                     | Yes for the two new modules (`AccountingPeriodsModule`, `JournalEntriesModule`). **`AccountsModule` is left untouched** — no refactor of already-approved 1b/2a code. The two new modules each import `PassportModule` + provide `JwtStrategy` via the shared `FinanceAuthModule`; `AccountsModule` keeps its own existing inline registration exactly as-is. |
| Account validation on draft create/edit | Yes — existence, active, same tenant+entity, enforced at create and at edit.                                                                                                                                                                                                                                                                                  |
| Account validation on posting           | Yes — re-validated independently in the posting transaction; never trusts draft-time state (2c-2).                                                                                                                                                                                                                                                            |
| `PATCH` line replacement                | Full-array replacement when `lines` is present; no `/lines` sub-resource.                                                                                                                                                                                                                                                                                     |
| 2c structure                            | **Split**: 2c-1 (this implementation) = accounting periods + journal draft CRUD + RBAC + audit + tests, no posting/numbering/reversal. 2c-2 (separate, future, requires its own review) = posting, reversal, numbering, the cross-entity posting-time re-validation, and the two corrections below.                                                           |
| Concurrent posting                      | **Required for 2c-2**: `SELECT ... FOR UPDATE` (or equivalent atomic conditional transition) on the journal entry row before validating/posting, so two simultaneous `POST .../post` calls cannot both pass the `DRAFT` check. See §5.1 (updated). Documented now so it's part of 2c-2's design record even though 2c-2 isn't being implemented yet.          |
| Period-overlap race                     | **Required for 2c-1** (accounting periods are in scope now): a raced `EXCLUDE`/`UNIQUE` constraint violation from Postgres must never escape the API as a raw error — the service catches the specific constraint violation and maps it to `409 Conflict`. See §3 (updated).                                                                                  |

---

## 0. What was inspected before writing this

- `services/sphere-finance/src/accounts/{accounts.service,accounts.controller,accounts.module}.ts`
  and `dto/create-account.dto.ts` — the pattern every piece of 2c will
  copy: `withTenant(tenantId, tx => ...)` for every mutation, explicit
  `and(eq(tenantId...), eq(legalEntityId...))` predicates on every query
  (never relying on RLS alone for the entity boundary), a same-transaction
  `audit_logs` insert on every write, `@Roles()` per route with OR
  semantics, and `tenantId`/`legalEntityId` always read from the verified
  JWT via `CurrentUser()`, never from the request body.
- `services/sphere-finance/src/db/db.ts` and `schema.ts` — `withTenant`,
  the `TxClient` type, and the exact current shape of `journalEntries`,
  `journalLines`, `accountingPeriods`, `journalNumberCounters` (as
  corrected in `15f044b`: `journal_lines_entry_line_number_unique`,
  `journal_lines_nonzero`, and the fully-immutable posted-entry trigger
  including `updated_at`).
- `services/sphere-finance/src/auth/**` — `RolesGuard`, `Roles()`,
  `CurrentUser()`, `JwtStrategy` — all reusable as-is, no changes needed.
- `packages/db-core/src/schema.ts` — `auditLogs` (already wired into
  Finance's schema union in `db.ts`) and `legalEntities`, which has its
  own `currencyCode` — needed for §4 below and **not yet** in Finance's
  schema union.
- `services/sphere-finance/noryx.module.json` — `requiredRoles` currently
  `["finance.viewer", "finance.admin"]`; needs `finance.poster` added per
  the approved proposal §7's note, or posting/reversal calls will never
  reach the service past the Gateway's coarse pre-filter.

---

## 1. Scope for this increment

**This increment is split into 2c-1 and 2c-2, each with its own review
checkpoint (§0.1). Only 2c-1 is approved to implement right now.**

**2c-1 — approved, implement now:**

- Accounting periods: create, list, close (`finance.admin`), with the
  period-overlap race mapped to a clean `409` (§3, §0.1).
- Journal entries: create draft, list, get, edit draft, delete draft
  (`finance.poster`) — no posting, no numbering, no reversal.
- Account validation (existence, active, same tenant+entity) at draft
  create and edit time.
- RBAC exactly per proposal §7, for the routes in scope for 2c-1.
- Audit logging exactly per proposal §9, for the routes in scope for
  2c-1.
- Tenant/legal-entity isolation on every 2c-1 route, with adversarial
  tests.

**2c-2 — documented here for the design record, NOT approved, NOT to be
implemented as part of this work:**

- Posting: `POST /journal-entries/:id/post`, full validation chain from
  proposal §3, atomic race-free numbering, and the row-locking
  concurrency fix from §0.1/§5.1.
- Reversal: `POST /journal-entries/:id/reverse`, full business-rule set
  from proposal §2.
- The posting-time re-validation of account ownership (§7 below).
- The concurrent-POST adversarial test (§11).

Out (unchanged from the proposal, not being reconsidered here):

- General Ledger read layer (account ledger, balance, trial balance) —
  2d, a separate increment and commit.
- Everything in proposal §11 (AP/AR, reconciliation, multi-currency
  conversion, period reopening, reversal-of-reversal, cross-legal-entity
  user access, materialized balances, etc.).

---

## 2. New files

```
services/sphere-finance/src/
  auth/
    finance-auth.module.ts                 # new — see §2.1
  accounting-periods/
    accounting-periods.module.ts
    accounting-periods.service.ts
    accounting-periods.controller.ts
    dto/create-accounting-period.dto.ts
  journal-entries/
    journal-entries.module.ts
    journal-entries.service.ts
    journal-entries.controller.ts
    dto/create-journal-entry.dto.ts
    dto/create-journal-line.dto.ts
    dto/update-journal-entry.dto.ts
    dto/reverse-journal-entry.dto.ts
```

Modified:

- `src/app.module.ts` — register the two new modules.
- `src/db/db.ts` — add `legalEntities` (db-core, read-only) to Finance's
  schema union, same pattern as `auditLogs`, for currency resolution
  (§4.1).
- `noryx.module.json` — `requiredRoles` gains `"finance.poster"`.

**`src/accounts/accounts.module.ts` is NOT modified** — per §0.1's
decision, `AccountsModule` keeps its own existing inline
`PassportModule`/`JwtStrategy` registration exactly as it is today. Only
the two new 2c-1 modules use the shared module below.

### 2.1 Shared auth wiring for the new modules only: `FinanceAuthModule`

```ts
// src/auth/finance-auth.module.ts
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class FinanceAuthModule {}
```

`AccountingPeriodsModule` and `JournalEntriesModule` import this so the
same two lines aren't tripled across three modules. `AccountsModule`
does not import it and is not touched — no regression surface added to
already-approved 1b/2a code. If a real need to unify all three later
arises, that's a separate, explicitly-scoped refactor, not part of 2c.

---

## 3. Accounting periods

Straightforward CRUD, `finance.admin` only, same shape as `AccountsService`:

```ts
create(tenantId, legalEntityId, actorUserId, dto: CreateAccountingPeriodDto)
list(tenantId, legalEntityId)
close(tenantId, legalEntityId, actorUserId, id)
```

`CreateAccountingPeriodDto`: `code` (string, 1–50), `startDate`,
`endDate` (ISO date strings, `endDate` after `startDate` — checked in the
DTO so a malformed range gets a clean 400 before ever reaching Postgres).

`create()` does a friendly pre-check — `SELECT` for any existing period
for this `(tenantId, legalEntityId)` whose range overlaps the requested
one — and returns a clean `409 Conflict` naming the conflicting period if
found. The real guarantee is still the `EXCLUDE USING gist` constraint
from 2b (proposal §5); the pre-check exists only for a better error
message when there's no race.

**Corrected per §0.1: no raw Postgres error may escape the API when the
pre-check misses a race.** The insert is wrapped in a catch that
inspects the thrown error's Postgres `code` (SQLSTATE) — `23P01`
(`exclusion_violation`, the overlap constraint) or `23505`
(`unique_violation`, the `(tenant_id, legal_entity_id, code)` constraint)
— and re-throws as a `ConflictException` (`409`) with a friendly message
instead of letting the raw driver error propagate. Any other error code
still propagates untouched (an unrelated failure should not be
mislabeled as a period conflict). Using the `postgres` package's own
`PostgresError` class for the `instanceof` check (already a direct
dependency, same package the raw-SQL e2e tests already use):

```ts
import { PostgresError } from "postgres";

try {
  const [created] = await tx.insert(accountingPeriods).values({ ... }).returning();
  // ... audit insert, return
} catch (err) {
  if (
    err instanceof PostgresError &&
    (err.code === "23P01" || err.code === "23505")
  ) {
    throw new ConflictException(
      "This period's date range overlaps an existing period for this legal entity.",
    );
  }
  throw err;
}
```

This closes the exact race the friendly pre-check can't: two concurrent
`create()` calls both pass the pre-check (neither sees the other's
not-yet-committed row), both attempt the insert, one commits, and the
loser now gets a clean `409` from this catch instead of a raw
`PostgresError` reaching the API's exception filter. New adversarial
e2e test: two concurrent `POST /accounting-periods` requests with
overlapping ranges for the same legal entity — exactly one succeeds
(`201`), the other gets `409`, and no raw driver error is ever visible
in the response body (`AllExceptionsFilter`'s generic 500 shape would be
the tell if this weren't handled).

`close()`: loads the period scoped to `(tenantId, legalEntityId)`, 404 if
not found, `409` if already `CLOSED`, else `UPDATE ... SET status =
'CLOSED', closed_at = now(), closed_by = actorUserId`. Audit `CLOSE`.

No `reopen`. Not in scope, per the approved proposal.

---

## 4. Journal entries — draft CRUD

### 4.1 Create

```ts
create(tenantId, legalEntityId, actorUserId, dto: CreateJournalEntryDto)
```

`CreateJournalEntryDto`:

- `transactionDate: string` (ISO date, required)
- `memo?: string`
- `lines: CreateJournalLineDto[]` — **no minimum length enforced here.**
  The proposal is explicit that DRAFT is not required to balance or have
  ≥2 lines mid-edit; that check belongs solely to posting (§3 step 3
  below). A caller can create a bare header with zero or one line and
  fill it in later via `PATCH`.

`CreateJournalLineDto`:

- `accountId: string` (UUID, required)
- `debitMinor: number` (int, `>= 0`, required)
- `creditMinor: number` (int, `>= 0`, required)
- `description?: string`
- **No `lineNumber` field.** The service assigns `1..N` from array order,
  ignoring any client input. This is a deliberate simplification: the DB
  has `UNIQUE(journal_entry_id, line_number)` (2b correction #3) — if
  clients supplied their own numbers, a client mistake (duplicate or
  gap) would surface as a raw constraint violation instead of a clean
  validation error, and there's no legitimate reason a client needs to
  control this value. Re-ordering lines is done by resending the full
  array in a new order via `PATCH` (§4.3).

DTO-level validation mirrors, but does not replace, the DB CHECK
constraints from 2b — the same "clean 4xx instead of raw constraint
violation" principle the proposal already applies to period overlap
(§5): a class-validator rule rejects a line where both `debitMinor` and
`creditMinor` are zero, and one where both are positive, with the exact
same semantics as `journal_lines_nonzero` and `journal_lines_single_sided`.
The DB constraints remain the real backstop; this is only a better error
message.

**Account validation happens at create time, not deferred to posting**:
each line's `accountId` must resolve to an existing, active
`chart_of_accounts` row in the caller's own `(tenantId, legalEntityId)` —
checked with the same explicit `and(eq(tenantId), eq(legalEntityId),
eq(id), eq(isActive, true))` predicate `AccountsService` already uses.
This is a service-layer design choice beyond the literal minimum the
proposal's §3 posting-checklist states (which only requires this at
`post` time) — I'm proposing it run at create/edit time too, so a
caller gets an immediate, specific 400 ("account X does not belong to
this legal entity" / "account X is archived") instead of building an
entire draft around a bad account reference and only discovering it at
`post`. It does not weaken anything §3 requires at posting — posting
re-validates independently in the same transaction, since the account
could have been archived between draft creation and posting.

`currencyCode` is **never client-supplied** — resolved server-side from
the caller's own `legalEntities.currencyCode` row (proposal §1.6: "fixed
to the legal entity's functional currency at creation"). This requires
adding `legalEntities` to Finance's Drizzle schema union in `db.ts`
(read-only — Finance does not migrate or write this table, exactly the
same relationship it already has with `auditLogs`).

Header + all lines insert in one `withTenant()` transaction; `status`
defaults to `DRAFT`, `journalNumber` stays `NULL`. Audit `CREATE` on
`entityType: "journal_entry"`, `afterState` including the embedded line
array (proposal §9).

### 4.2 List / get

`list(tenantId, legalEntityId, filters)` — filters: `status?`,
`periodId?`, `dateFrom?`/`dateTo?` (against `transactionDate`). Always
scoped by both `tenantId` and `legalEntityId`, same as `AccountsService`.

`findOne(tenantId, legalEntityId, id)` — entry + its lines
(`ORDER BY line_number`), 404 if not found in scope. This is also the
function `post()` and `reverse()` reuse internally to load their target —
which is precisely what makes "reversal target must be same tenant/same
legal entity" structurally impossible to violate rather than merely
checked (§6.3).

### 4.3 Edit (`PATCH`) and delete — DRAFT only

`update(tenantId, legalEntityId, actorUserId, id, dto: UpdateJournalEntryDto)`:

- 404 if not found in scope; `409 Conflict` ("cannot edit a posted
  journal entry") if `status !== 'DRAFT'`.
- `UpdateJournalEntryDto` fields are all optional: `transactionDate?`,
  `memo?`, `lines?`.
- Header fields are patched individually if present.
- **`lines`, if present, fully replaces the existing line set** (delete
  all existing lines for this entry, re-insert the new array with fresh
  `1..N` numbering) inside the same transaction, rather than offering
  line-level add/remove/reorder endpoints. This keeps the API surface
  exactly what proposal §6 already lists (no `/lines` sub-resource) and
  keeps the "is this draft internally consistent" question answerable by
  looking at one PATCH body instead of reconciling a sequence of partial
  edits. If `lines` is omitted, existing lines are left untouched.
- Same account-ownership/active validation as create, applied to
  whichever lines are being written.
- Audit `UPDATE`, `beforeState`/`afterState` each including their full
  line snapshot.

`remove(tenantId, legalEntityId, actorUserId, id)`:

- 404 if not found in scope; `409 Conflict` if `status !== 'DRAFT'`
  ("cannot delete a posted journal entry" — posted-entry immutability
  already makes this impossible at the DB layer via the trigger; this is
  the friendly application-layer error in front of it).
- Hard delete; `journal_lines` rows cascade via the existing
  `onDelete: "cascade"` FK.
- Audit `DELETE`, `beforeState` = full snapshot including lines,
  `afterState: null`.

---

## 5. Posting — `POST /journal-entries/:id/post`

**Not part of 2c-1. Documented here as the approved design for 2c-2,
which is not being implemented now (§0.1).**

### 5.1 Concurrency correction (required for 2c-2, per §0.1)

The sequence originally proposed — load, validate, allocate, update — has
a race: two simultaneous `POST .../post` calls can both load the same
row while it's still `DRAFT`, both pass the status check, and both
proceed to allocate a number and post. The counter table's own atomicity
(2b) still guarantees the two allocated numbers are distinct, but nothing
in the originally-proposed sequence stops _both_ requests from
successfully transitioning the same row to `POSTED` — the second
`UPDATE` would simply overwrite the first's `journal_number` with its own,
leaving the entry posted twice over with only the second attempt's
number surviving and the first silently discarded.

The fix: step 2 below becomes `SELECT ... FOR UPDATE` scoped to
`(id, tenantId, legalEntityId)`, taken as the very first statement inside
the transaction, before any validation runs. Postgres row-locks the
entry for the duration of the transaction; a second concurrent `post()`
call for the same row blocks on that `SELECT ... FOR UPDATE` until the
first transaction commits or rolls back, then proceeds against the
now-current row — which the status check (step 3) will correctly see as
`POSTED` and reject with `409`. This requires no new schema or trigger;
it's purely how the posting transaction acquires its starting row.

One `withTenant()` transaction, validating in exactly the order proposal
§3 specifies (step 2 updated per the correction above):

1. **RBAC** — enforced by `@Roles("finance.poster")` on the controller
   route, before the service method is even called.
2. **Load + lock + scope** — `SELECT ... FOR UPDATE` scoped to
   `(id, tenantId, legalEntityId)`; 404 if not found in the caller's own
   scope (never leaks existence across tenants/entities). This is the
   first statement in the transaction, ahead of every check below, per
   §5.1.
3. **`status === 'DRAFT'`** — else `409 Conflict`
   ("journal entry is already posted" / whatever its actual status is).
   Matches the proposal's explicit "not idempotent silently" instruction.
4. **`lines.length >= 2`** — else `422 Unprocessable Entity`.
5. **`SUM(debitMinor) === SUM(creditMinor)`** across all lines — else
   `422`. This is an application-layer check computed from the
   already-loaded lines; the DB's deferred constraint trigger (2b §3) is
   the backstop that fires regardless of whether this application check
   is ever bypassed.
6. **Every line's account, re-validated** — active, and belongs to this
   entry's own `(tenantId, legalEntityId)` — re-checked here even though
   §4.1/§4.3 already checked it at create/edit time, because an account
   can be archived (or, in principle, a line's data corrupted by a bug
   elsewhere) between draft creation and posting. This is the one
   proposal explicitly calls "particularly important" — detailed in §6
   below with its own adversarial test list. Failure → `422`, with an
   error message that names the offending line but does **not** reveal
   whether the account exists in a different tenant/entity (see §6.4).
7. **Period resolution** — `SELECT * FROM accounting_periods WHERE
tenant_id = $1 AND legal_entity_id = $2 AND start_date <=
$transactionDate AND end_date >= $transactionDate`. No covering
   period → `422` ("no accounting period covers this transaction date").
   Covering period `CLOSED` → `422` ("accounting period {code} is
   closed"). `periodId` is never client-supplied — always resolved here,
   matching the schema doc comment ("Resolved from transactionDate at
   posting time — never client-supplied").
8. **Atomic journal number allocation** — the exact
   `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement from
   2b's counter table, in the same transaction, formatted
   `JE-{n:06d}`.
9. **Commit the transition** — a single
   `UPDATE journal_entries SET status = 'POSTED', journal_number = $n,
period_id = $periodId, posted_at = now(), posted_by = $actorUserId
WHERE id = $id` — deliberately not touching `updated_at` or any other
   column, both because there's no reason to and because this statement
   runs while `OLD.status = 'DRAFT'` so the posted-immutability trigger
   doesn't even apply to it yet (it only starts protecting the row after
   this statement commits).
10. **Audit** — `POST` on `entityType: "journal_entry"`, `afterState`
    capturing the now-immutable snapshot including the newly-assigned
    `journal_number`, same transaction.

A failure at any step rolls the whole transaction back — no burned
journal number from a failed post (2b's counter allocation is inside the
same transaction as everything else, per proposal §3 step 7's existing
note).

---

## 6. Reversal — `POST /journal-entries/:id/reverse`

**Not part of 2c-1. Documented here as the approved design for 2c-2,
which is not being implemented now (§0.1).**

`ReverseJournalEntryDto` (all optional): `transactionDate?` (defaults to
"now"), `memo?` (defaults to `"Reversal of {originalJournalNumber}"`).

Same concurrency reasoning as §5.1 applies here: reversal also transitions
state on the original row (`reversedByJournalEntryId` NULL → value), so
step 1 below is also a `SELECT ... FOR UPDATE`, not a plain `SELECT` —
two simultaneous `POST .../reverse` calls against the same original must
not both pass the "not already reversed" check. This will get its own
adversarial test alongside the concurrent-POST test in §11.

One `withTenant()` transaction:

1. **Load + lock + scope** — `SELECT ... FOR UPDATE` scoped to
   `(id, tenantId, legalEntityId)` for the target. 404 if not found in
   the caller's own scope. **This is the
   mechanism that satisfies "reversal target must be the same tenant and
   same legal entity" — not an extra runtime check on a separately
   supplied target-tenant/entity value, because there is no such value.
   The only way to name a reversal target at all is this URL's `:id`,
   and that id is always resolved through a query already scoped to the
   caller's own tenant and legal entity.** §6.3 has the adversarial test
   proving this can't be bypassed.
2. **`status === 'POSTED'`** — else `422` ("only a posted entry can be
   reversed").
3. **`reversedByJournalEntryId IS NULL`** — else `409 Conflict`
   ("this entry has already been reversed").
4. **`reversalOfJournalEntryId IS NULL`** — else `422`
   ("cannot reverse a reversal; reversal-of-reversal requires a
   dedicated correction workflow, not yet built" — matches proposal §2
   rule 3 exactly, including the stated rationale).
5. **Resolve the reversal's own period** — same logic as posting step 7,
   applied to the reversal's own `transactionDate` (default "now"),
   independent of the original's period or its open/closed state. No
   covering open period → `422`.
6. **Build reversal lines** — same `accountId`s and amounts as the
   original, `debitMinor`/`creditMinor` swapped, same relative order
   (fresh `1..N` numbering, independent of the original's numbering).
7. **Insert the reversal's header** — `legalEntityId`/`tenantId`/
   `currencyCode` copied from the original, `transactionDate` as
   resolved, `memo` as resolved, `reversalOfJournalEntryId` = original's
   id, `status` starts `DRAFT` internally within this same transaction.
8. **Insert reversal lines.**
9. **Allocate the reversal's own journal number** — the same atomic
   counter mechanism as ordinary posting; **never derived from or related
   to the original's number.**
10. **Post the reversal** — `UPDATE` the reversal row to `POSTED`,
    `posted_at`, `posted_by`, `period_id` — same shape as posting step 9.
11. **Link the original** — `UPDATE journal_entries SET
reversed_by_journal_entry_id = $reversalId WHERE id = $originalId`
    — **this statement sets exactly one column, nothing else**, both
    because that's the only legitimate mutation and because the 2b
    correction made `updated_at` immutable too — any implementation that
    spreads other fields (including `updated_at`) into this `UPDATE`
    will be rejected by the trigger, which is the intended enforcement,
    not a bug to work around.
12. **Audit** — a `REVERSE` row against the **original** entity
    (recording the linkage event), plus the reversal's own `CREATE` and
    `POST` audit rows against the **new** entity, per proposal §9. All
    of steps 1–12 commit atomically or none do (proposal §2 rule 5).

The original entry is never touched in any other way — its
`transactionDate`, `periodId`, lines, and every other field remain
exactly as posted, regardless of whether its own period has since
closed. This falls out naturally from steps above never writing to it
except step 11's single-column update; there's no special-case logic
needed to "leave it alone."

Once posted, the reversal entry is just an ordinary `POSTED` journal
entry — immune to further reversal by rule 4 above, and immutable under
the same trigger as any other posted entry. No special-case code needed
for that either.

---

## 7. Cross-tenant / cross-legal-entity validation — the 2b→2c handoff

This is the item flagged as particularly important, both in the 2b
review and in your message starting this increment. Restating the
guarantee precisely, since 2b's own doc comments say it must not be left
ambiguous:

**What 2b's database layer does NOT guarantee** (by design — deferred
here): that a `journal_lines.account_id` belongs to the same tenant and
legal entity as its parent `journal_entries` row. The FK only proves the
account row exists somewhere in `chart_of_accounts`, full stop. Tenant
RLS alone does not catch a same-tenant, different-legal-entity mismatch,
because legal-entity isolation is deliberately app-layer only (2a's
architecture, reaffirmed through 2b).

**What 2c must guarantee, and how:**

**§7.1's create/edit-time enforcement is part of 2c-1. §7.1's
posting-time re-verification, and all of §7.3, are part of 2c-2 (not
implemented now).**

### 7.1 Journal ↔ Account (same tenant + same legal entity)

Enforced at both create/edit time (§4.1/§4.3 — **2c-1**) and,
independently, re-verified at posting time (§5 step 6 — **2c-2**) — every
line's `accountId` is
looked up with an explicit `and(eq(chartOfAccounts.id, accountId),
eq(chartOfAccounts.tenantId, tenantId), eq(chartOfAccounts.legalEntityId,
legalEntityId), eq(chartOfAccounts.isActive, true))` predicate, using
the entry's own `tenantId`/`legalEntityId` (from the JWT-derived caller
context that owns this entry) — never the account's own claimed
tenant/entity fields, and never trusting a client-supplied "this account
is fine" assumption.

### 7.2 Journal ↔ Period (same tenant + same legal entity)

Structurally guaranteed rather than checked: `periodId` is never
client-supplied (§5 step 7, §6.5) — it is always resolved by querying
`accounting_periods` scoped to the entry's own `(tenantId,
legalEntityId)`. There is no code path where a period belonging to a
different tenant or legal entity could ever be attached to a journal
entry, because the query that finds it is scoped before it runs, not
filtered after.

### 7.3 Reversal ↔ original (same tenant + same legal entity)

As detailed in §6 step 1: the reversal target is only ever reached
through a tenant-and-entity-scoped lookup. There is no separate
"targetTenantId"/"targetLegalEntityId" input to validate against,
because the API surface never accepts one.

### 7.4 Information disclosure

Every rejection in §7.1–7.3 (and 404s generally) uses a message that
states what's wrong from the caller's own perspective ("account {id} is
not an active account in this legal entity", "no journal entry found
with id {id}") and never confirms or denies that a matching row exists
in a different tenant or legal entity. This matches the existing 1b/2a
convention (`AccountsService.findOne` already does this — a
cross-tenant lookup is a plain 404, not "exists elsewhere").

### 7.5 Required adversarial tests

**2c-1 (implement now):**

- Create/edit a draft in Tenant A / Entity A referencing an account that
  exists only in Tenant A / Entity B → rejected (400), zero effect.
- Create/edit a draft in Tenant A / Entity A referencing an account that
  exists only in Tenant B → rejected (400), zero effect.
- Attempt to get/edit/delete a journal entry belonging to a different
  tenant, by id, using a caller authenticated for Tenant A → 404 (not
  403 — matches the existing cross-tenant convention of not confirming
  existence).
- Attempt to get/edit/delete a journal entry belonging to a different
  legal entity within the **same** tenant → 404, proving legal-entity
  scoping isn't silently bypassed just because RLS already let the
  tenant boundary through.
- Mirrors `accounts.e2e-spec.ts`'s existing "cross-legal-entity
  isolation" describe block, extended to every 2c-1 route.

**2c-2 (deferred, not implemented now):**

- Post a journal in Tenant A / Entity A referencing an account that
  exists only in Tenant A / Entity B (added to the draft after it passed
  2c-1's create-time check, then the account is cross-entity — or the
  account was valid at create time and later archived/moved) → rejected
  (422), zero effect.
- Post a journal in Tenant A / Entity A referencing an account that
  exists only in Tenant B → rejected (422), zero effect.
- Attempt to reverse a journal entry belonging to a different tenant/
  legal entity → 404.
- Attempt to post/reverse across tenant and cross-entity boundaries
  generally.

---

## 8. API surface

Exactly as proposal §6 already specifies — reproduced here for
completeness, nothing new added or removed. Routes marked `2c-2` are not
implemented in this increment; calling them will 404 at the routing
level (the routes don't exist yet) until 2c-2 is separately approved and
built.

```
POST   /accounting-periods               create                    finance.admin    2c-1
GET    /accounting-periods               list                      any finance.* role  2c-1
PATCH  /accounting-periods/:id/close     OPEN → CLOSED              finance.admin    2c-1

POST   /journal-entries                  create DRAFT               finance.poster   2c-1
GET    /journal-entries                  list                       any finance.* role  2c-1
GET    /journal-entries/:id              detail incl. lines         any finance.* role  2c-1
PATCH  /journal-entries/:id              edit — DRAFT only          finance.poster   2c-1
DELETE /journal-entries/:id              delete — DRAFT only        finance.poster   2c-1
POST   /journal-entries/:id/post         DRAFT → POSTED             finance.poster   2c-2 (not built yet)
POST   /journal-entries/:id/reverse      POSTED → new posted entry  finance.poster   2c-2 (not built yet)
```

HTTP status conventions used throughout (consistent with `AccountsService`'s
existing use of Nest's built-in exceptions):

| situation                                                                                                                    | status |
| ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| resource not found in caller's own tenant+entity scope                                                                       | 404    |
| DTO validation failure (`class-validator`)                                                                                   | 400    |
| state conflict (already posted, already reversed, already closed)                                                            | 409    |
| business-rule/invariant failure (unbalanced, wrong line count, closed/missing period, invalid account, reversal-of-reversal) | 422    |

---

## 9. RBAC

Exactly proposal §7's table — reproduced for the review checkpoint:

| routes                                                                               | roles                                                     | increment |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------- |
| all `GET` routes above                                                               | `finance.viewer`, `finance.poster`, `finance.admin` (any) | 2c-1      |
| `POST /journal-entries`, `PATCH /journal-entries/:id`, `DELETE /journal-entries/:id` | `finance.poster` only                                     | 2c-1      |
| `POST /journal-entries/:id/post`, `POST /journal-entries/:id/reverse`                | `finance.poster` only                                     | 2c-2      |
| `POST /accounting-periods`, `PATCH /accounting-periods/:id/close`                    | `finance.admin` only                                      | 2c-1      |

`finance.admin` is not added to any journal-mutation route — same
mechanism as before (simply never listed in that route's `@Roles()`),
no new guard logic needed. `noryx.module.json`'s `requiredRoles` grows to
include `finance.poster` (§2).

---

## 10. Audit logging

Exactly proposal §9:

- `CREATE` / `UPDATE` / `DELETE` on `entityType: "journal_entry"` — full
  line set embedded in `beforeState`/`afterState`. **2c-1.**
- `CLOSE` on `entityType: "accounting_period"`. **2c-1.**
- `POST` on `entityType: "journal_entry"` — `afterState` includes the
  assigned `journal_number`. **2c-2, not implemented now.**
- `REVERSE` on `entityType: "journal_entry"` — one row against the
  original (the linkage), plus the reversal's own `CREATE`+`POST` rows.
  **2c-2, not implemented now.**

All same-transaction writes, same shared `db-core` `auditLogs` table,
same pattern `AccountsService` already established.

---

## 11. Test plan

Extends `journal-engine-db-constraints.e2e-spec.ts`'s and
`accounts.e2e-spec.ts`'s patterns — new file(s)
`test/journal-entries.e2e-spec.ts` and
`test/accounting-periods.e2e-spec.ts`, real Postgres, synthetic JWTs,
`supertest`.

**2c-1 (implement and pass now):**

- RBAC matrix: every 2c-1 route × `finance.viewer`/`finance.poster`/
  `finance.admin` (and no-role), per §9's table.
- Cross-tenant isolation on every 2c-1 route (list/get/edit/delete/close
  all 404 or no-op across tenants, zero effect verified).
- Cross-legal-entity isolation on every 2c-1 route, within the same
  tenant (§7.5's 2c-1 list).
- Draft lifecycle: create with 0/1/N lines, edit replaces lines
  correctly, delete removes lines (cascade), none of this requires
  balance.
- Account validation at create/edit time: nonexistent, inactive,
  wrong-entity, wrong-tenant account all rejected with a clean 400 and
  zero effect (§7.5's 2c-1 list).
- Accounting periods: create, list, close; `finance.admin`-only
  enforcement; `close()` rejects an already-`CLOSED` period with `409`.
- **Concurrent period creation** (§0.1/§3 correction): two simultaneous
  `POST /accounting-periods` requests with overlapping date ranges for
  the same legal entity — assert exactly one `201` and one `409`, and
  that the `409` response body contains no raw Postgres error text
  (i.e., it went through the `PostgresError` catch, not
  `AllExceptionsFilter`'s generic 500 path).
- Unit tests: DTO validation for `CreateJournalEntryDto`/
  `CreateJournalLineDto` (line-level single-sided/nonzero pre-checks,
  malformed dates, missing required fields) and
  `CreateAccountingPeriodDto` (`endDate` after `startDate`) — mirrors
  `create-account.dto.spec.ts`.

**2c-2 (documented now, implemented and tested only once 2c-2 is
separately approved):**

- Posting validation chain, one test per §5 step: <2 lines rejected,
  unbalanced rejected, inactive/wrong-entity/wrong-tenant account
  rejected, no covering period rejected, closed covering period
  rejected, already-posted rejected, successful post assigns a correctly
  formatted sequential `journal_number` and the right `period_id`.
- **Concurrent posting** (§0.1/§5.1 correction, required acceptance
  criterion, not optional): two simultaneous
  `POST /journal-entries/:id/post` requests against the same `DRAFT`
  entry — assert exactly one `200` (successfully posted), exactly one
  `409` (the loser, correctly seeing `status = POSTED` after the winner's
  transaction commits and its own lock is released), exactly one
  assigned `journal_number` on the entry (not overwritten by a second
  attempt), and exactly one `POST` audit event — not two.
- **Concurrent reversal** (same reasoning as concurrent posting, applied
  to `POST /journal-entries/:id/reverse` against the same original):
  exactly one reversal created, exactly one `reversed_by_journal_entry_id`
  linkage, the loser gets `409` ("already reversed").
- Reversal, one test per §2/§6 rule: reversing a non-posted entry
  rejected, reversing an already-reversed entry rejected, reversing a
  reversal rejected, successful reversal gets its own number/date,
  resolves against the _currently open_ period even when the original's
  period is now closed, original entry unchanged except the linkage,
  swapped debit/credit on matching accounts, atomicity (a forced failure
  partway through leaves neither the reversal nor the linkage
  committed — same pattern as the 2b balance-invariant transaction test).
- §7.5's 2c-2 adversarial test list (posting-time cross-entity/tenant
  account checks, reversal cross-tenant/entity checks).

---

## 12. Sequencing — approved

- **2c-1 (this commit, implement now)**: `FinanceAuthModule` for the two
  new modules only (`AccountsModule` untouched), accounting periods CRUD
  with the period-overlap race mapped to `409`, journal entry draft CRUD
  (create/list/get/edit/delete) with account validation at create/edit
  time, RBAC, audit logging, full e2e for all of the above. No posting or
  reversal yet — an entry can be drafted but never posted; the `/post`
  and `/reverse` routes do not exist yet.
- **2c-2 (separate, future, requires its own review before starting)**:
  posting (§5, with the `SELECT ... FOR UPDATE` concurrency fix from
  §5.1) and reversal (§6, same fix applied to its own row lock), the
  posting-time cross-entity re-validation (§7.1/§7.5's 2c-2 list), and
  the concurrent-posting/concurrent-reversal adversarial tests (§11).

This mirrors the 1a/1b and 2a/2b pattern of separating lower-risk
scaffolding from the higher-risk invariant-critical logic. 2c-2 will get
its own proposal-review cycle before any of it is written, exactly like
this one.

---

## Decisions log (superseded "Open items")

All four original open items plus the two corrections were resolved in
review (§0.1). Nothing here remains open for 2c-1:

1. **`FinanceAuthModule`** — used by the two new modules only;
   `AccountsModule` is not touched.
2. **Account validation on drafts** — enforced at create and edit time
   (2c-1), independently re-verified at posting time (2c-2, not
   implemented now).
3. **`PATCH` line replacement** — full-array replacement when `lines` is
   present; no `/lines` sub-resource.
4. **Sequencing** — split into 2c-1/2c-2, per §12.
5. **Concurrent posting** (correction) — `SELECT ... FOR UPDATE` required
   in 2c-2's design (§5.1); not applicable to 2c-1 since 2c-1 has no
   posting.
6. **Period-overlap race** (correction) — `PostgresError` code-based
   catch mapping to `409`, required in 2c-1 (§3) since accounting periods
   are in scope now.

2c-1 implementation begins now.
