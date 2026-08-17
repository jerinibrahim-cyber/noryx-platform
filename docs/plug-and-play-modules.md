# Adding a new module — the plug-and-play pattern

This is the mechanism that lets Noryx grow — a new Orbis capability, a new
Sphere module, a future third-party extension — without touching the API
Gateway's code or redeploying the platform core. It's the concrete
implementation of the "plug and play" requirement from the
Pre-Development Readiness Review.

## The contract

Every service that should be reachable through the gateway ships a
`noryx.module.json` at its package root, matching the `ModuleManifest`
type in `@noryx/shared-types`:

```json
{
  "key": "sphere-finance",
  "displayName": "Finance",
  "product": "sphere",
  "version": "0.1.0",
  "basePath": "/v1/finance",
  "serviceUrl": "http://sphere-finance:3010",
  "publishesEvents": ["sphere.finance.invoice.posted"],
  "subscribesToEvents": ["orbis.workorder.completed"],
  "requiredRoles": ["finance.viewer"],
  "healthCheckPath": "/health/ready",
  "public": false
}
```

## What happens with it

1. **Routing.** The API Gateway's `ModuleRegistryService` (`services/api-gateway/src/module-registry/`)
   loads every manifest in `NORYX_MODULES_MANIFEST_DIR` at startup and
   builds a route table keyed by `basePath`, longest-prefix-match. A
   request to `/v1/finance/invoices/123` resolves to whichever loaded
   manifest has the longest matching `basePath`.
2. **Entitlement.** `key` doubles as the entitlement key checked against
   the caller's JWT `modules` claim (issued by Identity from the tenant's
   live `Subscription.entitledModules` — see `@noryx/db-core`'s schema and
   `services/identity/src/auth/auth.service.ts`). A tenant that hasn't
   licensed a module gets a 403 at the gateway, before the request ever
   reaches the module's own service.
3. **RBAC.** `requiredRoles`, if set, is checked after entitlement — the
   caller needs at least one of the listed roles.
4. **Health-gating.** `healthCheckPath` is what the deploy pipeline (and,
   in Kubernetes, the gateway's own readiness probes) polls before routing
   real traffic to a freshly deployed instance of the module.
5. **`public: true`** exempts a module from the token/entitlement check
   entirely — reserved for the handful of routes that must work before a
   user has a token at all (Identity's own login/refresh). Set this
   deliberately; it should be rare.

## Registering a new module, step by step

1. Build the service under `services/<your-module>/` (or `apps/` for a
   frontend), following the folder shape of `services/identity` or
   `services/api-gateway` as a template — `package.json`, `tsconfig.json`
   extending the root `tsconfig.base.json`, a `Dockerfile`, and tests.
2. Add a `noryx.module.json` at the service's root, following the schema
   above.
3. **Local dev:** add one bind-mount line for it in the root
   `docker-compose.yml`'s `api-gateway` service (see the existing
   `identity.json` mount for the pattern).
4. **CI/CD:** the deploy pipeline's manifest-sync step (see
   `.github/workflows/ci.yml` and, once written, the Kubernetes deploy
   workflow) copies every deployed service's `noryx.module.json` into the
   gateway's manifest source (a ConfigMap in Kubernetes) as part of the
   release, not as a gateway code change.
5. If the module needs to publish or consume events, wire it to
   `@noryx/event-bus-client`'s `EventBus` interface (`InMemoryEventBus` in
   tests/local dev, `AzureServiceBusEventBus` in staging/production) and
   list the event types in `publishesEvents`/`subscribesToEvents` — this
   is documentation for other engineers, not runtime-enforced, but keeping
   it accurate is how the platform avoids the legacy project's "blank
   interface docs" problem (System Architecture v1 §2).
6. Add the module's entitlement `key` to the relevant `Subscription.plan`
   tiers once the Subscription & Entitlement Service's plan-to-module
   mapping exists (Phase 0/1 scope — not yet built as of this writing;
   until then, entitlement keys are granted directly on
   `Subscription.entitledModules` per tenant).

Nothing above requires editing `services/api-gateway/src/**` for a normal
new module. If you find yourself editing the gateway's own source to add
a module, that's a sign the module doesn't fit the pattern yet — fix the
pattern, don't special-case the gateway.
