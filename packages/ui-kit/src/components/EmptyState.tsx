import * as React from "react";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

/** Placeholder shown for empty lists/tables/search results. */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: EmptyStateProps): React.ReactElement {
  return (
    <div className={styles.container}>
      {icon ? (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action}
    </div>
  );
}

export default EmptyState;
