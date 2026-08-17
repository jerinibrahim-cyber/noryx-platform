import * as React from "react";
import { cssVar } from "./tokens";

/**
 * Per-tenant branding overrides. This shape intentionally mirrors what the
 * Tenant Provisioning Service will eventually store per tenant (see the
 * platform architecture doc — tenant admins configure brand colors and a
 * logo during onboarding). When that service is wired up, its API response
 * can be passed straight into `overrides` here with no translation layer:
 *
 *   const branding = await fetchTenantBranding(tenantId);
 *   <ThemeProvider overrides={branding}>...</ThemeProvider>
 *
 * Any field left undefined falls back to the default Noryx token value
 * declared in tokens.css's `:root` block.
 */
export interface ThemeOverrides {
  /** Overrides --noryx-color-primary (defaults to Sphere indigo #1B2A63). */
  primaryColor?: string;
  /** Overrides --noryx-color-secondary (defaults to Sphere violet #534FA2). */
  secondaryColor?: string;
  /** Overrides --noryx-color-accent (defaults to Sphere gold #A8845C). */
  accentColor?: string;
  /** Tenant logo, applied as --noryx-logo-url for components that render it. */
  logoUrl?: string;
}

export interface ThemeProviderProps {
  /**
   * Optional tenant branding overrides. When omitted, the subtree simply
   * inherits the default tokens declared in `:root` by tokens.css — no
   * inline style is applied at all.
   */
  overrides?: ThemeOverrides;
  children: React.ReactNode;
  /** Element type to render as the theming scope. Defaults to "div". */
  as?: keyof JSX.IntrinsicElements;
  className?: string;
}

/**
 * Applies tenant branding overrides as CSS custom properties scoped to
 * this subtree via an inline `style` attribute. Because CSS custom
 * properties cascade, any descendant component whose CSS Module reads
 * `var(--noryx-color-primary)` etc. (see tokens.css) automatically picks
 * up the override — no component-level prop plumbing needed.
 *
 * This is the runtime mechanism a tenant admin's branding settings
 * (persisted by the Tenant Provisioning Service) will use to reskin the
 * app per tenant: fetch the tenant's branding record on login/app-load
 * and pass it as `overrides`. Nothing else in the design system needs to
 * change to support new tenants — only the values flowing into this prop.
 */
export function ThemeProvider({
  overrides,
  children,
  as = "div",
  className,
}: ThemeProviderProps): React.ReactElement {
  const Tag = as as React.ElementType;

  const style = React.useMemo<React.CSSProperties>(() => {
    if (!overrides) return {};
    const vars: Record<string, string> = {};
    if (overrides.primaryColor)
      vars[cssVar.colorPrimary] = overrides.primaryColor;
    if (overrides.secondaryColor)
      vars[cssVar.colorSecondary] = overrides.secondaryColor;
    if (overrides.accentColor) vars[cssVar.colorAccent] = overrides.accentColor;
    if (overrides.logoUrl) vars[cssVar.logoUrl] = `url(${overrides.logoUrl})`;
    return vars as React.CSSProperties;
  }, [overrides]);

  return (
    <Tag className={className} style={style} data-noryx-theme-scope="">
      {children}
    </Tag>
  );
}

export default ThemeProvider;
