/**
 * Ambient module declaration so TypeScript accepts CSS Module imports
 * (e.g. `import styles from "./Button.module.css"`) in component files.
 * Bundlers (Vite, webpack, etc.) handle the actual CSS loading; this
 * declaration only satisfies the type checker.
 */
declare module "*.module.css" {
  const classes: { readonly [className: string]: string };
  export default classes;
}

declare module "*.css" {
  const content: string;
  export default content;
}
