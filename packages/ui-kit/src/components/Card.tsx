import * as React from "react";
import styles from "./Card.module.css";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  actions?: React.ReactNode;
}

/** Simple bordered content container with an optional title/actions header row. */
export function Card({
  title,
  actions,
  className,
  children,
  ...rest
}: CardProps): React.ReactElement {
  const classes = [styles.card, className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {title || actions ? (
        <div className={styles.header}>
          {title ? <h3 className={styles.title}>{title}</h3> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export default Card;
