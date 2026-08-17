import type { ReactNode } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { AppShell, type NavGroup } from "@noryx/ui-kit";
import { NORYX_MODULE_GROUPS, NORYX_MODULES } from "../modules/module-registry";
import { ModulePlaceholder } from "../components/ModulePlaceholder";
import styles from "./DashboardScreen.module.css";

/**
 * Dashboard shell — renders AppShell with nav groups generated from
 * module-registry.ts, and a nested route table (also generated from the
 * registry) for each module's screen. Every module currently routes to
 * the shared ModulePlaceholder; swapping in a real screen is a one-file
 * change (see module-registry.ts's header comment).
 */
export function DashboardScreen() {
  const location = useLocation();

  const navGroups: NavGroup[] = NORYX_MODULE_GROUPS.map((group) => ({
    label: group.group,
    items: group.modules.map((moduleDef) => {
      const href = `/dashboard/${moduleDef.key}`;
      return {
        key: moduleDef.key,
        label: moduleDef.label,
        active: location.pathname === href,
        renderLink: (children: ReactNode, className: string) => (
          <Link
            to={href}
            className={className}
            aria-current={location.pathname === href ? "page" : undefined}
          >
            {children}
          </Link>
        ),
      };
    }),
  }));

  const activeModule = NORYX_MODULES.find(
    (m) => location.pathname === `/dashboard/${m.key}`,
  );

  return (
    <AppShell
      brand={<span>Noryx</span>}
      navGroups={navGroups}
      pageTitle={activeModule?.label ?? "Dashboard"}
      userMenu={<span className={styles.userMenu}>jerinibrahim@gmail.com</span>}
    >
      <Routes>
        <Route
          index
          element={<ModulePlaceholder label="Dashboard overview" />}
        />
        {NORYX_MODULES.map((moduleDef) => (
          <Route
            key={moduleDef.key}
            path={moduleDef.key}
            element={<ModulePlaceholder label={moduleDef.label} />}
          />
        ))}
      </Routes>
    </AppShell>
  );
}

export default DashboardScreen;
