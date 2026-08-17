import * as React from "react";
import styles from "./AppShell.module.css";

export interface NavItem {
  /** Unique key/route identifier, e.g. "/finance". */
  key: string;
  label: string;
  href?: string;
  active?: boolean;
  icon?: React.ReactNode;
  /** Rendered instead of a plain <a> when the app owns routing (e.g. react-router's <Link>). */
  renderLink?: (
    children: React.ReactNode,
    className: string,
  ) => React.ReactElement;
}

export interface NavGroup {
  /** Group heading, e.g. "Sphere" or "Orbis". */
  label: string;
  items: NavItem[];
}

export interface AppShellProps {
  /** Brand mark shown at the top of the sidebar (logo + product name). */
  brand: React.ReactNode;
  /** Navigation groups rendered in the sidebar — grouped by product family. */
  navGroups: NavGroup[];
  /** Current page title shown in the topbar. */
  pageTitle?: string;
  /** Extra content in the topbar, right side (before the user menu). */
  topbarActions?: React.ReactNode;
  /** User menu slot — avatar/name/dropdown, rendered top-right. */
  userMenu?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Sidebar + topbar layout shell every module screen renders inside.
 * Navigation is grouped (Sphere vs Orbis today; any future product family
 * is just another `NavGroup`), and each `NavItem` accepts a `renderLink`
 * so the shell stays router-agnostic (react-router's `Link`, Next's
 * `Link`, or a plain `<a>` all work).
 */
export function AppShell({
  brand,
  navGroups,
  pageTitle,
  topbarActions,
  userMenu,
  children,
}: AppShellProps): React.ReactElement {
  return (
    <div className={styles.shell}>
      <a href="#noryx-main-content" className={styles.skipLink}>
        Skip to main content
      </a>
      <aside className={styles.sidebar} aria-label="Primary">
        <div className={styles.brand}>{brand}</div>
        <nav className={styles.nav} aria-label="Main navigation">
          {navGroups.map((group) => (
            <div key={group.label} className={styles.navGroup}>
              <span className={styles.navGroupLabel}>{group.label}</span>
              <ul className={styles.navList}>
                {group.items.map((item) => {
                  const linkClassName = [
                    styles.navLink,
                    item.active ? styles.navLinkActive : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const content = (
                    <>
                      {item.icon}
                      {item.label}
                    </>
                  );
                  return (
                    <li key={item.key}>
                      {item.renderLink ? (
                        item.renderLink(content, linkClassName)
                      ) : (
                        <a
                          href={item.href ?? "#"}
                          className={linkClassName}
                          aria-current={item.active ? "page" : undefined}
                        >
                          {content}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <header className={styles.topbar}>
        <span className={styles.topbarTitle}>{pageTitle}</span>
        <div className={styles.userMenu}>
          {topbarActions}
          {userMenu}
        </div>
      </header>
      <main id="noryx-main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

export default AppShell;
