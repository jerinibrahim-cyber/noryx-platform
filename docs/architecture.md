# Architecture reference

Condensed from _Noryx Platform — System Architecture v1_. This is a
working reference for engineers in this repo, not a replacement for the
full document — see the platform lead for that if you need the full
rationale, cloud comparison, or open questions log.

## Tenancy model

Two hierarchies, not one:

- **Tenant** — a customer of Noryx. Exactly one exists today (MFS).
- **Legal Entity** — a subsidiary/branch within a tenant. Reserved from
  Phase 0 even though every tenant has exactly one today.

Every tenant-scoped table carries `tenant_id` (and, where relevant,
`legal_entity_id`) and is protected by a Postgres Row-Level Security
policy (`packages/db-core/drizzle/rls/*.sql`) — enforced by the database
engine itself, not just application code. See `packages/db-core/src/rls.ts`
(`withTenant()`) for how a service scopes a query to the caller's tenant.

## Identity tiers

| Tier                | Who                                            | Scope                                 |
| ------------------- | ---------------------------------------------- | ------------------------------------- |
| `PLATFORM_OPERATOR` | Noryx's own staff                              | Cross-tenant, administrative          |
| `TENANT_INTERNAL`   | A tenant's own employees                       | Scoped to their tenant + legal entity |
| `TENANT_EXTERNAL`   | A tenant's own customers/suppliers via portals | Scoped to only their own records      |

## Trust boundaries

- **Internal (Event Bus)** — Sphere, Orbis, and shared platform services
  talk to each other asynchronously: versioned event contracts
  (`@noryx/shared-types`'s `EventEnvelope<T>`), idempotent consumers,
  dead-letter queues. See `@noryx/event-bus-client`.
- **External (API Gateway)** — portals, mobile apps, and third-party
  integrations all come through one synchronous, versioned REST surface
  (`/v1/...`) with OAuth2-shaped tokens and rate limiting. Nothing
  external talks to an internal service directly.

## Tech stack

Node.js + TypeScript (NestJS) backend, PostgreSQL (Row-Level Security),
React + TypeScript web, React Native planned for mobile (Phase 1),
Docker + Kubernetes, a managed message broker (Azure Service Bus) with
Kafka documented as a future graduation path if volume requires it.

## Subscription & entitlement state machine

`Tenant.status` / `Subscription.status`: `ACTIVE → PAST_DUE (grace period,
full access) → SUSPENDED (read-only, entitled-module list resolves empty)
→ TERMINATED`. Enforced in `services/identity/src/auth/auth.service.ts` at
login/refresh, and at the gateway via the JWT's `modules` claim
(`services/api-gateway/src/proxy/proxy.controller.ts`).
