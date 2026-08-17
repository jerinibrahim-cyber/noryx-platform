import * as React from "react";
import styles from "./Spinner.module.css";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Accessible label announced to screen readers (default: "Loading"). */
  label?: string;
  className?: string;
}

/** Indeterminate loading indicator. */
export function Spinner({
  size = "md",
  label = "Loading",
  className,
}: SpinnerProps): React.ReactElement {
  return (
    <span
      className={[styles.spinner, styles[size], className]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-label={label}
    />
  );
}

export default Spinner;
