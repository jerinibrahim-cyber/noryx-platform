/**
 * Single source of truth for the left-nav + routing structure of every
 * Sphere/Orbis module screen. Both the sidebar (via AppShell's navGroups)
 * and react-router's route table are generated from this array in
 * DashboardScreen — nothing else needs to change to add a module.
 *
 * To wire up a REAL page for one of these entries later:
 *   1. Add one screen component file, e.g. src/screens/finance/FinanceScreen.tsx
 *   2. Import it here and set that module's `path` to render it (or extend
 *      DashboardScreen's route table to point the module's route element
 *      at the new component instead of the shared ModulePlaceholder).
 * No other file needs to change — nav, routing, and layout are already in
 * place.
 */
export interface ModuleDefinition {
  /** Stable key, also used as the route path segment under /dashboard. */
  key: string;
  label: string;
}

export interface ModuleGroup {
  /** Product family — shown as the nav section heading. */
  group: "Sphere" | "Orbis";
  modules: ModuleDefinition[];
}

export const NORYX_MODULE_GROUPS: ModuleGroup[] = [
  {
    group: "Sphere",
    modules: [
      { key: "finance", label: "Finance" },
      { key: "procurement", label: "Procurement" },
      { key: "hrms", label: "HRMS" },
      { key: "crm", label: "CRM" },
    ],
  },
  {
    group: "Orbis",
    modules: [
      { key: "helpdesk-work-orders", label: "Helpdesk & Work Orders" },
      { key: "assets", label: "Assets" },
      { key: "ppm", label: "PPM" },
      { key: "sla-command-centre", label: "SLA / Command Centre" },
    ],
  },
];

/** Flat list of every module, convenient for building route tables. */
export const NORYX_MODULES: ModuleDefinition[] = NORYX_MODULE_GROUPS.flatMap(
  (g) => g.modules,
);
