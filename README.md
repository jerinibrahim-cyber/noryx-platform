# Noryx Platform

Monorepo for **Noryx Sphere** (ERP · CRM · HRMS) and **Noryx Orbis** (CAFM ·
FM Intelligence) — two products on one shared, multi-tenant services layer.

This is the Phase 0 foundation: the pieces every later module (Finance,
Procurement, HRMS, CRM, Helpdesk & Work Orders, PPM, SLA/Command Centre,
and everything after) builds on top of, not the modules themselves. See
[`docs/roadmap.md`](docs/roadmap.md) for what's built vs. what's next.

## Repo layout

```
apps/            Frontend applications
  web/             React + TypeScript web app shell (@noryx/ui-kit, react-router)
services/        Independently deployable backend services
  identity/        Auth: OAuth2/OIDC-shaped login, MFA, tenant-aware JWTs
  api-gateway/     The one internet-facing door — module-manifest-based routing
packages/        Shared libraries, depended on via pnpm workspace protocol
  db-core/         Drizzle schema (Tenant, Legal Entity, User, Subscription,
                   Audit Log), Row-Level Security policies, tenant context
  shared-types/    Cross-service TypeScript contracts — API envelope, JWT
                   claims, event envelopes, the ModuleManifest plug-and-play type
  event-bus-client/  Pluggable pub/sub — in-memory adapter for dev/tests,
                     Azure Service Bus adapter for staging/production
  ui-kit/          Design system — tokens, runtime tenant theming, base components
  eslint-config/   Shared lint rules (includes eslint-plugin-security)
infra/           Dockerfiles live with their services; Kubernetes/Terraform
                 skeletons live here as they're built out
docs/            Architecture/process notes that live in-repo (not the
                 earlier design deliverables — see "Design history" below)
.github/         CI pipeline, CODEOWNERS, Dependabot config
```

## Prerequisites

- Node.js 20+, [pnpm](https://pnpm.io) 9+ (`corepack enable && corepack prepare pnpm@9 --activate`)
- Docker (for Postgres/Redis locally, and for building service images)

## Quickstart — local dev

```bash
cp services/identity/.env.example services/identity/.env
cp services/api-gateway/.env.example services/api-gateway/.env
# edit both .env files — at minimum set matching JWT_ACCESS_SECRET values

pnpm install

# Postgres + Redis + identity + api-gateway + web, all wired together
docker compose up --build

# apply the schema + Row-Level Security policies to the running Postgres
DATABASE_URL=postgresql://noryx:noryx@localhost:5432/noryx pnpm --filter @noryx/db-core run migrate:dev
```

The web app is then at `http://localhost:5173`, the API Gateway at
`http://localhost:3000` (try `GET /health/modules` to see what's routable),
and Identity directly at `http://localhost:3001` if you need to bypass the
gateway while debugging.

For iterating on a single service without rebuilding its Docker image:

```bash
pnpm --filter @noryx/identity run dev      # ts-node-dev, hot reload
pnpm --filter @noryx/web run dev            # Vite dev server
```

## Testing

```bash
pnpm run test          # unit tests, every package (turbo run test)
pnpm --filter @noryx/identity run test:e2e
pnpm --filter @noryx/api-gateway run test:e2e
pnpm run lint
pnpm run typecheck
```

CI (`.github/workflows/ci.yml`) runs all of the above plus SAST (Semgrep),
dependency/SCA scanning, a secrets scan (gitleaks), IaC scanning
(Checkov), and — on `main` — container image builds with Trivy scanning,
image signing, and SBOM generation. See
[`docs/security.md`](docs/security.md) for the full framework this
pipeline implements.

## Adding a new module

Read [`docs/plug-and-play-modules.md`](docs/plug-and-play-modules.md)
first. In short: a new service ships a `noryx.module.json`, gets one
bind-mount line in `docker-compose.yml` for local dev, and the deploy
pipeline wires it into the gateway at release time. No gateway code
change required.

## Architecture principles (see `docs/architecture.md` for the full recap)

1. Two independently deployable products (Sphere, Orbis) on one shared
   services layer.
2. Multi-tenant by construction, single-tenant in practice today — every
   table, service, and token is tenant-aware.
3. Cloud-portable — containerized, no hard dependency on one provider's
   proprietary services.
4. API-first — the same versioned API surface serves internal UIs,
   portals, and third-party integrations.
5. Security enforced at the data layer (Postgres Row-Level Security), not
   just the application layer.
6. Event-driven core, request/response edges.
7. Every cross-service contract is versioned and written down before the
   services that depend on it are built.

## Design history

The product/architecture design work that this codebase implements —
System Architecture v1, the Design Gap Analysis, the Pre-Development
Readiness Review (competitive landscape, phased roadmap, and the security
framework CI enforces) — was produced as a separate set of documents
ahead of this repo's first commit. Ask the platform lead for copies if
they're not already in your hands; they're intentionally not duplicated
into this repo to keep design documents and code from drifting against
each other silently.

## Contributing

- Trunk-based development, short-lived feature branches, no direct pushes
  to `main`.
- `CODEOWNERS` requires two approvals on changes to Identity, the RLS
  policy SQL, and (once built) Finance/HRMS — one approval elsewhere.
- `pnpm install` sets up a pre-commit hook (Husky) running lint-staged and
  a fast local secrets pre-filter; the full gitleaks rule set runs in CI
  regardless.
