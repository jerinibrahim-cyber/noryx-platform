import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped tenant context, propagated via AsyncLocalStorage so every
 * downstream repository/service call in the same request sees it without
 * threading it through every function signature.
 *
 * A PLATFORM_OPERATOR request legitimately has no tenantId (cross-tenant
 * access, System Architecture v1 §3.2) — callers must check for that.
 */
export interface TenantContext {
  tenantId: string | null;
  legalEntityId?: string | null;
  userId?: string | null;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No tenant context set. Every request must be wrapped in runWithTenantContext() " +
        "before touching the database — see services/identity's TenantContextMiddleware " +
        "for the reference implementation.",
    );
  }
  return ctx;
}

export function tryGetTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** Wrap a request handler so getTenantContext() resolves inside it. */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
