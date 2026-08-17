# @noryx/ui-kit

The Noryx design system: shared design tokens, runtime tenant theming, and a
set of production-usable base components. Consumed today by `apps/web`
(Sphere + Orbis web shell); intended to be consumed unmodified — see
"React Native" below — by the future Phase 1 mobile app.

## Design tokens

Source of truth: `src/tokens.ts` (plain TS object, safe to import from
React Native) and `src/tokens.css` (CSS custom properties for web, mirrors
`tokens.ts` value-for-value — see the header comment in each file for the
sync contract between them).

### Color

| Token                            | Hex       | CSS variable                 |
| -------------------------------- | --------- | ---------------------------- |
| Sphere primary (indigo)          | `#1B2A63` | `--noryx-color-primary`      |
| Sphere secondary (violet)        | `#534FA2` | `--noryx-color-secondary`    |
| Sphere accent (gold)             | `#A8845C` | `--noryx-color-accent`       |
| Sphere accent-light (gold-light) | `#D9BE94` | `--noryx-color-accent-light` |
| Sphere lavender                  | `#C7C7DC` | `--noryx-color-lavender`     |
| Orbis navy                       | `#00224C` | `--noryx-color-orbis-navy`   |
| Orbis teal                       | `#24709A` | `--noryx-color-orbis-teal`   |
| Ink (text)                       | `#1B2340` | `--noryx-color-ink`          |
| Grey (muted text)                | `#595959` | `--noryx-color-grey`         |
| Light-grey background            | `#EFEEF7` | `--noryx-color-light-grey`   |
| Near-white background            | `#F7F7FA` | `--noryx-color-near-white`   |
| Success (green)                  | `#3F7F5C` | `--noryx-color-success`      |
| Warning (amber)                  | `#9C6B1F` | `--noryx-color-warning`      |
| Danger (red)                     | `#9C3B3B` | `--noryx-color-danger`       |

### Type scale

`fontSize`: `xs` 12px, `sm` 14px, `base` 16px, `lg` 18px, `xl` 20px, `2xl`
24px, `3xl` 30px, `4xl` 36px. `fontWeight`: regular 400, medium 500,
semibold 600, bold 700. `lineHeight`: tight 1.2, normal 1.5, relaxed 1.7.

### Spacing (4px base)

`0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96` px, keyed `0`–`24`.

### Radii

`none` 0, `sm` 4px, `md` 8px, `lg` 12px, `xl` 16px, `full` 9999px.

### Shadows

`none`, `sm`, `md`, `lg` (elevation shadows tinted with ink), and `focus`
(the violet keyboard-focus ring used by every interactive component).

## Runtime tenant theming

`ThemeProvider` (`src/theme-provider.tsx`) accepts an optional `overrides`
prop — `{ primaryColor?, secondaryColor?, accentColor?, logoUrl? }` — and
applies each provided value as an inline CSS custom property
(`--noryx-color-primary`, etc.) on the wrapper element it renders. Because
custom properties cascade, every descendant component's CSS Module (which
reads these same variable names via `var(...)`, never a hardcoded hex)
picks up the override automatically — no per-component prop plumbing.

**This is the mechanism a tenant admin's branding settings will use.** The
platform's Tenant Provisioning Service is the system of record for
per-tenant branding (primary/secondary/accent color, logo). When that
service is wired into the web app, the flow is:

```tsx
const branding = await fetchTenantBranding(tenantId); // Tenant Provisioning Service
<ThemeProvider overrides={branding}>
  <App />
</ThemeProvider>;
```

No design-system code changes are required to onboard a new tenant's
branding — only the values flowing into `overrides` change, at runtime,
per request/session. Any field left `undefined` simply falls back to the
default token declared in `tokens.css`'s `:root` block, so partial
overrides (e.g. only a custom primary color, default everything else) work
out of the box.

## React Native readiness

`src/tokens.ts` deliberately has zero DOM/CSS dependency — it's a plain,
tree-shakeable TS object (`tokens.color.sphere.primary`, etc.). The Phase 1
mobile app is expected to import this same file (or the published
`@noryx/ui-kit` package) directly into a React Native `StyleSheet`/theme
context without modification; only the web-only pieces (`tokens.css`, CSS
Modules, `AppShell`'s DOM layout) are web-specific and would get native
counterparts later. Keeping color/type/spacing/radius/shadow values in one
untyped-CSS TS source is what makes that reuse possible.

## Components

`src/components/`: `Button`, `Input`, `Card`, `Badge`, `Table`, `Modal`,
`AppShell`, `Spinner`, `EmptyState`. Each is a `.tsx` + co-located
`.module.css` pair; CSS Modules reference the `--noryx-*` custom properties
from `tokens.css` exclusively (no hardcoded hex values in component CSS),
which is what makes `ThemeProvider` overrides work.
