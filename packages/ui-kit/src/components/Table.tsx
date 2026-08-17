import * as React from "react";
import styles from "./Table.module.css";

export type SortDirection = "asc" | "desc";

export interface TableColumn<T> {
  key: string;
  header: string;
  /** When omitted, cell renders `String(row[key])`. */
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  /** Stable row identifier, used as React key. */
  getRowId: (row: T, index: number) => string | number;
  sortKey?: string;
  sortDirection?: SortDirection;
  onSortChange?: (key: string, direction: SortDirection) => void;
  emptyMessage?: string;
  caption?: string;
}

/**
 * Minimal data-table shell: sortable column headers, row rendering via a
 * `render` callback per column, and an empty state. Not a full datagrid
 * (no virtualization/pagination) — intended as the base every module's
 * list screens compose on top of.
 */
export function Table<T>({
  columns,
  rows,
  getRowId,
  sortKey,
  sortDirection = "asc",
  onSortChange,
  emptyMessage = "No records found.",
  caption,
}: TableProps<T>): React.ReactElement {
  function handleSort(column: TableColumn<T>) {
    if (!column.sortable || !onSortChange) return;
    const nextDirection: SortDirection =
      sortKey === column.key && sortDirection === "asc" ? "desc" : "asc";
    onSortChange(column.key, nextDirection);
  }

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        {caption ? (
          <caption className={styles.visuallyHidden}>{caption}</caption>
        ) : null}
        <thead>
          <tr>
            {columns.map((column) => {
              const isActive = sortKey === column.key;
              const ariaSort = column.sortable
                ? isActive
                  ? sortDirection === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
                : undefined;
              return (
                <th
                  key={column.key}
                  className={[
                    styles.th,
                    column.sortable ? styles.thSortable : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={column.width ? { width: column.width } : undefined}
                  scope="col"
                  aria-sort={ariaSort}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className={styles.thButton}
                      onClick={() => handleSort(column)}
                    >
                      {column.header}
                      <span
                        className={[
                          styles.sortIcon,
                          isActive ? styles.sortIconActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-hidden="true"
                      >
                        {isActive && sortDirection === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={styles.emptyCell} colSpan={columns.length}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={getRowId(row, index)}>
                {columns.map((column) => (
                  <td key={column.key} className={styles.td}>
                    {column.render
                      ? column.render(row)
                      : String(
                          (row as Record<string, unknown>)[column.key] ?? "",
                        )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
