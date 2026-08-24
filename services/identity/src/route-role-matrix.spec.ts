import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from "@nestjs/common/constants";
import { ROLES_KEY, JwtAuthGuard, RolesGuard } from "@noryx/auth-core";
import { AuthController } from "./auth/auth.controller";

/**
 * Milestone 3.2 — Route → Required-Role Matrix Hardening
 * (docs/hardening/milestone-3.2-route-role-matrix-proposal.md §4a).
 *
 * A single source of truth for every route on every controller in this
 * service, proven exhaustively against live NestJS reflection metadata
 * rather than a hand-maintained list assumed correct — the RBAC analogue
 * of Milestone 3.1's RLS drift-guard test, which queried the live
 * Postgres catalog instead of trusting a remembered table list.
 *
 * Deliberately keeps *authentication* and *authorization* distinct
 * (CTO correction on the approved proposal): a route being reachable
 * without a token ("public"), or reachable by any authenticated caller
 * regardless of role ("authenticated"), is not the same claim as a
 * route requiring a specific role set ("role-restricted"). A route is
 * never asserted to require @Roles() merely because it requires a
 * valid JWT.
 *
 * Also deliberately does NOT change AuthController's guard wiring.
 * login/refresh currently have no guard bound to them at all (neither
 * JwtAuthGuard nor anything else), so @Public() is not what's making
 * them public here — the absence of any guard is. This test records
 * that actual state as "public" and asserts it stays that way; fixing
 * @Public()'s inertness (proposal §3 item 1) is explicitly out of
 * scope for this work item.
 */

const HTTP_METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.ALL]: "ALL",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
};

type RouteKind =
  "public" | "authenticated" | "role-restricted" | "unrecognized";

interface DiscoveredRoute {
  key: string; // "METHOD full/path"
  controller: string;
  method: string;
  path: string;
  kind: RouteKind;
  roles: string[];
}

function trimSlashes(segment: string): string {
  return segment.replace(/^\/+|\/+$/g, "");
}

function joinPath(controllerPrefix: string, methodPath: string): string {
  const left = trimSlashes(controllerPrefix);
  const right = trimSlashes(methodPath);
  return [left, right].filter((s) => s.length > 0).join("/");
}

function classify(
  jwtGuarded: boolean,
  rolesGuarded: boolean,
  roles: string[] | undefined,
): RouteKind {
  if (!jwtGuarded && !rolesGuarded && roles === undefined) return "public";
  if (jwtGuarded && roles === undefined) return "authenticated";
  if (jwtGuarded && rolesGuarded && roles !== undefined && roles.length > 0)
    return "role-restricted";
  // Anything else (e.g. @Roles() present but RolesGuard not bound, so the
  // metadata would never actually be enforced; or @Roles() called with an
  // empty list) is a genuine anomaly worth failing loudly on, not a state
  // this matrix silently accepts as one of the three known-good shapes.
  return "unrecognized";
}

/** Walks a controller's own prototype methods and returns every route handler found. */
function discoverRoutes(
  controller: new (...args: never[]) => unknown,
): DiscoveredRoute[] {
  const prototype = (controller as { prototype: object }).prototype;
  const controllerPrefixRaw = Reflect.getMetadata(PATH_METADATA, controller) as
    string | undefined;
  const controllerPrefix = controllerPrefixRaw ?? "/";
  const classGuards: unknown[] =
    Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];

  const routes: DiscoveredRoute[] = [];
  for (const propertyName of Object.getOwnPropertyNames(prototype)) {
    if (propertyName === "constructor") continue;
    const handler = (prototype as Record<string, unknown>)[propertyName];
    if (typeof handler !== "function") continue;

    const methodEnum = Reflect.getMetadata(METHOD_METADATA, handler) as
      number | undefined;
    if (methodEnum === undefined) continue; // not a route handler

    const methodPath =
      (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ??
      "/";
    const methodGuards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    const effectiveGuards = [...classGuards, ...methodGuards];
    const jwtGuarded = effectiveGuards.includes(JwtAuthGuard);
    const rolesGuarded = effectiveGuards.includes(RolesGuard);
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as
      string[] | undefined;

    const method = HTTP_METHOD_NAMES[methodEnum] ?? String(methodEnum);
    const path = joinPath(controllerPrefix, methodPath);
    routes.push({
      key: `${method} ${path}`,
      controller: controller.name,
      method,
      path,
      kind: classify(jwtGuarded, rolesGuarded, roles),
      roles: roles ?? [],
    });
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Single source of truth. Every route AuthController exposes today
 * (re-verified live for this work item — matches
 * docs/hardening/milestone-3.2-route-role-matrix-proposal.md §2 exactly).
 */
const EXPECTED: DiscoveredRoute[] = [
  {
    key: "POST auth/login",
    controller: "AuthController",
    method: "POST",
    path: "auth/login",
    kind: "public",
    roles: [],
  },
  {
    key: "POST auth/refresh",
    controller: "AuthController",
    method: "POST",
    path: "auth/refresh",
    kind: "public",
    roles: [],
  },
  {
    key: "POST auth/logout",
    controller: "AuthController",
    method: "POST",
    path: "auth/logout",
    kind: "authenticated",
    roles: [],
  },
];

describe("Route → required-role matrix (identity)", () => {
  const actual = discoverRoutes(AuthController);
  const actualByKey = new Map(actual.map((r) => [r.key, r]));
  const expectedByKey = new Map(EXPECTED.map((r) => [r.key, r]));

  it("discovers exactly the expected number of routes on AuthController", () => {
    expect(actual).toHaveLength(EXPECTED.length);
  });

  it("has no route on AuthController missing from the expected matrix (completeness)", () => {
    const missing = actual
      .filter((r) => !expectedByKey.has(r.key))
      .map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("has no expected-matrix entry for a route that no longer exists on AuthController (staleness)", () => {
    const stale = EXPECTED.filter((r) => !actualByKey.has(r.key)).map(
      (r) => r.key,
    );
    expect(stale).toEqual([]);
  });

  it.each(EXPECTED)(
    "$key is $kind with roles [$roles]",
    ({ key, kind, roles }) => {
      const route = actualByKey.get(key);
      expect(route).toBeDefined();
      expect(route!.kind).toBe(kind);
      expect([...route!.roles].sort()).toEqual([...roles].sort());
    },
  );

  it("never classifies a route as 'unrecognized' (every route falls into public/authenticated/role-restricted)", () => {
    const unrecognized = actual.filter((r) => r.kind === "unrecognized");
    expect(unrecognized).toEqual([]);
  });
});
