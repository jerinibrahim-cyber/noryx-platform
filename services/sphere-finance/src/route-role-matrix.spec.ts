import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from "@nestjs/common/constants";
import { ROLES_KEY, JwtAuthGuard, RolesGuard } from "@noryx/auth-core";
import { AccountsController } from "./accounts/accounts.controller";
import { AccountingPeriodsController } from "./accounting-periods/accounting-periods.controller";
import { JournalEntriesController } from "./journal-entries/journal-entries.controller";
import { GeneralLedgerController } from "./general-ledger/general-ledger.controller";
import { SuppliersController } from "./accounts-payable/suppliers/suppliers.controller";
import { ApSettingsController } from "./accounts-payable/ap-settings/ap-settings.controller";
import { SupplierBillsController } from "./accounts-payable/supplier-bills/supplier-bills.controller";
import { SupplierPaymentsController } from "./accounts-payable/supplier-payments/supplier-payments.controller";
import { ApReportsController } from "./accounts-payable/ap-reports/ap-reports.controller";
import { CustomersController } from "./accounts-receivable/customers/customers.controller";
import { ArSettingsController } from "./accounts-receivable/ar-settings/ar-settings.controller";
import { CustomerInvoicesController } from "./accounts-receivable/customer-invoices/customer-invoices.controller";
import { CustomerReceiptsController } from "./accounts-receivable/customer-receipts/customer-receipts.controller";

/**
 * Milestone 3.2 — Route → Required-Role Matrix Hardening
 * (docs/hardening/milestone-3.2-route-role-matrix-proposal.md §4a).
 *
 * A single source of truth for every route across all Finance
 * controllers, proven exhaustively against live NestJS reflection
 * metadata rather than a hand-maintained list assumed correct — the
 * RBAC analogue of Milestone 3.1's RLS drift-guard test, which queried
 * the live Postgres catalog instead of trusting a remembered table
 * list. Extended for AP-1a (docs/finance-work-item-1-ap-foundation
 * -proposal.md §16) to also discover SuppliersController and
 * ApSettingsController, for AP-1b
 * (docs/finance-work-item-1b-supplier-bills-proposal.md §14/§16) to
 * also discover SupplierBillsController, for AP-1c
 * (docs/finance-work-item-1c-supplier-payments-proposal.md §10/§11) to
 * also discover SupplierPaymentsController, and for AP-1d
 * (docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §5) to also discover ApReportsController, and for AR-1c
 * (docs/finance-work-item-1c-customer-receipts-proposal.md §16/§18) to
 * also discover CustomerReceiptsController — this test is repo-wide,
 * not per-module, so a new controller must be added to both the import
 * list above and the `actual` array below, or its routes simply go
 * unverified.
 *
 * Every route here is authenticated (JwtAuthGuard) AND role-restricted
 * (RolesGuard + a non-empty @Roles() list) — this service has no public
 * or authenticated-only routes, unlike identity's AuthController (see
 * services/identity/src/route-role-matrix.spec.ts, which encodes that
 * distinction). A route whose @Roles() metadata is present but whose
 * RolesGuard isn't actually bound (so the metadata would never be
 * enforced) is deliberately classified as "unrecognized", not silently
 * accepted — see classify() below.
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
  return routes;
}

function role(
  method: string,
  path: string,
  controller: string,
  roles: string[],
): DiscoveredRoute {
  return {
    key: `${method} ${path}`,
    controller,
    method,
    path,
    kind: "role-restricted",
    roles,
  };
}

/**
 * Single source of truth. Every route across all nine Finance
 * controllers — the original four (re-verified live, matching
 * docs/hardening/milestone-3.2-route-role-matrix-proposal.md §2 exactly,
 * 17 routes) plus AP-1a's two controllers (7 routes, added per
 * docs/finance-work-item-1-ap-foundation-proposal.md §16) plus AP-1b's
 * SupplierBillsController (6 routes, added per
 * docs/finance-work-item-1b-supplier-bills-proposal.md §14/§16) plus
 * AP-1c's SupplierPaymentsController (6 routes, added per
 * docs/finance-work-item-1c-supplier-payments-proposal.md §10/§11) plus
 * AP-1d's ApReportsController (4 routes, added per
 * docs/finance-work-item-1d-supplier-balance-statement-ageing-proposal.md
 * §5) plus AR-1a's two controllers, CustomersController and
 * ArSettingsController (8 routes, added per
 * docs/finance-work-item-ar-1a-customer-master-ar-foundation-proposal.md
 * §5) plus AR-1b's CustomerInvoicesController (6 routes, added per
 * docs/finance-work-item-ar-1b-customer-invoicing-proposal.md §5) plus
 * AR-1c's CustomerReceiptsController (6 routes, added per
 * docs/finance-work-item-1c-customer-receipts-proposal.md §16/§18), 60
 * routes total across 13 controllers.
 */
const EXPECTED: DiscoveredRoute[] = [
  role("POST", "accounts", "AccountsController", ["finance.admin"]),
  role("GET", "accounts", "AccountsController", [
    "finance.viewer",
    "finance.admin",
  ]),
  role("GET", "accounts/:id", "AccountsController", [
    "finance.viewer",
    "finance.admin",
  ]),
  role("PATCH", "accounts/:id/archive", "AccountsController", [
    "finance.admin",
  ]),

  role("POST", "accounting-periods", "AccountingPeriodsController", [
    "finance.admin",
  ]),
  role("GET", "accounting-periods", "AccountingPeriodsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "accounting-periods/:id/close", "AccountingPeriodsController", [
    "finance.admin",
  ]),

  role("POST", "journal-entries", "JournalEntriesController", [
    "finance.poster",
  ]),
  role("GET", "journal-entries", "JournalEntriesController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "journal-entries/:id", "JournalEntriesController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "journal-entries/:id", "JournalEntriesController", [
    "finance.poster",
  ]),
  role("DELETE", "journal-entries/:id", "JournalEntriesController", [
    "finance.poster",
  ]),
  role("POST", "journal-entries/:id/post", "JournalEntriesController", [
    "finance.poster",
  ]),
  role("POST", "journal-entries/:id/reverse", "JournalEntriesController", [
    "finance.poster",
  ]),

  role("GET", "accounts/:id/ledger", "GeneralLedgerController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "accounts/:id/balance", "GeneralLedgerController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "trial-balance", "GeneralLedgerController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),

  // AP-1a — docs/finance-work-item-1-ap-foundation-proposal.md §16.
  role("POST", "suppliers", "SuppliersController", ["finance.admin"]),
  role("GET", "suppliers", "SuppliersController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "suppliers/:id", "SuppliersController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "suppliers/:id", "SuppliersController", ["finance.admin"]),
  role("PATCH", "suppliers/:id/deactivate", "SuppliersController", [
    "finance.admin",
  ]),
  role("PATCH", "suppliers/:id/reactivate", "SuppliersController", [
    "finance.admin",
  ]),

  role("POST", "ap/settings", "ApSettingsController", ["finance.admin"]),
  role("GET", "ap/settings", "ApSettingsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),

  // AP-1b — docs/finance-work-item-1b-supplier-bills-proposal.md §14/§16.
  // finance.poster writes, any finance.* role reads — matches
  // JournalEntriesController's split (bills are a transactional/posting
  // document), not AP-1a's admin-writes master-data split.
  role("POST", "bills", "SupplierBillsController", ["finance.poster"]),
  role("GET", "bills", "SupplierBillsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "bills/:id", "SupplierBillsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "bills/:id", "SupplierBillsController", ["finance.poster"]),
  role("DELETE", "bills/:id", "SupplierBillsController", ["finance.poster"]),
  role("POST", "bills/:id/post", "SupplierBillsController", ["finance.poster"]),

  // AP-1c — docs/finance-work-item-1c-supplier-payments-proposal.md
  // §10/§11. Same finance.poster-writes/any-role-reads split as
  // SupplierBillsController — payments are a transactional/posting
  // document, not master data.
  role("POST", "payments", "SupplierPaymentsController", ["finance.poster"]),
  role("GET", "payments", "SupplierPaymentsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "payments/:id", "SupplierPaymentsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "payments/:id", "SupplierPaymentsController", [
    "finance.poster",
  ]),
  role("DELETE", "payments/:id", "SupplierPaymentsController", [
    "finance.poster",
  ]),
  role("POST", "payments/:id/post", "SupplierPaymentsController", [
    "finance.poster",
  ]),

  // AP-1d — docs/finance-work-item-1d-supplier-balance-statement-ageing-
  // proposal.md §5. Pure reads, no write-side split to make — same
  // any-finance-role posture as GeneralLedgerController.
  role("GET", "suppliers/:id/balance", "ApReportsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "suppliers/:id/statement", "ApReportsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "ap/ageing", "ApReportsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "ap/reconciliation", "ApReportsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),

  // AR-1a — docs/finance-work-item-ar-1a-customer-master-ar-foundation-
  // proposal.md §5. Customers mirrors SuppliersController's exact
  // admin-writes/any-role-reads split — same master-data posture.
  role("POST", "customers", "CustomersController", ["finance.admin"]),
  role("GET", "customers", "CustomersController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "customers/:id", "CustomersController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "customers/:id", "CustomersController", ["finance.admin"]),
  role("PATCH", "customers/:id/deactivate", "CustomersController", [
    "finance.admin",
  ]),
  role("PATCH", "customers/:id/reactivate", "CustomersController", [
    "finance.admin",
  ]),

  role("POST", "ar/settings", "ArSettingsController", ["finance.admin"]),
  role("GET", "ar/settings", "ArSettingsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),

  // AR-1b — docs/finance-work-item-ar-1b-customer-invoicing-proposal.md
  // §5. Same finance.poster-writes/any-role-reads split as
  // SupplierBillsController — invoices are a transactional/posting
  // document, not master data.
  role("POST", "invoices", "CustomerInvoicesController", ["finance.poster"]),
  role("GET", "invoices", "CustomerInvoicesController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "invoices/:id", "CustomerInvoicesController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "invoices/:id", "CustomerInvoicesController", [
    "finance.poster",
  ]),
  role("DELETE", "invoices/:id", "CustomerInvoicesController", [
    "finance.poster",
  ]),
  role("POST", "invoices/:id/post", "CustomerInvoicesController", [
    "finance.poster",
  ]),

  // AR-1c — docs/finance-work-item-1c-customer-receipts-proposal.md
  // §16/§18. Same finance.poster-writes/any-role-reads split as
  // SupplierPaymentsController — receipts are a transactional/posting
  // document, not master data.
  role("POST", "receipts", "CustomerReceiptsController", ["finance.poster"]),
  role("GET", "receipts", "CustomerReceiptsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("GET", "receipts/:id", "CustomerReceiptsController", [
    "finance.viewer",
    "finance.poster",
    "finance.admin",
  ]),
  role("PATCH", "receipts/:id", "CustomerReceiptsController", [
    "finance.poster",
  ]),
  role("DELETE", "receipts/:id", "CustomerReceiptsController", [
    "finance.poster",
  ]),
  role("POST", "receipts/:id/post", "CustomerReceiptsController", [
    "finance.poster",
  ]),
];

describe("Route → required-role matrix (sphere-finance)", () => {
  const actual = [
    ...discoverRoutes(AccountsController),
    ...discoverRoutes(AccountingPeriodsController),
    ...discoverRoutes(JournalEntriesController),
    ...discoverRoutes(GeneralLedgerController),
    ...discoverRoutes(SuppliersController),
    ...discoverRoutes(ApSettingsController),
    ...discoverRoutes(SupplierBillsController),
    ...discoverRoutes(SupplierPaymentsController),
    ...discoverRoutes(ApReportsController),
    ...discoverRoutes(CustomersController),
    ...discoverRoutes(ArSettingsController),
    ...discoverRoutes(CustomerInvoicesController),
    ...discoverRoutes(CustomerReceiptsController),
  ];
  const actualByKey = new Map(actual.map((r) => [r.key, r]));
  const expectedByKey = new Map(EXPECTED.map((r) => [r.key, r]));

  it("discovers exactly the expected number of routes across all thirteen controllers", () => {
    expect(actual).toHaveLength(EXPECTED.length);
  });

  it("has no route in any controller missing from the expected matrix (completeness)", () => {
    const missing = actual
      .filter((r) => !expectedByKey.has(r.key))
      .map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("has no expected-matrix entry for a route that no longer exists in any controller (staleness)", () => {
    const stale = EXPECTED.filter((r) => !actualByKey.has(r.key)).map(
      (r) => r.key,
    );
    expect(stale).toEqual([]);
  });

  it.each(EXPECTED)(
    "$key ($controller) is role-restricted to exactly [$roles]",
    ({ key, controller, kind, roles }) => {
      const route = actualByKey.get(key);
      expect(route).toBeDefined();
      expect(route!.controller).toBe(controller);
      expect(route!.kind).toBe(kind);
      expect([...route!.roles].sort()).toEqual([...roles].sort());
    },
  );

  it("never classifies a route as 'unrecognized' (every route is properly authenticated + role-guarded)", () => {
    const unrecognized = actual.filter((r) => r.kind === "unrecognized");
    expect(unrecognized).toEqual([]);
  });
});
