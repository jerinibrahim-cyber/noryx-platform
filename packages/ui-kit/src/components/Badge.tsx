import * as React from "react";
import styles from "./Badge.module.css";

export type BadgeStatus = "success" | "warning" | "danger" | "neutral";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
}

/**
 * Status pill — e.g. subscription status (active/past-due/cancelled) or
 * Orbis work-order status (open/in-progress/overdue).
 */
export function Badge({
  status = "neutral",
  className,
  children,
  ...rest
}: BadgeProps): React.ReactElement {
  const classes = [styles.badge, styles[status], className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} {...rest}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}

export default Badge;
