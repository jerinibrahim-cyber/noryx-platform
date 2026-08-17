/**
 * Noryx design tokens — single source of truth for color, type, spacing,
 * radius, and shadow values shared by every Noryx surface (Sphere, Orbis,
 * shared-services screens) and, per Phase 1 mobile plans, by a future
 * React Native app.
 *
 * This file exports a PLAIN TypeScript object (`tokens`) with no DOM/CSS
 * dependency so it can be imported as-is from a React Native context
 * (e.g. mapped into a StyleSheet or a native theme provider) without
 * pulling in any web-only code. `tokens.css` is a parallel, hand-mirrored
 * export of the same values as CSS custom properties for web consumers
 * (see that file's header comment). If you change a value here, change
 * it in tokens.css too — keep the two in sync.
 */

export const color = {
  // Sphere brand
  sphere: {
    primary: "#1B2A63", // indigo
    secondary: "#534FA2", // violet
    accent: "#A8845C", // gold
    accentLight: "#D9BE94", // gold-light
    lavender: "#C7C7DC",
  },
  // Orbis brand
  orbis: {
    navy: "#00224C",
    teal: "#24709A",
  },
  // Neutrals
  neutral: {
    ink: "#1B2340", // primary text
    grey: "#595959", // muted text
    lightGrey: "#EFEEF7", // light background
    nearWhite: "#F7F7FA", // near-white background
    white: "#FFFFFF",
  },
  // Status
  status: {
    success: "#3F7F5C", // green
    warning: "#9C6B1F", // amber
    danger: "#9C3B3B", // red
  },
} as const;

/** Type scale — modular scale, rem-based (assumes 16px root). */
export const typeScale = {
  fontFamily: {
    base: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  },
  fontSize: {
    xs: "0.75rem", // 12px
    sm: "0.875rem", // 14px
    base: "1rem", // 16px
    lg: "1.125rem", // 18px
    xl: "1.25rem", // 20px
    "2xl": "1.5rem", // 24px
    "3xl": "1.875rem", // 30px
    "4xl": "2.25rem", // 36px
  },
  fontWeight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  lineHeight: {
    tight: "1.2",
    normal: "1.5",
    relaxed: "1.7",
  },
} as const;

/** Spacing scale — 4px base unit. */
export const spacing = {
  0: "0px",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
  20: "80px",
  24: "96px",
} as const;

/** Border radii. */
export const radii = {
  none: "0px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  full: "9999px",
} as const;

/** Elevation / shadow tokens. */
export const shadow = {
  none: "none",
  sm: "0 1px 2px rgba(27, 35, 64, 0.08)",
  md: "0 2px 8px rgba(27, 35, 64, 0.12)",
  lg: "0 8px 24px rgba(27, 35, 64, 0.16)",
  focus: "0 0 0 3px rgba(83, 79, 162, 0.4)", // violet focus ring
} as const;

/**
 * The single exported token object. Consumers should prefer importing
 * this object (`tokens.color.sphere.primary`, etc.) over the individual
 * named exports above when building a runtime theme (e.g. a React Native
 * `StyleSheet` or `ThemeProvider` context value).
 */
export const tokens = {
  color,
  typeScale,
  spacing,
  radii,
  shadow,
} as const;

export type NoryxTokens = typeof tokens;

/**
 * CSS custom property names used across the token set. Kept here (rather
 * than only in tokens.css) so `theme-provider.tsx` can reference the same
 * variable names when applying runtime tenant overrides, without risking
 * the two files drifting apart.
 */
export const cssVar = {
  colorPrimary: "--noryx-color-primary",
  colorSecondary: "--noryx-color-secondary",
  colorAccent: "--noryx-color-accent",
  colorAccentLight: "--noryx-color-accent-light",
  colorLavender: "--noryx-color-lavender",
  colorOrbisNavy: "--noryx-color-orbis-navy",
  colorOrbisTeal: "--noryx-color-orbis-teal",
  colorInk: "--noryx-color-ink",
  colorGrey: "--noryx-color-grey",
  colorLightGrey: "--noryx-color-light-grey",
  colorNearWhite: "--noryx-color-near-white",
  colorWhite: "--noryx-color-white",
  colorSuccess: "--noryx-color-success",
  colorWarning: "--noryx-color-warning",
  colorDanger: "--noryx-color-danger",
  logoUrl: "--noryx-logo-url",
} as const;

export default tokens;
