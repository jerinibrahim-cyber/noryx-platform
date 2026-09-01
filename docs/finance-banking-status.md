# Sphere Finance — Banking Baseline

**Baseline commit:** `f7fd9adbf28709492a05bbc4c895cc63736e4784`

This document is the authoritative status record for the Banking track at the
September 2026 documentation baseline. It is intentionally additive: it does
not rewrite historical work-item proposals.

## Banking track status

| Work item | Capability | Status | Verified implementation commit |
| --- | --- | --- | --- |
| Banking-1a | Bank / Cash Account Master | COMPLETE | `f750406` |
| Banking-1b | Bank Transactions | COMPLETE | `6993993` |
| Banking-1c | Bank Statement Import & Reconciliation | COMPLETE | `0914de3` + subsequent main-branch corrections |
| Banking-1d | Cash Position / Bank-Cash Statement / Unreconciled Transactions | COMPLETE | `91a9770` + `c6ed76f` GL-completeness correction |
| Banking-1e | Payment Provider Settlement Import & Reconciliation | COMPLETE | `f7fd9ad` |

## Banking-1e implementation facts

The Banking-1e commit adds a first-class Payment Provider Settlement domain
alongside the existing Banking-1c reconciliation domain. The implementation
contains:

- `payment_provider_settlement_imports`
- `payment_provider_settlements`
- `payment_settlement_matches`
- explicit Bank/Cash Account `purpose`: `OPERATING` or `CLEARING`
- settlement arithmetic enforcement: `gross - fee + adjustment = net`
- settlement-level `providerSettlementId` uniqueness
- import file-hash idempotency
- tenant RLS and legal-entity service predicates
- completed-reconciliation immutability triggers
- deterministic and manual settlement matching
- DRAFT-only settlement transaction creation using the existing
  `BankTransactionsService`
- Clearing Account Reconciliation reporting from GL movement
- reconciliation completion requiring both matching completeness and GL-based
  balance reconciliation

The commit explicitly leaves POS/provider-transaction ingestion, provider APIs
or webhooks, provider-specific adapters beyond the generic MVP contract,
and chargeback/refund lifecycle out of scope.

## Verification recorded for Banking-1e

The implementation commit records:

- 534/534 unit tests passing
- 35 Banking-1e e2e tests passing
- 755/755 full e2e tests passing twice consecutively
- 118 routes across 22 controllers in the route-role matrix
- independent PostgreSQL checks for RLS isolation, immutability,
  arithmetic constraints, idempotency constraints, and audit-log counts

These numbers are historical verification recorded by the implementation
commit; they are not a claim of a fresh test run in this documentation update.

## Roadmap interpretation

Banking-1a through Banking-1e are **completed historical roadmap work**.
The generic Banking & Cash capability is therefore not a future/unstarted
area. Future work should be described as extensions or new capabilities rather
than relabeling 1a–1e as planned.

Banking-1e does **not** imply that all payment-provider functionality is
complete. The following remain explicitly outside the implemented 1E scope:

- provider-specific API/webhook integrations
- additional provider-specific settlement formats without real evidence/files
- POS-level payment-activity ingestion
- provider-transaction-level reconciliation
- chargeback/refund lifecycle as a first-class flow
- automatic non-human-confirmed matching or posting
- deeper AP/AR linkage beyond the configuration already supported

## Accounting boundary

GL remains the accounting authority. Settlement reconciliation is an
observational/linking process; it does not introduce a second accounting or
posting engine. Where settlement transaction convenience is used, the
implementation creates DRAFT bank transactions and does not post them
automatically.

## Documentation correction required

`docs/finance-work-item-banking-1e-proposal.md` still contains proposal-only
status language even though its implementation is now present in
`f7fd9ad`. That historical proposal should be updated in a future surgical
edit so that its status clearly reads **IMPLEMENTED**, while retaining the
proposal/design history.

Likewise, the Banking & Cash checklist in `docs/roadmap.md` is stale where it
marks Banking-1a through 1e capabilities as planned/unstarted. This baseline
record is added first so the repository has an unambiguous, evidence-backed
status source without reconstructing or replacing the full existing roadmap.
